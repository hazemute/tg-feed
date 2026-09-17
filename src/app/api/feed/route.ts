import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { computeWeight, diversify, personalBoost, rankJitter, shuffleNoise } from '@/lib/rank'
import { toPostDTO } from '@/lib/dto'
import { buildFeedScope, loadPersonalSignals } from '@/lib/feed'
import { guardAuth } from '@/lib/guard'
import { cacheAside, famKey, shortHash } from '@/lib/redis'
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
 * Запись глобального индекса: id поста, id канала, id категории, вес.
 * Кэшируется для ВСЕХ пользователей (вес — глобальное качество поста),
 * персонализация применяется на каждом запросе поверх этих данных.
 */
type IndexEntry = { i: string; c: string; g: string | null; w: number }
type RankedIndex = { entries: IndexEntry[]; total: number }

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

  try {
    const { searchParams } = new URL(request.url)
    const parsed = querySchema.safeParse(Object.fromEntries(searchParams))
    if (!parsed.success) return err('invalid query')
    const { category, page, limit } = parsed.data

    const scope = await buildFeedScope(userId, category)
    if (!scope) return err('user not found', 404)

    /* ---------- Глобальный индекс: Redis (25с) → Postgres ---------- */
    const indexKey =
      scope.sig !== null
        ? await famKey('feed', `${category}:v2:${shortHash(scope.sig)}`)
        : null // discover — персональный скоуп по интересам, без кэша

    const loadIndex = async (): Promise<RankedIndex> => {
      const posts = await db.post.findMany({
        where: scope.where,
        select: {
          id: true,
          channelId: true,
          likesCount: true,
          viewsCount: true,
          publishedAt: true,
          channel: {
            select: { isPremium: true, categoryId: true },
          },
        },
        orderBy: { publishedAt: 'desc' },
        take: 400,
      })
      const entries: IndexEntry[] = posts
        .map((p) => ({
          i: p.id,
          c: p.channelId,
          g: p.channel.categoryId,
          w: computeWeight({
            likesCount: p.likesCount,
            viewsCount: p.viewsCount,
            publishedAt: p.publishedAt,
            premium: p.channel.isPremium,
          }) + rankJitter(p.id),
        }))
        .sort((a, b) => b.w - a.w)
      return { entries, total: entries.length }
    }

    const index: RankedIndex = indexKey
      ? await cacheAside({ key: indexKey, ttlSec: 25, memoryTtlMs: 3000, fetcher: loadIndex })
      : await loadIndex()

    /* ---------- Персональный слой: аффинити + просмотренное + перемешивание ---------- */
    const signals = await loadPersonalSignals(userId)
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
        }) +
        shuffleNoise(e.i + shuffleSeed),
    }))
    boosted.sort((a, b) => b.w - a.w)

    // Разнообразие: посты одного канала не идут подряд (как в нативных лентах)
    const ordered = diversify(boosted, (x) => x.cid)

    /* ---------- Спонсорские каналы: активные CPA-кампании — в первых рядах ----------
        Посты канала с активной кампанией подмешиваются на первые позиции первой
        страницы (ещё не просмотренные). Показ кампании засчитывается сразу. */
    if (page === 0) {
      const sponsors = await sponsorChannelIds()
      if (sponsors.size > 0) {
        const sponsorPosts = await db.post.findMany({
          where: {
            channelId: { in: [...sponsors.keys()] },
            id: { notIn: [...signals.viewedIds] },
          },
          orderBy: { publishedAt: 'desc' },
          take: 12,
        })
        // по свежему посту от каждого спонсора, в начало первой страницы
        const picked = new Map<string, string>()
        for (const p of sponsorPosts) {
          if (picked.size >= 3) break
          if (!picked.has(p.channelId)) picked.set(p.channelId, p.id)
        }
        if (picked.size > 0) {
          const sponIds = [...picked.values()]
          const sponSet = new Set(sponIds)
          const rest = ordered.filter((x) => !sponSet.has(x.id))
          ordered.length = 0
          ordered.push(...sponIds.map((id) => ({ id, cid: '', w: 0 })), ...rest)
          // показ кампании: один инкремент на загрузку первой страницы
          await db.adCampaign
            .updateMany({
              where: { id: { in: [...sponsors.values()] }, status: 'active' },
              data: { impressions: { increment: 1 } },
            })
            .catch(() => {})
        }
      }
    }

    /* ---------- Страница: посты по id из индекса ---------- */
    const sliceIds = ordered.slice(page * limit, page * limit + limit).map((x) => x.id)
    const slicePosts = sliceIds.length
      ? await db.post.findMany({
          where: { id: { in: sliceIds } },
          include: {
            channel: { include: { category: true } },
            _count: { select: { bookmarkedBy: true } },
          },
        })
      : []

    const byId = new Map(slicePosts.map((p) => [p.id, p]))
    const slice = sliceIds
      .map((id) => byId.get(id))
      .filter((p): p is NonNullable<typeof p> => Boolean(p))

    const postIds = slice.map((s) => s.id)
    const channelIds = [...new Set(slice.map((s) => s.channelId))]

    // $transaction: одно соединение вместо двух параллельных (пул connection_limit=1)
    const [likes, bookmarks] = await db.$transaction([
      db.like.findMany({ where: { userId, postId: { in: postIds } }, select: { postId: true } }),
      db.bookmark.findMany({
        where: { userId, postId: { in: postIds } },
        select: { postId: true },
      }),
    ])

    const likeSet = new Set(likes.map((l) => l.postId))
    const bookmarkSet = new Set(bookmarks.map((b) => b.postId))

    const items: PostDTO[] = slice.map((p) =>
      toPostDTO(
        p,
        {
          liked: likeSet.has(p.id),
          bookmarked: bookmarkSet.has(p.id),
          subscribed: signals.subscribedIds.has(p.channelId),
        },
        p._count.bookmarkedBy,
      ),
    )

    return NextResponse.json({
      items,
      page,
      hasMore: (page + 1) * limit < index.total,
    })
  } catch (e) {
    console.error('[feed]', e)
    return err('feed failed', 500)
  }
}
