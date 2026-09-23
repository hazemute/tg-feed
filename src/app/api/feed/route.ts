import { NextResponse, after } from 'next/server'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Channel, Post } from '@prisma/client'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { diversify, personalScoreParts, shuffleNoise, viewedShuffleNoise, FOREIGN_LANG_MULTIPLIER, UNDETECTED_FROM_FOREIGN_CHANNEL_MULTIPLIER, isForeignForRanking } from '@/lib/rank'
import { toPostDTO } from '@/lib/dto'
import { buildFeedScope, loadPersonalSignals, computeRankedIndex, FEED_INDEX_KEY_V } from '@/lib/feed'
import type { RankedIndex, PersonalSignals } from '@/lib/feed'
import { detectLang, langPasses } from '@/lib/lang'
import { guardAuth } from '@/lib/guard'
import { cacheAside, cacheGet, cacheSet, famKey, shortHash } from '@/lib/redis'
import { getCachedPage, putCachedPage } from '@/lib/page-cache'
import { getSponsorChannelIds, getPromotedCandidates, getSponsorCandidates } from '@/lib/feed-extras'
import { feedSessionKey, getOrBuildFeedSnapshot } from '@/lib/feed-session'
import type { FeedSnapshot } from '@/lib/feed-session'
import { IS_SQLITE } from '@/lib/server'
import type { PostDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'
/** v6.0.0: фоновый тик парсера (after) может длиться до ~150с — функция должна
 *  пережить self-fetch до /api/parse/tick (у самого тика внутренние бюджеты). */
export const maxDuration = 150

/* ---------- v6.0.0: ТРАФИК-ДИСПЕТЧЕР ПАРСЕРА (грубо фикс ленты) ----------
 * КОРЕНЬ проблемы «в ленте одни ботовые каналы»: парсер t.me/s (запаршенные
 * с интернета каналы) в проде дёргался кроной Vercel РАЗ в СУТКИ (02:00),
 * пока ботовые каналы инжестились вебхуком в реальном времени. Запаршенный
 * контент старел — свежесть (полураспад 36ч) топила его под свежими ботовыми.
 * Внешний постоянный крон на Vercel Hobby недоступен → тик запускает
 * САМ ТРАФИК ЛЕНТЫ: любой запрос /api/feed (даже неавторизованный) раз в
 * ≥15 минут долбит /api/parse/tick в фоне (after) — ответа юзер не ждёт.
 * Тик адаптивный (партия ~6+2 канала, бюджеты внутри), идемпотентен,
 * локально в dev роль диспетчера продолжает играть mini-services/feed-cron.
 */
const PARSE_TICK_THROTTLE_MS = 15 * 60_000
let memTickDispatchedAt = 0 // in-memory страховка на случай недоступности Redis

function dispatchParseTick(request: Request): void {
  after(async () => {
    try {
      const secret = process.env.CRON_SECRET?.trim() ?? ''
      const prod = process.env.NODE_ENV === 'production' && !IS_SQLITE
      if (prod && !secret) return // прод без секрета: тик не авторизуется — не дёргаем
      const now = Date.now()
      if (now - memTickDispatchedAt < PARSE_TICK_THROTTLE_MS) return
      const marker = await cacheGet<number>('parse:tick:dispatched').catch(() => null)
      if (marker && now - marker < PARSE_TICK_THROTTLE_MS) return
      memTickDispatchedAt = now
      await cacheSet('parse:tick:dispatched', now, PARSE_TICK_THROTTLE_MS / 1000).catch(() => {})
      const origin = new URL(request.url).origin
      const res = await fetch(`${origin}/api/parse/tick`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        },
        body: '{}',
        // у тика внутренние бюджеты (35-110с); 150с — страховка сверху
        signal: AbortSignal.timeout(150_000),
      })
      const data = (await res.json().catch(() => ({}))) as { added?: number; batch?: number }
      if (typeof data.added === 'number' && data.added > 0) {
        console.log(`[feed] parse-tick (traffic): batch=${data.batch ?? '?'} added=${data.added}`)
      }
    } catch (e) {
      console.error(
        '[feed] parse-tick (traffic) failed',
        e instanceof Error ? e.message.slice(0, 160) : e,
      )
    }
  })
}

/**
 * Спонсорские/промо-экстры страницы 0 (кампании, промо-посты, кандидаты) —
 * ГЛОБАЛЬНЫЕ выборки, вынесены в L0-кэш src/lib/feed-extras.ts (TTL 20с):
 * раньше каждый запрос первой страницы делал 2-3 дополнительных SQL-запроса.
 */


/** Строка сырого SQL страницы ленты (одна JOIN-выборка вместо 4 последовательных) */
type PageRow = {
  id: string
  channelId: string
  text: string
  mediaUrl: string | null
  mediaType: string
  mediaMeta: string | null
  gallery: string | null
  link: string | null
  viewsCount: number
  viewsTg: number | null
  reactionsTg: number
  likesCount: number
  commentsCount: number
  memberOnly: boolean
  publishedAt: Date
  c_id: string
  c_title: string
  c_username: string
  c_description: string | null
  c_avatarColor: string
  c_photoFileId: string | null
  c_avatarUrl: string | null
  c_membersCount: number | null
  c_subscribersCount: number
  c_isPremium: boolean
  c_verified: boolean
  c_verifiedUntil: Date | null
  c_boostUntil: Date | null
  c_membershipPriceKop: number | null
  c_status: string
  c_teaserMode: string
  c_teaserLimit: number
  // v5.70-promo: только колонка гибкого тизера — рекомендательная логика не тронута
  c_teaserApplyTo: string
  c_ctaLabel: string | null
  c_ctaUrl: string | null
  c_ownerTier: string | null
  c_ownerTierUntil: Date | null
  cat_slug: string | null
  cat_title: string | null
  bookmarksCount: number | bigint
  liked: boolean
  bookmarked: boolean
}

/** Форма Post & {channel}, ожидаемая toPostDTO */
type PostWithChannel = Post & {
  channel: Channel & { category?: { slug: string; title: string } | null }
}

