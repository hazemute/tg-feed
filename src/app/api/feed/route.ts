import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { Channel, Post } from '@prisma/client'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { diversify, personalBoost, shuffleNoise } from '@/lib/rank'
import { toPostDTO } from '@/lib/dto'
import { buildFeedScope, loadPersonalSignals, computeRankedIndex } from '@/lib/feed'
import type { RankedIndex } from '@/lib/feed'
import { guardAuth } from '@/lib/guard'
import { cacheAside, famKey, shortHash } from '@/lib/redis'
import { getCachedPage, putCachedPage } from '@/lib/page-cache'
import { nsfwPostNotIn } from '@/lib/moderation'
import type { PostDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

/**
 * Спонсорские каналы (активные CPA-кампании с бюджетом): channelId → campaignId.
 * L0-кэш 20с — таблица крошечная, но запрос не нужен на каждую загрузку ленты.
 */
let sponsorCache: { map: Map<string, string>; exp: number } | null = null
async function sponsorChannelIds(): Promise<Map<string, string>> {
  if (sponsorCache && sponsorCache.exp > Date.now()) return sponsorCache.map
  const rows = await db.adCampaign.findMany({
    where: { status: 'active', channelId: { not: null } },
    select: { id: true, channelId: true, budgetKop: true, spentKop: true },
  })
  const map = new Map<string, string>()
  for (const r of rows) {
    if (r.channelId && r.spentKop < r.budgetKop && !map.has(r.channelId)) {
      map.set(r.channelId, r.id)
    }
  }
  sponsorCache = { map, exp: Date.now() + 20_000 }
  return map
}


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
      category: r.cat_slug ? { slug: r.cat_slug, title: r.cat_title } : null,
    },
  } as unknown as PostWithChannel
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

  const perf = process.env.FEED_PERF === '1'
  const t0 = Date.now()
  const mark = (label: string) => {
    if (perf) console.log(`[feed-perf] ${label}: ${Date.now() - t0}ms`)
  }

  try {
    const { searchParams } = new URL(request.url)
    const parsed = querySchema.safeParse(Object.fromEntries(searchParams))
    if (!parsed.success) return err('invalid query')
    const { category, page, limit } = parsed.data

    // Мгновенный ответ для недавно отданной страницы (смена вкладок/возврат в ленту):
    // 45с L0-кэш + свежие персональные флаги поверх (см. src/lib/page-cache.ts)
    const seedForCache = typeof parsed.data.sh === 'string' ? parsed.data.sh : ''
    const cached = getCachedPage(userId, category, page, limit, seedForCache)
    if (cached) return NextResponse.json({ ...cached, page })

    // Скоуп и персональные сигналы независимы — идём параллельно (каждый RTT дорог)
    const [scope, signals] = await Promise.all([
      buildFeedScope(userId, category),
      loadPersonalSignals(userId),
    ])
    if (!scope) return err('user not found', 404)
    mark('scope+signals')

    /* ---------- Глобальный индекс: Redis (300с + прогрев) → Postgres ----------
        Дальний регион (Supabase eu-central-1): холодный пересчёт индекса стоит
        ~2с и грузит пул; TTL 300с + инвалидация famKey при новых постах
        парсером + ПРОГРЕВ ключей парсером/warm'ом (feed-warm.ts) — юзеры
        почти никогда не платят за пересчёт; кросс-инстансный лок в cacheAside
        не даёт бёрсту запросов умножить холодную пересборку. */
    const indexKey =
      scope.sig !== null
        ? await famKey('feed', `${category}:v3:${shortHash(scope.sig)}`) // v3 — NSFW-фильтр
        : null // discover — персональный скоуп по интересам, без кэша

    const loadIndex = () => computeRankedIndex(scope.where)

    const index: RankedIndex = indexKey
      ? await cacheAside({ key: indexKey, ttlSec: 300, memoryTtlMs: 15_000, fetcher: loadIndex })
      : await loadIndex()
    mark('index')

    /* ---------- Персональный слой: аффинити + просмотренное + перемешивание ---------- */
    const shuffleSeed = typeof parsed.data.sh === 'string' ? parsed.data.sh : ''

    const boosted = index.entries.map((e) => ({
      id: e.i,
      cid: e.c,
      w:
        e.w +
        personalBoost({
          channelId: e.c,
          categoryId: e.g,
          subscribed: signals.subscribedIds.has(e.c),
          viewed: signals.viewedIds.has(e.i),
          affinity: signals.affinity,
          notInterested: signals.mutedIds.has(e.c),
        }) +
        shuffleNoise(e.i + shuffleSeed),
    }))
    boosted.sort((a, b) => b.w - a.w)

    // Разнообразие: посты одного канала не идут подряд (как в нативных лентах)
    const ordered = diversify(boosted, (x) => x.cid)
    mark('ranked')

    /* ---------- Страница: посты по id из индекса ----------
        Выборка страницы, лайки, закладки и посты спонсоров независимы —
        уходят ОДНИМ параллельным batch’ем (каждый RTT до дальнего Supabase
        стоит ~0.3-0.9с: последовательная цепочка и была причиной «тормозов»). */
    const sliceIds = ordered.slice(page * limit, page * limit + limit).map((x) => x.id)
    const sponsors = page === 0 ? await sponsorChannelIds() : null
    let sponSet: Set<string> | null = null
    mark('sponsors-ids')

    const pageRows: PageRow[] = sliceIds.length
      ? await db.$queryRaw<PageRow[]>`
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
                   cat."slug"       AS "cat_slug", cat."title"  AS "cat_title",
                   (SELECT COUNT(*) FROM "Bookmark" b WHERE b."postId" = p."id") AS "bookmarksCount",
                   (l."userId" IS NOT NULL)  AS "liked",
                   (bm."userId" IS NOT NULL) AS "bookmarked"
            FROM "Post" p
            JOIN "Channel" c  ON c."id" = p."channelId"
            LEFT JOIN "Category" cat ON cat."id" = c."categoryId"
            LEFT JOIN "Like" l     ON l."postId" = p."id" AND l."userId" = ${userId}
            LEFT JOIN "Bookmark" bm ON bm."postId" = p."id" AND bm."userId" = ${userId}
            WHERE p."id" = ANY(${sliceIds}::text[])`
      : []
    mark('page-batch')

    // Посты спонсоров — отдельным ходом ПОСЛЕ основного SQL: последовательность
    // на тёплом соединении (~0.9с) дешевле, чем параллельный запрос, вынуждающий
    // открывать второе TLS-соединение к пулеру (~1.7с+)
    const sponsorPosts =
      sponsors && sponsors.size > 0
        ? await db.post.findMany({
            where: {
              channelId: { in: [...sponsors.keys()] },
              id: { notIn: [...signals.viewedIds] },
              AND: nsfwPostNotIn(), // CPA-спам тоже проходит гигиену текста
            },
            orderBy: { publishedAt: 'desc' },
            take: 12,
          })
        : []
    mark('sponsor-posts')

    /* ---------- Спонсорские каналы: активные CPA-кампании — в первых рядах ----------
        Посты канала с активной кампанией подмешиваются на первые позиции первой
        страницы (ещё не просмотренные). Показ кампании засчитывается сразу. */
    if (sponsors && sponsors.size > 0 && sponsorPosts.length > 0) {
      // по свежему посту от каждого спонсора, в начало первой страницы
      const picked = new Map<string, string>()
      for (const p of sponsorPosts) {
        if (picked.size >= 3) break
        if (!picked.has(p.channelId)) picked.set(p.channelId, p.id)
      }
      if (picked.size > 0) {
        const sponIds = [...picked.values()]
        const sponSetLocal = new Set(sponIds)
        sponSet = sponSetLocal
        const rest = ordered.filter((x) => !sponSetLocal.has(x.id))
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
          const extraRows = await db.$queryRaw<PageRow[]>`
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
                   cat."slug"       AS "cat_slug", cat."title"  AS "cat_title",
                   (SELECT COUNT(*) FROM "Bookmark" b WHERE b."postId" = p."id") AS "bookmarksCount",
                   (l."userId" IS NOT NULL)  AS "liked",
                   (bm."userId" IS NOT NULL) AS "bookmarked"
            FROM "Post" p
            JOIN "Channel" c  ON c."id" = p."channelId"
            LEFT JOIN "Category" cat ON cat."id" = c."categoryId"
            LEFT JOIN "Like" l     ON l."postId" = p."id" AND l."userId" = ${userId}
            LEFT JOIN "Bookmark" bm ON bm."postId" = p."id" AND bm."userId" = ${userId}
            WHERE p."id" = ANY(${newSliceIds}::text[])`
          pageRows.length = 0
          pageRows.push(...extraRows)
          sliceIds.length = 0
          sliceIds.push(...newSliceIds)
        }
        // показ кампании: один инкремент на загрузку первой страницы (не ждем)
        void db.adCampaign
          .updateMany({
            where: { id: { in: [...sponsors.values()] }, status: 'active' },
            data: { impressions: { increment: 1 } },
          })
          .catch(() => {})
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
      return dto
    })

    const hasMore = (page + 1) * limit < index.total
    putCachedPage(userId, category, page, limit, seedForCache, items, hasMore)

    return NextResponse.json({
      items,
      page,
      hasMore,
    })
  } catch (e) {
    console.error('[feed]', e)
    return err('feed failed', 500)
  }
}
