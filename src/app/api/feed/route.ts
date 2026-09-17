import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { computeWeight, diversify, personalBoost, rankJitter } from '@/lib/rank'
import { toPostDTO } from '@/lib/dto'
import { buildFeedScope, loadPersonalSignals } from '@/lib/feed'
import { guardAuth } from '@/lib/guard'
import { cacheAside, famKey, shortHash } from '@/lib/redis'
import type { PostDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

// Валидация query-параметров. userId из query игнорируется —
// пользователь берётся ТОЛЬКО из Bearer-сессии (защита от подмены личности).
const querySchema = z.object({
  category: z.string().max(32).regex(/^[a-z0-9_-]+$/).catch('all'),
  page: z.coerce.number().int().min(0).catch(0),
  limit: z.coerce.number().int().min(1).max(20).catch(6),
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

    /* ---------- Персональный слой: аффинити + просмотренное ---------- */
    const signals = await loadPersonalSignals(userId)

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
        }),
    }))
    boosted.sort((a, b) => b.w - a.w)

    // Разнообразие: не более трёх постов одного канала подряд
    const ordered = diversify(boosted, (x) => x.cid)

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

    const [likes, bookmarks] = await Promise.all([
      postIds.length
        ? db.like.findMany({ where: { userId, postId: { in: postIds } }, select: { postId: true } })
        : Promise.resolve([]),
      postIds.length
        ? db.bookmark.findMany({
            where: { userId, postId: { in: postIds } },
            select: { postId: true },
          })
        : Promise.resolve([]),
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