/** Пересборка строки SQL в форму, которую ожидает toPostDTO.
 *  SQL выбирает ровно те поля, которые читает toPostDTO/toChannelDTO,
 *  поэтому сужение типов безопасно. */
function postFromRow(r: PageRow): PostWithChannel {
  return {
    id: r.id,
    channelId: r.channelId,
    text: r.text,
    mediaUrl: r.mediaUrl,
    mediaType: r.mediaType,
    mediaMeta: r.mediaMeta,
    gallery: r.gallery,
    link: r.link,
    viewsCount: r.viewsCount,
    viewsTg: r.viewsTg,
    reactionsTg: r.reactionsTg,
    likesCount: r.likesCount,
    commentsCount: r.commentsCount,
    memberOnly: r.memberOnly,
    publishedAt: r.publishedAt,
    channel: {
      id: r.c_id,
      title: r.c_title,
      username: r.c_username,
      description: r.c_description,
      avatarColor: r.c_avatarColor,
      photoFileId: r.c_photoFileId,
      avatarUrl: r.c_avatarUrl,
      membersCount: r.c_membersCount,
      subscribersCount: r.c_subscribersCount,
      isPremium: r.c_isPremium,
      verified: r.c_verified,
      verifiedUntil: r.c_verifiedUntil,
      boostUntil: r.c_boostUntil,
      membershipPriceKop: r.c_membershipPriceKop,
      status: r.c_status,
      teaserMode: r.c_teaserMode,
      teaserLimit: r.c_teaserLimit,
      teaserApplyTo: r.c_teaserApplyTo,
      ctaLabel: r.c_ctaLabel,
      ctaUrl: r.c_ctaUrl,
      claimedBy: r.c_ownerTier ? { tier: r.c_ownerTier, tierUntil: r.c_ownerTierUntil } : null,
      category: r.cat_slug ? { slug: r.cat_slug, title: r.cat_title } : null,
    },
  } as unknown as PostWithChannel
}

/*
 * Страница ленты. v5.52 — ДВУХСЛОЙНАЯ выборка (главный ускоритель при тысячах
 * юзеров): ТЯЖЁЛАЯ часть строки (пост + канал + категория + счётчик закладок)
 * ОДИНАКОВА для всех — кэшируется в L1 процесса по postId (45с, кап 1500);
 * личные флаги (liked/bookmarked) добираются лёгким батчем из 2 запросов по
 * индексам только для id текущей страницы. Первый юзер греет кэш — остальные
 * получают страницу ИЗ ПАМЯТИ с одним микро-батчем флагов (было: полная
 * JOIN-выборка + коррелированный COUNT(*) на КАЖДОГО юзера на КАЖДУЮ страницу).
 */

// --- L1 общих строк страницы (без личных флагов) ---
type BaseRow = Omit<PageRow, 'liked' | 'bookmarked'>
const baseRowCache = new Map<string, { row: BaseRow; exp: number }>()
const BASE_ROW_TTL_MS = 45_000
const BASE_ROW_MAX = 1_500

function baseRowGet(id: string): BaseRow | null {
  const hit = baseRowCache.get(id)
  if (!hit) return null
  if (hit.exp <= Date.now()) {
    baseRowCache.delete(id)
    return null
  }
  return hit.row
}

function baseRowPut(rows: BaseRow[]): void {
  const now = Date.now()
  for (const r of rows) {
    if (baseRowCache.size >= BASE_ROW_MAX) {
      for (const [k, e] of baseRowCache) if (e.exp <= now) baseRowCache.delete(k)
      if (baseRowCache.size >= BASE_ROW_MAX) {
        const first = baseRowCache.keys().next().value
        if (first !== undefined) baseRowCache.delete(first)
      }
    }
    baseRowCache.set(r.id, { row: r, exp: now + BASE_ROW_TTL_MS })
  }
}

/** Общая (безличная) часть строки: Postgres — SQL без JOIN'ов на юзера */
async function fetchBaseRowsPostgres(ids: string[]): Promise<BaseRow[]> {
  return db.$queryRaw<BaseRow[]>`
            SELECT p."id", p."channelId", p."text", p."mediaUrl", p."mediaType", p."mediaMeta",
                   p."gallery", p."link", p."viewsCount", p."viewsTg", p."reactionsTg",
                   p."likesCount", p."commentsCount", p."memberOnly", p."publishedAt",
                   c."id"           AS "c_id",   c."title"       AS "c_title",
                   c."username"     AS "c_username", c."description" AS "c_description",
                   c."avatarColor"  AS "c_avatarColor", c."photoFileId" AS "c_photoFileId",
                   c."avatarUrl"    AS "c_avatarUrl",
                   c."membersCount" AS "c_membersCount", c."subscribersCount" AS "c_subscribersCount",
                   c."isPremium"    AS "c_isPremium", c."verified"    AS "c_verified",
                   c."verifiedUntil" AS "c_verifiedUntil", c."boostUntil" AS "c_boostUntil",
                   c."membershipPriceKop" AS "c_membershipPriceKop",
                   c."status"     AS "c_status",
                   c."teaserMode"   AS "c_teaserMode", c."teaserLimit" AS "c_teaserLimit",
                   c."teaserApplyTo" AS "c_teaserApplyTo",
                   c."ctaLabel"     AS "c_ctaLabel", c."ctaUrl"    AS "c_ctaUrl",
                   owner."tier"     AS "c_ownerTier", owner."tierUntil" AS "c_ownerTierUntil",
                   cat."slug"       AS "cat_slug", cat."title"  AS "cat_title",
                   (SELECT COUNT(*) FROM "Bookmark" b WHERE b."postId" = p."id") AS "bookmarksCount",
                   false AS "liked",
                   false AS "bookmarked"
            FROM "Post" p
            JOIN "Channel" c  ON c."id" = p."channelId"
            LEFT JOIN "Category" cat ON cat."id" = c."categoryId"
            LEFT JOIN "User" owner ON owner."id" = c."claimedById"
            WHERE p."id" = ANY(${ids}::text[])`
}

