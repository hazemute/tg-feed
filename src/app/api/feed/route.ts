import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { computeWeight, rankJitter } from '@/lib/rank'
import { toPostDTO } from '@/lib/dto'
import { buildFeedScope } from '@/lib/feed'
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

type RankedIndex = { ids: string[]; total: number }

/**
 * GET /api/feed?category=all|slug&page=0&limit=6
 * Взвешенная лента: premium ×1000, лайки с временно́м затуханием,
 * фильтр по интересам, свежие посты приоритетнее, скрытые каналы исключены.
 * Требуется сессия (Bearer); лимит 120 запросов в минуту на пользователя.
 *
 * Redis-оптимизация: тяжёлая часть (скан 400 постов + ранжирование) кэшируется
 * как список id на «скоуп» (категория + интересы + скрытые каналы), а сами посты
 * запрошенной страницы каждый раз читаются из БД — счётчики лайков/просмотров
 * остаются свежими, персонализация никогда не кэшируется.
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

    /* ---------- Ранжированный индекс: Redis (25с) → Postgres ---------- */
    const indexKey =
      scope.sig !== null
        ? await famKey('feed', `${category}:${shortHash(scope.sig)}`)
        : null // discover — персональный скоуп по истории просмотров, без кэша

    const loadIndex = async (): Promise<RankedIndex> => {
      const posts = await db.post.findMany({
        where: scope.where,
        select: {
          id: true,
          likesCount: true,
          publishedAt: true,
          channel: { select: { isPremium: true } },
        },
        orderBy: { publishedAt: 'desc' },
        take: 400,
      })
      const ranked = posts
        .map((p) => ({
          id: p.id,
          w: computeWeight({
            likesCount: p.likesCount,
            publishedAt: p.publishedAt,
            premium: p.channel.isPremium,
          }) + rankJitter(p.id),
        }))
        .sort((a, b) => b.w - a.w)
      return { ids: ranked.map((r) => r.id), total: ranked.length }
    }

    const index: RankedIndex = indexKey
      ? await cacheAside({ key: indexKey, ttlSec: 25, memoryTtlMs: 3000, fetcher: loadIndex })
      : await loadIndex()

    /* ---------- Страница: свежие посты по id из индекса ---------- */
    const sliceIds = index.ids.slice(page * limit, page * limit + limit)
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

    const [likes, bookmarks, subs] = await Promise.all([
      postIds.length
        ? db.like.findMany({ where: { userId, postId: { in: postIds } }, select: { postId: true } })
        : Promise.resolve([]),
      postIds.length
        ? db.bookmark.findMany({
            where: { userId, postId: { in: postIds } },
            select: { postId: true },
          })
        : Promise.resolve([]),
      channelIds.length
        ? db.subscription.findMany({
            where: { userId, channelId: { in: channelIds } },
            select: { channelId: true },
          })
        : Promise.resolve([]),
    ])

    const likeSet = new Set(likes.map((l) => l.postId))
    const bookmarkSet = new Set(bookmarks.map((b) => b.postId))
    const subSet = new Set(subs.map((s) => s.channelId))

    const items: PostDTO[] = slice.map((p) =>
      toPostDTO(
        p,
        {
          liked: likeSet.has(p.id),
          bookmarked: bookmarkSet.has(p.id),
          subscribed: subSet.has(p.channelId),
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
