import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Channel, Post } from '@prisma/client'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { diversify, personalBoost, shuffleNoise } from '@/lib/rank'
import { toPostDTO } from '@/lib/dto'
import { buildFeedScope, loadPersonalSignals, computeRankedIndex } from '@/lib/feed'
import type { RankedIndex } from '@/lib/feed'
import { detectLang, langPasses } from '@/lib/lang'
import { guardAuth } from '@/lib/guard'
import { cacheAside, famKey, shortHash } from '@/lib/redis'
import { getCachedPage, putCachedPage } from '@/lib/page-cache'
import { getSponsorChannelIds, getPromotedCandidates, getSponsorCandidates } from '@/lib/feed-extras'
import { IS_SQLITE } from '@/lib/server'
import type { PostDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

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
  c_status: string
  c_teaserMode: string
  c_teaserLimit: number
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
      status: r.c_status,
      teaserMode: r.c_teaserMode,
      teaserLimit: r.c_teaserLimit,
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
                   p."likesCount", p."commentsCount", p."publishedAt",
                   c."id"           AS "c_id",   c."title"       AS "c_title",
                   c."username"     AS "c_username", c."description" AS "c_description",
                   c."avatarColor"  AS "c_avatarColor", c."photoFileId" AS "c_photoFileId",
                   c."avatarUrl"    AS "c_avatarUrl",
                   c."membersCount" AS "c_membersCount", c."subscribersCount" AS "c_subscribersCount",
                   c."isPremium"    AS "c_isPremium", c."verified"    AS "c_verified",
                   c."status"     AS "c_status",
                   c."teaserMode"   AS "c_teaserMode", c."teaserLimit" AS "c_teaserLimit",
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
            status: true,
            teaserMode: true,
            teaserLimit: true,
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
      c_status: c.status,
      c_teaserMode: c.teaserMode,
      c_teaserLimit: c.teaserLimit,
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
    const fetched = IS_SQLITE ? await fetchBaseRowsSqlite(missing) : await fetchBaseRowsPostgres(missing)
    baseRowPut(fetched)
    base.push(...fetched)
  }
  const byId = new Map(base.map((r) => [r.id, r]))

  // Личные флаги — один лёгкий батч по id страницы
  const flags = await fetchUserFlags(ids, userId)

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
   *  при повторном открытии лента показывается в ДРУГОМ порядке */
  sh: z.string().max(24).optional(),
  /** Фильтр языка (v5.25): any — всё, ru — русский сегмент, foreign — прочие языки.
   *  Посты без букв (мемы-картинки) проходят в любом режиме (см. src/lib/lang.ts). */
  lang: z.enum(['any', 'ru', 'foreign']).catch('any'),
})

/**
 * GET /api/feed?category=all|slug|discover&page=0&limit=6
 *
 * Рекомендации в два уровня:
 *  1) глобальный вес (качество: лайки, закладки, просмотры, свежесть, премиум)
 *     — кэшируется как индекс на «скоуп» в Redis;
 *  2) персональный буст (аффинити к каналам/категориям, подписки, штраф за
 *     просмотренное) + гарантия разнообразия (≤3 постов канала подряд).
 * Требуется сессия (Bearer); лимит 120 запросов в минуту на пользователя.
 */