/** Общая часть строки: SQLite — Prisma-выборка (точный select, v5.48) */
async function fetchBaseRowsSqlite(ids: string[]): Promise<BaseRow[]> {
  const [posts, bookmarkCounts] = await Promise.all([
    db.post.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        channelId: true,
        text: true,
        mediaUrl: true,
        mediaType: true,
        mediaMeta: true,
        gallery: true,
        link: true,
        viewsCount: true,
        viewsTg: true,
        reactionsTg: true,
        likesCount: true,
        commentsCount: true,
        memberOnly: true,
        publishedAt: true,
        channel: {
          select: {
            id: true,
            title: true,
            username: true,
            description: true,
            avatarColor: true,
            photoFileId: true,
            avatarUrl: true,
            membersCount: true,
            subscribersCount: true,
            isPremium: true,
            verified: true,
            verifiedUntil: true,
            boostUntil: true,
            membershipPriceKop: true,
            status: true,
            teaserMode: true,
            teaserLimit: true,
            teaserApplyTo: true,
            ctaLabel: true,
            ctaUrl: true,
            claimedBy: { select: { tier: true, tierUntil: true } },
            category: { select: { slug: true, title: true } },
          },
        },
      },
    }),
    db.bookmark.groupBy({ by: ['postId'], where: { postId: { in: ids } }, _count: { _all: true } }),
  ])
  const bmCount = new Map(bookmarkCounts.map((c) => [c.postId, c._count._all]))
  return posts.map((p) => {
    const c = p.channel
    return {
      id: p.id,
      channelId: p.channelId,
      text: p.text,
      mediaUrl: p.mediaUrl,
      mediaType: p.mediaType,
      mediaMeta: p.mediaMeta,
      gallery: p.gallery,
      link: p.link,
      viewsCount: p.viewsCount,
      viewsTg: p.viewsTg,
      reactionsTg: p.reactionsTg,
      likesCount: p.likesCount,
      commentsCount: p.commentsCount,
      memberOnly: p.memberOnly,
      publishedAt: p.publishedAt,
      c_id: c.id,
      c_title: c.title,
      c_username: c.username,
      c_description: c.description,
      c_avatarColor: c.avatarColor,
      c_photoFileId: c.photoFileId,
      c_avatarUrl: c.avatarUrl,
      c_membersCount: c.membersCount,
      c_subscribersCount: c.subscribersCount,
      c_isPremium: c.isPremium,
      c_verified: c.verified,
      c_verifiedUntil: c.verifiedUntil,
      c_boostUntil: c.boostUntil,
      c_membershipPriceKop: c.membershipPriceKop,
      c_status: c.status,
      c_teaserMode: c.teaserMode,
      c_teaserLimit: c.teaserLimit,
      c_teaserApplyTo: c.teaserApplyTo,
      c_ctaLabel: c.ctaLabel,
      c_ctaUrl: c.ctaUrl,
      c_ownerTier: c.claimedBy?.tier ?? null,
      c_ownerTierUntil: c.claimedBy?.tierUntil ?? null,
      cat_slug: c.category?.slug ?? null,
      cat_title: c.category?.title ?? null,
      bookmarksCount: bmCount.get(p.id) ?? 0,
      liked: false,
      bookmarked: false,
    } as unknown as BaseRow
  })
}

/** Личные флаги страницы одним лёгким батчем (2 запроса по индексам, параллельно) */
async function fetchUserFlags(
  ids: string[],
  userId: string,
): Promise<{ liked: Set<string>; bookmarked: Set<string> }> {
  if (ids.length === 0) return { liked: new Set(), bookmarked: new Set() }
  const [likes, bookmarks] = await Promise.all([
    db.like.findMany({ where: { userId, postId: { in: ids } }, select: { postId: true } }),
    db.bookmark.findMany({ where: { userId, postId: { in: ids } }, select: { postId: true } }),
  ])
  return { liked: new Set(likes.map((l) => l.postId)), bookmarked: new Set(bookmarks.map((b) => b.postId)) }
}

async function fetchPageRows(ids: string[], userId: string): Promise<PageRow[]> {
  if (ids.length === 0) return []

  // Слой 1: общие строки из L1 (попадание — ноль SQL)
  const base: BaseRow[] = []
  const missing: string[] = []
  for (const id of ids) {
    const hit = baseRowGet(id)
    if (hit) base.push(hit)
    else missing.push(id)
  }
  // Слой 2: недостающие одним запросом (Postgres raw / SQLite Prisma)
  if (missing.length > 0) {
    /*
     * Task 8-b (пик 70к) — ДЕГРАДАЦИЯ вместо 500: если БД подтормаживает
     * (пул вымотан бёрстом, Supabase лёг), отдаём страницу из того, что есть
     * в L1 (частичная, без вымерших строк) с нейтральными флагами, а не
     * «feed failed». Пользователь видит ленту; L0 page-cache дальше отдаёт её
     * 90с без БД; флаги лайков/закладок догорят следующим запросом.
     */
    /* v6.1.3: один мгновенный ретрай — транзиентный сбой пула (P2024/сетевой
     * рывок) лечится за миллисекунды, а раньше первая попытка сразу
     * деградировала в «пустую страницу» и кэшировала её. */
    const fetchMissing = () =>
      IS_SQLITE ? fetchBaseRowsSqlite(missing) : fetchBaseRowsPostgres(missing)
    let fetched: BaseRow[] | null = null
    try {
      fetched = await fetchMissing()
    } catch (e) {
      console.error(`[feed] base-rows first attempt failed (missing=${missing.length})`, e)
      try {
        fetched = await fetchMissing()
      } catch (e2) {
        console.error(`[feed] base-rows retry failed too (missing=${missing.length})`, e2)
        /* v6.1.3: если L1 тоже пуст — наверх уйдёт ЧЕСТНАЯ ошибка (503),
         * а не ложная «пустая страница» (см. проверку в GET-хендлере). */
      }
    }
    if (fetched && fetched.length > 0) {
      baseRowPut(fetched)
      base.push(...fetched)
    }
  }
  const byId = new Map(base.map((r) => [r.id, r]))

  // Личные флаги — один лёгкий батч по id страницы; при сбое — нейтральные
  let flags = { liked: new Set<string>(), bookmarked: new Set<string>() }
  try {
    flags = await fetchUserFlags(ids, userId)
  } catch (e) {
    console.error('[feed] user flags degraded to neutral', e)
  }

  return ids
    .map((id) => byId.get(id))
    .filter((r): r is BaseRow => Boolean(r))
    .map((r) => ({ ...r, liked: flags.liked.has(r.id), bookmarked: flags.bookmarked.has(r.id) }))
}

// Валидация query-параметров. userId из query игнорируется —
// пользователь берётся ТОЛЬКО из Bearer-сессии (защита от подмены личности).
const querySchema = z.object({
  category: z.string().max(32).regex(/^[a-z0-9_-]+$/).catch('all'),
  page: z.coerce.number().int().min(0).catch(0),
  limit: z.coerce.number().int().min(1).max(20).catch(6),
  /** Сид перемешивания: клиент меняет его при каждом обновлении ленты —
   *  при повторном открытии лента показывается в ДРУГОМ порядке.
   *  Внутри сессии скролла сид НЕ меняется — пагинация идёт по одному
   *  замороженному порядку (снапшот, см. lib/feed-session.ts). */
  sh: z.string().max(24).optional(),
  /** Фильтр языка (v5.25): any — всё, ru — русский сегмент, foreign — прочие языки.
   *  Посты без букв (мемы-картинки) проходят в любом режиме (см. src/lib/lang.ts). */
  lang: z.enum(['any', 'ru', 'foreign']).catch('any'),
})

/**
 * GET /api/feed?category=all|slug|discover&page=0&limit=6
 *
 * РЕКОМЕНДАЦИИ v6 (Task 5-c — полная переработка):
 *
 *  1) Глобальный вес поста (качество на лог-шкале: лайки/комментарии/закладки/
 *     реакции/просмотры + экспоненциальная свежесть, полураспад 36ч) —
 *     кэшируется в Redis/памяти по скоупу (computeRankedIndex);
 *  2) Персональный слой на каждом запросе: аффинити к каналам/категориям
 *     (просмотры/лайки/закладки/источники), буст подписок, штрафы за
 *     просмотренное/«не интересно»/скрытые тематики, ЧАСОВОЙ сид перемешивания
 *     с userId внутри (сигнатуры разных пользователей различаются);
 *  3) Языковой приоритет: нерусский пост ×0.35 к положительной части скора
 *     (мем без букв из нерусского канала — ×0.6), кроме каналов, с которыми
 *     юзер взаимодействовал (лайк/подписка/источник);
 *  4) Исключения: мьютнутые каналы (целиком), скрытые посты («Не интересно»),
 *     посты с жалобой самого юзера, посты с 3+ чужими жалобами (в индексе);
 *  5) Порядок сессии ЗАМОРАЖИВАЕТСЯ в снапшот (lib/feed-session.ts): пагинация
 *     — честные срезы одного списка, дубли между страницами невозможны,
 *     порядок стабилен, «Не интересно» в середине сессии применяется фильтром
 *     на выдаче без перемешивания;
 *  6) Разнообразие: round-robin по каналам (cooldown) + кап 5 постов/канал
 *     в индексе → ≤2 постов одного канала на страницу.
 *
 * Требуется сессия (Bearer); лимит 120 запросов в минуту на пользователя.
 */