export async function GET(request: Request) {
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
    // 45с L0-кэш + свежие персональные флаги поверх (см. src/lib/page-cache.ts).
    // Часовая серверная ротация сида не конфликтует с кэшем: TTL 45с << 1 часа.
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
        не даёт бёрсту запросов умножить холодную пересборку. v4 — кап канала.
        v5.48: discover кэшируется ТОЖЕ — сигнатура скоупа строится из
        фактического where (v7), одинаковый where → одинаковый индекс. */
    const indexKey = scope.sig
      ? await famKey('feed', `${category}:v7:${shortHash(scope.sig)}`)
      : null // сигнатуры нет только при ошибке скоупа (не бывает на этом пути)

    const loadIndex = () => computeRankedIndex(scope.where)

    const indexPromise: Promise<RankedIndex> = indexKey
      ? cacheAside({ key: indexKey, ttlSec: 300, memoryTtlMs: 15_000, fetcher: loadIndex })
      : loadIndex()

    const [index, signals] = await Promise.all([indexPromise, loadPersonalSignals(userId)])
    mark('index+signals')

    /* ---------- Фильтр языка (v5.25): «Русский / Другие» ----------
        Режем индекс ДО персонализации и диверсификации: тогда пагинация,
        hasMore и «разные каналы подряд» считаются уже по отфильтрованному
        списку. Посты без букв (und) проходят в любом режиме. */
    const scopedEntries =
      lang === 'any' ? index.entries : index.entries.filter((e) => langPasses(e.l, lang))

    /* ---------- Персональный слой: аффинити + просмотренное + перемешивание ----------
        РОТАЦИЯ (жалоба владельца «постоянно одно и то же»): если клиент не
        прислал сид (первая загрузка сессии), сервер подставляет ЧАСОВОЙ ведро —
        порядок ленты сам вращается каждый час даже без pull-to-refresh,
        у каждого пользователя свой (сид = userId + час). */
    const hourBucket = Math.floor(Date.now() / 3_600_000)
    const effSeed =
      typeof parsed.data.sh === 'string' && parsed.data.sh.length > 0
        ? parsed.data.sh
        : `${userId}:${hourBucket}`

    const boosted = scopedEntries.map((e) => ({
      id: e.i,
      cid: e.c,
      w:
        e.w +
        personalBoost({
          channelId: e.c,
          categoryId: e.g,
          subscribed: signals.subscribedIds.has(e.c),
          viewed: signals.viewedIds.has(e.i),
          viewedAtMs: signals.viewedAt.get(e.i),
          affinity: signals.affinity,
          notInterested: signals.mutedIds.has(e.c),
        }) +
        shuffleNoise(e.i + effSeed, e.w),
    }))
    boosted.sort((a, b) => b.w - a.w)

    /* «Не интересно» — ФИЛЬТР, а не штраф: посты замьютнутых каналов
        исключаются из выдачи. Редкие возвращения — детерминированные:
        ~4% каналов в день (hash(userId:channel:день) % 25 == 0) остаются,
        чтобы лента не замыкалась наглухо и канал мог «вернуться». */
    const muted = signals.mutedIds
    let visible = boosted
    if (muted.size > 0) {
      const dayKey = Math.floor(Date.now() / 86_400_000)
      visible = boosted.filter((x) => {
        if (!muted.has(x.cid)) return true
        let h = 0
        const s = `${userId}:${x.cid}:${dayKey}`
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
        return h % 25 === 0
      })
    }

    // Разнообразие: посты одного канала не идут подряд (как в нативных лентах)
    const ordered = diversify(visible, (x) => x.cid)
    mark('ranked')

    /* ---------- Страница: посты по id из индекса ----------
        Выборка страницы, лайки, закладки и посты спонсоров независимы —
        уходят ОДНИМ параллельным batch’ем (каждый RTT до дальнего Supabase
        стоит ~0.3-0.9с: последовательная цепочка и была причиной «тормозов»). */
    const sponsors = page === 0 ? await getSponsorChannelIds() : null
    let sponSet: Set<string> | null = null
    mark('sponsors-ids')

    /* ---------- Промо-посты (Snap Pro «Продвинуть»): ПЕРВЫМИ В ЛЮБОЙ КАТЕГОРИИ ----------
        Автор заплатил за продвижение — пост вставляется в САМОЕ начало первой
        страницы (выше спонсоров и органики), в любом разрезе ленты, независимо
        от просмотренности/маутов. Окно промо — 24 часа с момента продвижения;
        после — пост остаётся высоко за счёт веса (rank.ts PROMO_BONUS 48ч). */
    const promoSet: Set<string> = new Set()
    // Промо-кандидаты из L0-кэша (feed-extras, 20с): персонализации в выборке нет,
    // язык фильтруем на каждом запросе (кэш общий для всех фильтров)
    const promotedPosts =
      page === 0
        ? (await getPromotedCandidates()).filter((p) => langPasses(detectLang(p.text), lang))
        : []
    if (promotedPosts.length > 0) {
      for (const p of promotedPosts) promoSet.add(p.id)
      const promoEntries = promotedPosts.map((p) => ({ id: p.id, cid: p.channelId, w: 0 }))
      const rest = ordered.filter((x) => !promoSet.has(x.id))
      const merged = diversify([...promoEntries, ...rest], (x) => x.cid)
      ordered.length = 0
      ordered.push(...merged)
    }
    mark('promo-merge')

    // Страница вырезается ПОСЛЕ промо-вставки: промо-посты обязаны попасть
    // на текущую страницу первыми (особенно страница 0)
    const sliceIds = ordered.slice(page * limit, page * limit + limit).map((x) => x.id)
    const pageRows: PageRow[] = await fetchPageRows(sliceIds, userId)
    mark('page-batch')

    // Посты спонсоров — кандидаты из L0-кэша (feed-extras, 20с): персональное
    // «уже просмотренное/промо» вычитается в JS по каждому запросу; пул берётся
    // с запасом (18), поэтому после вычитания кандидатов на выборку хватает
    const sponsorPosts =
      sponsors && sponsors.size > 0
        ? (await getSponsorCandidates([...sponsors.keys()]))
            .filter((p) => !signals.viewedIds.has(p.id) && !promoSet.has(p.id))
            .filter((p) => langPasses(detectLang(p.text), lang))
        : []
    mark('sponsor-posts')

    /* ---------- Спонсорские каналы: активные CPA-кампании — в первых рядах ----------
        Посты канала с активной кампанией подмешиваются на первые позиции первой
        страницы (ещё не просмотренные). Показ кампании засчитывается сразу. */
    if (sponsors && sponsors.size > 0 && sponsorPosts.length > 0) {
      // по свежему посту от каждого спонсора, в начало первой страницы (сразу после промо)
      const picked = new Map<string, string>()
      for (const p of sponsorPosts) {
        if (picked.size >= 3) break
        if (!picked.has(p.channelId)) picked.set(p.channelId, p.id)
      }
      if (picked.size > 0) {
        const sponIds = [...picked.values()]
        const sponSetLocal = new Set(sponIds)
        sponSet = sponSetLocal
        const rest = ordered.filter((x) => !sponSetLocal.has(x.id) && !promoSet.has(x.id))
        /* Спонсорские посты несут РЕАЛЬНЫЙ channelId (раньше cid:'' делал их
            «невидимыми» для диверсификатора — спонсор мог встать рядом с
            органикой того же канала). Пересобираем с повторным diversify:
            стык «спонсор → первый органический того же канала» разводится. */
        const sponEntries = [...picked.entries()].map(([cid, id]) => ({ id, cid, w: 0 }))
        const merged = diversify([...sponEntries, ...rest], (x) => x.cid)
        ordered.length = 0
        ordered.push(...merged)
        // страница уже вырезана из старого порядка — перевырезаем из нового
        const newSliceIds = ordered.slice(page * limit, page * limit + limit).map((x) => x.id)
        const changed = newSliceIds.some((id, i) => sliceIds[i] !== id)
        if (changed) {
          const extraRows = await fetchPageRows(newSliceIds, userId)
          pageRows.length = 0
          pageRows.push(...extraRows)
          sliceIds.length = 0
          sliceIds.push(...newSliceIds)
        }
        // показ кампании: инкремент ТОЛЬКО кампаниям, чей пост реально попал
        // на текущую страницу (раньше инкрементировались ВСЕ активные кампании
        // — статистика показов/бюджета раздувалась впустую). Не ждем ответа.
        const shownCampaignIds = new Set<string>()
        for (const [cid, pid] of picked) {
          if (sliceIds.includes(pid)) {
            const campId = sponsors.get(cid)
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
    }

    // Порядок строки результата — как порядок sliceIds
    const byId = new Map(pageRows.map((r) => [r.id, r]))
    const rows = sliceIds.map((id) => byId.get(id)).filter((r): r is PageRow => Boolean(r))

    const items: PostDTO[] = rows.map((r) => {
      const post = postFromRow(r)
      const dto = toPostDTO(
        post,
        {
          liked: Boolean(r.liked),
          bookmarked: Boolean(r.bookmarked),
          subscribed: signals.subscribedIds.has(r.channelId),
        },
        Number(r.bookmarksCount),
      )
      // Спонсорский пост помечается честной меткой «Реклама» в карточке
      if (sponSet?.has(r.id)) dto.sponsored = true
      // Промо-пост (Snap Pro): подсветка «Продвинуто» в карточке
      if (promoSet.has(r.id)) dto.promoted = true
      return dto
    })

    // Честный hasMore: по ДЛИНЕ персонального порядка (после мьют-фильтра),
    // а не по глобальному индексу — иначе после фильтра «Не интересно»
    // лента обещает страницы, которых нет
    const hasMore = (page + 1) * limit < ordered.length
    putCachedPage(userId, category, page, limit, seedForCache, lang, items, hasMore)

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