export async function GET(request: Request) {
  // v6.0.0: ДО guardAuth — тик запускает любой запрос ленты (свежесть
  // запаршенного контента важнее лишнего тика на спам-запросах, а троттл 15 мин
  // делает цену вопроса нулевой).
  dispatchParseTick(request)

  const g = guardAuth(request, { limit: 120, windowMs: 60_000, bucket: 'feed' })
  if (!g.ok) return g.res
  const userId = g.uid

  /**
   * ETag/304 (v5.35): поллинг ленты (раз в 45с) и возврат на вкладку не должны
   * снова качать тот же JSON — активный пользователь генерировал десятки МБ
   * egress в сутки. Если If-None-Match совпал — пустой 304 вместо тела.
   */
  const jsonWithEtag = (payload: unknown): NextResponse => {
    const etag = `W/"f-${createHash('sha1').update(JSON.stringify(payload)).digest('base64url').slice(0, 24)}"`
    const inm = request.headers.get('if-none-match')
    if (inm && inm.split(',').map((s) => s.trim()).includes(etag)) {
      return new NextResponse(null, { status: 304, headers: { ETag: etag } })
    }
    const res = NextResponse.json(payload)
    res.headers.set('ETag', etag)
    return res
  }

  const perf = process.env.FEED_PERF === '1'
  const t0 = Date.now()
  const mark = (label: string) => {
    if (perf) console.log(`[feed-perf] ${label}: ${Date.now() - t0}ms`)
  }

  try {
    const { searchParams } = new URL(request.url)
    const parsed = querySchema.safeParse(Object.fromEntries(searchParams))
    if (!parsed.success) return err('invalid query')
    const { category, page, limit, lang } = parsed.data

    // Мгновенный ответ для недавно отданной страницы (смена вкладок/возврат в ленту):
    // 90с L0-кэш + свежие персональные флаги поверх (см. src/lib/page-cache.ts).
    const seedForCache = typeof parsed.data.sh === 'string' ? parsed.data.sh : ''
    const cached = getCachedPage(userId, category, page, limit, seedForCache, lang)
    if (cached) return jsonWithEtag({ ...cached, page })

    // Скоуп нужен первым (из него ключ индекса); сигналы и индекс — параллельно:
    // тяжёлая транзакция сигналов прячется под выборкой индекса (v5.27 —
    // раньше сигналы ждали индекс последовательно, каждая цепочка RTT до
    // дальнего Supabase — это и была основная часть «всё грузится медленно»)
    const scope = await buildFeedScope(userId, category)
    if (!scope) return err('user not found', 404)
    mark('scope')

    /* ---------- Глобальный индекс: Redis (300с + прогрев) → Postgres ----------
        Дальний регион (Supabase eu-central-1): холодный пересчёт индекса стоит
        ~2с и грузит пул; TTL 300с + инвалидация famKey при новых постах
        парсером + ПРОГРЕВ ключей парсером/warm'ом (feed-warm.ts) — юзеры
        почти никогда не платят за пересчёт; кросс-инстансный лок в cacheAside
        не даёт бёрсту запросов умножить холодную пересборку.
        v5.48: discover кэшируется ТОЖЕ — сигнатура скоупа строится из
        фактического where (v7), одинаковый where → одинаковый индекс. */
    const indexKey = scope.sig
      ? await famKey('feed', `${category}:${FEED_INDEX_KEY_V}:${shortHash(scope.sig)}`)
      : null // сигнатуры нет только при ошибке скоупа (не бывает на этом пути)

    const loadIndex = () => computeRankedIndex(scope.where)

    const indexPromise: Promise<RankedIndex> = indexKey
      ? cacheAside({ key: indexKey, ttlSec: 300, memoryTtlMs: 15_000, fetcher: loadIndex })
      : loadIndex()

    const [index, signals] = await Promise.all([indexPromise, loadPersonalSignals(userId)])
    mark('index+signals')

    /* ---------- Сид сессии: клиентский `sh` или часовой дефолт ----------
        РОТАЦИЯ (жалоба владельца «постоянно одно и то же»): без сида сервер
        подставляет userId:час — порядок вращается каждый час, у каждого
        пользователя свой. userId внутри сида = сигнатуры двух пользователей
        с одинаковой историей всё равно различаются (Task 5-c). */
    const hourBucket = Math.floor(Date.now() / 3_600_000)
    const effSeed =
      typeof parsed.data.sh === 'string' && parsed.data.sh.length > 0
        ? parsed.data.sh
        : `${userId}:${hourBucket}`

    /* ---------- Персональный порядок сессии: снапшот (single-flight) ----------
        Строится один раз на (user, category, lang, seed) и замораживается на
        10 минут: пагинация режет ОДИН список — повторы между страницами и
        дёрганье порядка исчезают по построению. */
    const snapshot = await getOrBuildFeedSnapshot(
      feedSessionKey(userId, category, lang, effSeed),
      () => buildFeedSnapshot({ userId, effSeed, index, signals, lang }),
    )
    mark('snapshot')

    /* ---------- Свежие персональные исключения ПОВЕРХ снапшота ----------
        «Не интересно»/жалоба/мьют, сделанные в середине сессии, применяются
        фильтром на выдаче: пост исчезает, остальные не перемешиваются.
        (Мутации вызывают invalidatePersonalSignals — фильтр виден сразу.) */
    const visible = snapshot.items.filter(
      (x) =>
        !signals.hiddenPostIds.has(x.id) &&
        !signals.reportedPostIds.has(x.id) &&
        !signals.mutedIds.has(x.cid),
    )

    // Страница — честный срез замороженного порядка
    const sliceItems = visible.slice(page * limit, page * limit + limit)
    const sliceIds = sliceItems.map((x) => x.id)
    const pageRows: PageRow[] = await fetchPageRows(sliceIds, userId)
    mark('page-batch')

    /* ---------- v6.1.3: «Показано 0 из 0» больше не врёт ----------
     * Снапшот непустой, а строки страницы не добылись (БД подтормаживала,
     * оба ретрая упали) — раньше такой ответ уходил как 200 с items:[],
     * клиент рисовал «Здесь пока пусто», и пустота кэшировалась L0.
     * Теперь — честный 503: клиент покажет «Не удалось загрузить ленту»
     * с кнопкой «Обновить» вместо ложного «постов нет». Легитимная пустота
     * (постов действительно нет — снапшот пустой) сюда не попадает:
     * у неё sliceIds пуст. */
    if (sliceIds.length > 0 && pageRows.length === 0) {
      return err('feed temporarily unavailable', 503)
    }

    // Показ кампании: инкремент ТОЛЬКО кампаниям, чей спонсорский пост реально
    // попал на текущую страницу снапшота (fire-and-forget)
    if (snapshot.sponsoredIds.size > 0) {
      const shownCampaignIds = new Set<string>()
      for (const x of sliceItems) {
        if (snapshot.sponsoredIds.has(x.id)) {
          const campId = snapshot.sponsorCampaigns.get(x.cid)
          if (campId) shownCampaignIds.add(campId)
        }
      }
      if (shownCampaignIds.size > 0) {
        void db.adCampaign
          .updateMany({
            where: { id: { in: [...shownCampaignIds] }, status: 'active' },
            data: { impressions: { increment: 1 } },
          })
          .catch(() => {})
      }
    }

    // Порядок строки результата — как порядок sliceIds
    const byId = new Map(pageRows.map((r) => [r.id, r]))
    const rows = sliceIds.map((id) => byId.get(id)).filter((r): r is PageRow => Boolean(r))

    // v6.1: активные платные подписки юзера на каналы этой страницы —
    // memberOnly-посты этих каналов отдаются без замка (memberUnlocked)
    const memberOnlyChannels = [...new Set(rows.filter((r) => r.memberOnly).map((r) => r.channelId))]
    const unlockedChannels = new Set<string>()
    if (memberOnlyChannels.length > 0) {
      try {
        const ms = await db.channelMembership.findMany({
          where: { userId, channelId: { in: memberOnlyChannels }, until: { gt: new Date() } },
          select: { channelId: true },
        })
        for (const m of ms) unlockedChannels.add(m.channelId)
      } catch {
        /* при ошибке считаем всё закрытым — консервативно */
      }
    }

    const items: PostDTO[] = rows.map((r) => {
      const post = postFromRow(r)
      const dto = toPostDTO(
        post,
        {
          liked: Boolean(r.liked),
          bookmarked: Boolean(r.bookmarked),
          subscribed: signals.subscribedIds.has(r.channelId),
          memberUnlocked: unlockedChannels.has(r.channelId),
        },
        Number(r.bookmarksCount),
      )
      // Спонсорский пост помечается честной меткой «Реклама» в карточке
      if (snapshot.sponsoredIds.has(r.id)) dto.sponsored = true
      // Промо-пост (Snap Pro): подсветка «Продвинуто» в карточке
      if (snapshot.promotedIds.has(r.id)) dto.promoted = true
      return dto
    })

    // Честный hasMore: по ДЛИНЕ персонального порядка (после всех фильтров)
    const hasMore = (page + 1) * limit < visible.length
    /* v6.1.3: пустые страницы НЕ кэшируем. Раньше деградировавший ответ
     * (items:[]) кэшировался на 90с — юзер с «0 из 0» не мог выбраться
     * даже pull-to-refresh'ом (тот же сид → тот же кэш). */
    if (items.length > 0) {
      putCachedPage(userId, category, page, limit, seedForCache, lang, items, hasMore)
    }

    return jsonWithEtag({
      items,
      page,
      hasMore,
    })
  } catch (e) {
    console.error('[feed]', e)
    return err('feed failed', 500)
  }
}

/**
 * Построитель персонального порядка сессии (замороженного снапшота).
 * Выполняется ОДИН раз на (user, category, lang, seed) — см. feed-session.ts.
 *
 * Пайплайн: фильтр языка → исключения → персональный скор → языковой
 * множитель → сортировка (tiebreak по id) → round-robin каналов →
 * пиннинг промо/спонсоров в голову.
 */
async function buildFeedSnapshot(ctx: {
  userId: string
  effSeed: string
  index: RankedIndex
  signals: PersonalSignals
  lang: 'any' | 'ru' | 'foreign'
}): Promise<FeedSnapshot> {
  const { userId, effSeed, index, signals, lang } = ctx

  /* ---------- 0. v5.77: ГЛОБАЛЬНАЯ РОТАЦИЯ КАНАЛОВ при «Обновить реков» ----------
      Жалоба владельца: «при обновлении реков надо чтобы они глобально менялись,
      даже каналы все». Раньше сид вращал только ПОРЯДОК — состав каналов не
      менялся (веса качеств в тысячи, шум ≤900). Теперь:
      • новый сид (≠ прошлому) = новая сессия: каналы ПРОШЛОЙ сессии (из Redis)
        получают штраф −1200 — их посты уходят в хвост;
      • каналы, которых НЕ было в прошлой сессии, получают бонус +160 —
        в голову потока выходят свежие имена;
      • топ-каналы нового снапшота сохраняются обратно (TTL 2ч) — следующий
        refresh увидит их как «прошлые» и поднимет ДРУГИЕ.
      Внутри сессии (тот же сид) — ничего не меняется: порядок заморожен. */
  let prevChannels: Set<string> | null = null
  let isRefresh = false
  try {
    const prevSeed = await cacheGet<string>(`fs:seed:${userId}`)
    isRefresh = prevSeed != null && prevSeed !== effSeed
    if (isRefresh) {
      const arr = await cacheGet<string[]>(`fs:shown:${userId}`)
      if (Array.isArray(arr) && arr.length > 0) prevChannels = new Set(arr)
    }
  } catch {
    /* ротация — улучшение, без Redis работаем как раньше */
  }

  /* ---------- 1. Фильтр языка (v5.25): «Русский / Другие» ----------
      Режем индекс ДО персонализации и диверсификации. Посты без букв (und)
      проходят в любом режиме. */
  const scopedEntries =
    lang === 'any' ? index.entries : index.entries.filter((e) => langPasses(e.l, lang))

  /* ---------- 2. Исключения (Task 5-c) ----------
      • замьютнутые каналы — ЦЕЛИКОМ, без прежних 4% «возвращений»:
        юзер сказал «не показывать» — рекомендация обязана подчиниться;
      • скрытые посты («Не интересно» на пост);
      • посты, на которые юзер сам пожаловался («дизлайкнутое» не возвращается).
      (Посты с 3+ чужими жалобами уже выкинуты в computeRankedIndex.) */
  const muted = signals.mutedIds
  const hidden = signals.hiddenPostIds
  const reported = signals.reportedPostIds
  const base = scopedEntries.filter(
    (e) => !muted.has(e.c) && !hidden.has(e.i) && !reported.has(e.i),
  )

  /* ---------- 2.2 v6.4.0: ЖЁСТКОЕ ИСКЛЮЧЕНИЕ ПРОСМОТРЕННОГО (≤7 дней) ----------
   * Жалоба владельца: «опять появились те же посты, которые я уже миллион раз
   * видел». Раньше просмотренное лишь штрафовалось (−5000/−2200), а шум
   * viewedShuffleNoise (до +2600) частично гасил штраф; viewedIds к тому же
   * покрывал только последние 500 просмотров — хвост истории считался
   * «непросмотренным» и возвращался в ленту (в т.ч. в unseen-голову).
   * Теперь (покрытие даёт recentViews в loadPersonalSignals):
   *   • просмотренное за последние 7 дней в пул НЕ попадает вовсе;
   *   • старше 7 дней — «остыло» и может честно вернуться (мягкий штраф −900);
   *   • страховка от пустой ленты (жалоба v5.x «в ленте пусто»): если после
   *     исключения пула мало, досыпаем просмотренное от САМОГО СТАРОГО
   *     просмотра к свежему — сначала то, что давно не показывалось. */
  const VIEWED_EXCLUDE_MS = 7 * 24 * 3_600_000
  const MIN_POOL = 40
  const nowMs = Date.now()
  const freshPool: typeof base = []
  const viewedRecent: Array<{ e: (typeof base)[number]; at: number }> = []
  for (const e of base) {
    const at = signals.viewedAt.get(e.i)
    if (at !== undefined && nowMs - at < VIEWED_EXCLUDE_MS) viewedRecent.push({ e, at })
    else freshPool.push(e)
  }
  viewedRecent.sort((a, b) => a.at - b.at)
  let pool = freshPool
  if (pool.length < MIN_POOL && viewedRecent.length > 0) {
    const need = Math.min(viewedRecent.length, MIN_POOL - pool.length)
    pool = [...freshPool, ...viewedRecent.slice(0, need).map((x) => x.e)]
  }

  /* ---------- 3. Каналы с взаимодействием юзера ----------
      Языковой множитель к ним не применяется: если человек сам лайкал/
      подписывался/добавил источник — его выбор важнее языка. */
  const interacted = new Set<string>()
  for (const [cid, w] of signals.affinity.channels) if (w > 0) interacted.add(cid)
  for (const cid of signals.subscribedIds) interacted.add(cid)

  /* ---------- 4. Персональный скор + шум + язык ---------- */
  const scored = pool.map((e) => {
    const parts = personalScoreParts({
      channelId: e.c,
      categoryId: e.g,
      subscribed: signals.subscribedIds.has(e.c),
      viewed: signals.viewedIds.has(e.i),
      viewedAtMs: signals.viewedAt.get(e.i),
      affinity: signals.affinity,
      dislikes: signals.dislikeCategories.get(e.g ?? ''),
    })
    let w = e.w + parts.boost
    // v5.77: ротация каналов при refresh (см. блок 0)
    if (isRefresh && prevChannels) {
      if (prevChannels.has(e.c)) w -= 1200
      else w += 160
    }
    // Шум с userId внутри сида: у разных пользователей — разные сигнатуры
    w += shuffleNoise(`${userId}:${e.i}:${effSeed}`, e.w)
    // v5.95/v6.4.0: шум вращает только «остывшее» (>7 дней) виденное — свежее
    // исключено из пула целиком (блок 2.2), и вращать там нечего
    if (signals.viewedIds.has(e.i)) w += viewedShuffleNoise(`${userId}:${e.i}:${effSeed}`, e.w)
    // Языковой множитель (Task 5-c): только к положительной части, штрафы
    // (просмотрено/не интересно/дизлайк тематики) не смягчаются
    if (isForeignForRanking(e.l, e.cl) && !interacted.has(e.c) && w > 0) {
      w *= e.l === 'foreign' ? FOREIGN_LANG_MULTIPLIER : UNDETECTED_FROM_FOREIGN_CHANNEL_MULTIPLIER
    }
    w -= parts.penalty
    return { id: e.i, cid: e.c, b: e.b, w }
  })

  /* ---------- 5. Сортировка с детерминированным tiebreak ----------
      Равные веса упорядочиваются по id — порядок воспроизводим между
      пересборками снапшота и одинаков у всех реплик инстанса. */
  scored.sort((a, b) => b.w - a.w || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  /* ---------- 5.2 v6.0.0: ЖЁСТКИЕ ЯРУСИ в персональном порядке ----------
   * Персональные бусты (аффинити/подписки) могут поднять ботовый пост над
   * запарченным — после сортировки восстанавливаем СТРУКТУРНЫЙ инвариант:
   * сначала все запаренные, потом все ботовые (внутри яруса — по весу).
   * Инвариант дублирует партицию индекса (feed.ts) на случай будущих
   * персональных множителей — приказ владельца не должен зависеть от весов. */
  {
    const organicScored = scored.filter((s) => !s.b)
    const claimedScored = scored.filter((s) => s.b)
    if (organicScored.length > 0 && claimedScored.length > 0) {
      scored.length = 0
      scored.push(...organicScored, ...claimedScored)
    }
  }

  /* ---------- 5.5 v5.95: «при заходе — новое» — unseen-first голова ----------
      Смешанный пул: в первых 10 позициях органики минимум 7 непросмотренных
      (когда их хватает). v6.4.0: свежее виденное исключено из пула — здесь
      «seen» — только посты старше 7 дней (страховка MIN_POOL). */
  const UNSEEN_HEAD_SLOTS = 10
  const UNSEEN_HEAD_MIN = 7
  if (scored.length > UNSEEN_HEAD_SLOTS * 2) {
    const unseen = scored.filter((s) => !signals.viewedIds.has(s.id))
    if (unseen.length >= UNSEEN_HEAD_SLOTS) {
      const headUnseen = unseen.slice(0, UNSEEN_HEAD_MIN)
      const headSeen = scored
        .filter((s) => signals.viewedIds.has(s.id))
        .slice(0, UNSEEN_HEAD_SLOTS - UNSEEN_HEAD_MIN)
      const pinnedHeadIds = new Set([...headUnseen, ...headSeen].map((s) => s.id))
      const rest = scored.filter((s) => !pinnedHeadIds.has(s.id))
      scored.length = 0
      scored.push(...headUnseen, ...headSeen, ...rest)
    }
  }

  /* ---------- 6. Промо + спонсоры: пиннинг в голову потока ----------
      Прежде промо/спонсоры вставлялись ТОЛЬКО на странице 0 с перевырезкой
      страниц (page 0 резалась из одного порядка, page 1 — из другого —
      источник пропусков/дублей). Теперь они пиннятся в голову ЕДИНОГО
      порядка: страница 0 открывается ими, дальше сессия едет по списку.
      Уважаем скрытие/жалобу юзера на конкретный пост; платное промо мьют
      канала не пробивает (раньше — тем более).
      Task 6-c: блок ПЕРЕНЕСЁН ДО diversify — каналы пинов уходят в diversify
      как «recent», иначе их органические посты вставали вплотную к пину
      («два подряд» в начале страницы, аудит 6-c). */
  const promotedIds = new Set<string>()
  const sponsoredIds = new Set<string>()
  const sponsorCampaigns = new Map<string, string>()
  const head: Array<{ id: string; cid: string }> = []
  try {
    const promotedPosts = (await getPromotedCandidates())
      .filter((p) => langPasses(detectLang(p.text), lang))
      .filter((p) => !hidden.has(p.id) && !reported.has(p.id))
    for (const p of promotedPosts) {
      if (promotedIds.has(p.id)) continue
      promotedIds.add(p.id)
      head.push({ id: p.id, cid: p.channelId })
    }

    const sponsors = await getSponsorChannelIds()
    if (sponsors.size > 0) {
      const sponsorPosts = (await getSponsorCandidates([...sponsors.keys()]))
        .filter((p) => !promotedIds.has(p.id) && !signals.viewedIds.has(p.id))
        .filter((p) => !hidden.has(p.id) && !reported.has(p.id))
        .filter((p) => langPasses(detectLang(p.text), lang))
      // по одному свежему посту от каждого спонсора, максимум 3
      const picked = new Map<string, string>()
      for (const p of sponsorPosts) {
        if (picked.size >= 3) break
        if (!picked.has(p.channelId)) picked.set(p.channelId, p.id)
      }
      for (const [cid, id] of picked) {
        sponsoredIds.add(id)
        const campId = sponsors.get(cid)
        if (campId) sponsorCampaigns.set(cid, campId)
        head.push({ id, cid })
      }
    }
  } catch {
    // экстрасы не критичны: без промо/спонсоров лента работает
  }

  /* ---------- 6.5 v5.77: ПОПУЛЯРНОЕ СНАЧАЛА ----------
      Просьба владельца: «сначала показываются популярные посты… и потом
      слабенькие». Топ качества (базовый вес индекса e.w) пиннится в голову
      сразу после промо-блока: 6 постов, по одному с канала, не просмотренные
      юзером, с лёгким сид-перемешиванием (детерминированным — снапшот стабилен). */
  const popularHead: Array<{ id: string; cid: string }> = []
  try {
    const seenChans = new Set<string>(head.map((x) => x.cid))
    // v6.0.0: «популярное сначала» — только запаршенные; ботовые и так в хвосте ярусов
    const topQuality = [...pool]
      .filter((e) => !e.b)
      .sort((a, b) => b.w - a.w || (a.i < b.i ? -1 : a.i > b.i ? 1 : 0))
      .slice(0, 24)
    // сид-перемешивание топа: у каждого refresh — свой порядок популярного
    for (const e of topQuality) {
      if (popularHead.length >= 6) break
      if (seenChans.has(e.c)) continue // один пост с канала
      if (signals.viewedIds.has(e.i)) continue // просмотренное не пинним
      seenChans.add(e.c)
      popularHead.push({ id: e.i, cid: e.c })
    }
  } catch {
    /* не критично */
  }

  const pinIds = new Set<string>([...promotedIds, ...sponsoredIds])
  for (const p of popularHead) pinIds.add(p.id)

  /* ---------- 6.7 v6.1: ПЛАТНЫЕ ПОСТЫ (memberOnly) ДЛЯ ПОДПИСЧИКОВ ----------
   * memberOnly-посты не входят в глобальный индекс (он общий для всех юзеров,
   * а доступ персонален). Для каналов с АКТИВНОЙ подпиской юзера добираем
   * их свежие посты отдельным батчем и вставляем сразу после головы —
   * подписчик купил этот контент, он должен быть на виду. */
  const memberHead: Array<{ id: string; cid: string }> = []
  try {
    const memberships = await db.channelMembership.findMany({
      where: { userId, until: { gt: new Date() } },
      select: { channelId: true },
    })
    if (memberships.length > 0) {
      const known = new Set<string>([
        ...scored.map((s) => s.id),
        ...head.map((h) => h.id),
        ...popularHead.map((h) => h.id),
      ])
      const mposts = await db.post.findMany({
        where: {
          channelId: { in: memberships.map((m) => m.channelId) },
          memberOnly: true,
          id: { notIn: [...known] },
        },
        select: { id: true, channelId: true, text: true },
        orderBy: { publishedAt: 'desc' },
        take: 20,
      })
      for (const p of mposts) {
        if (muted.has(p.channelId) || hidden.has(p.id) || reported.has(p.id)) continue
        if (!langPasses(detectLang(p.text), lang)) continue
        memberHead.push({ id: p.id, cid: p.channelId })
      }
    }
  } catch {
    /* платный контент не критичен для работы ленты */
  }

  /* ---------- 7. Разнообразие: round-robin по каналам ----------
      Cooldown между постами одного канала (см. diversify) + кап 5 постов/канал
      в индексе → ≤2 постов одного канала на страницу из 6. Каналы пинов
      (промо/спонсоры) передаются в recent — их органика соблюдает cooldown
      относительно пинов. */
  const ordered = diversify(scored, (x) => x.cid, head.map((x) => x.cid))
  const items = [
    ...head,
    ...popularHead,
    ...memberHead,
    ...ordered.filter((x) => !pinIds.has(x.id)),
  ]

  /* ---------- v5.77: запоминаем каналы этой сессии ----------
      Следующий «Обновить реков» (новый сид) оштрафует именно их — и поднимет
      другие каналы. Храним до 40 каналов с головы снапшота, TTL 2 часа. */
  try {
    const sessionChannels = [...new Set(items.slice(0, 80).map((x) => x.cid))].slice(0, 40)
    if (sessionChannels.length > 0) {
      await cacheSet(`fs:seed:${userId}`, effSeed, 7200)
      await cacheSet(`fs:shown:${userId}`, sessionChannels, 7200)
    }
  } catch {
    /* не критично */
  }

  /* ---------- 8. Страховка «не подряд» (Task 6-c) ----------
      Если пара соседей одного канала всё же встретилась (двойной пин одного
      канала в голове, вырожденное окно) — второй элемент пары меняется
      местами с ближайшим следующим постом ДРУГОГО канала. Проход детерминирован
      (тот же вход → тот же порядок), пины головы (индексы < head.length)
      не сдвигаются. */
  /* v5.97: до 4 проходов — свап мог сам создать новую пару ниже по списку;
     повторный проход ловит её. Вырожденный хвост (один канал на всё) —
     выходим по отсутствию свапов. */
  for (let pass = 0; pass < 4; pass++) {
    let swapped = false
    for (let k = Math.max(1, head.length); k < items.length; k++) {
      if (items[k].cid !== items[k - 1].cid) continue
      for (let j = k + 1; j < items.length; j++) {
        if (items[j].cid !== items[k].cid) {
          const tmp = items[k]
          items[k] = items[j]
          items[j] = tmp
          swapped = true
          break
        }
      }
    }
    if (!swapped) break
  }

  return { items, promotedIds, sponsoredIds, sponsorCampaigns, builtAt: 0, exp: 0 }
}
