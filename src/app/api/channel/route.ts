import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { toChannelDTO, toPostDTO } from '@/lib/dto'
import { guardPublic } from '@/lib/guard'
import type { PostDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

// Публичные данные канала; сессия опциональна — от неё зависят только
// персональные флаги (subscribed/liked/bookmarked). userId из query игнорируется.
const querySchema = z.object({
  username: z.string().trim().min(1).max(100),
  page: z.coerce.number().int().min(0).catch(0),
  limit: z.coerce.number().int().min(1).max(20).catch(10),
})

/**
 * GET /api/channel?username=...&page=0&limit=10
 * Экран канала внутри приложения: данные канала + его посты (новые сверху).
 * Без сессии — анонимный просмотр: subscribed/liked/bookmarked = false.
 */
export async function GET(request: Request) {
  const g = guardPublic(request, { limit: 120, windowMs: 60_000, bucket: 'channel' })
  if (!g.ok) return g.res
  const userId = g.uid // string | null — анонимный просмотр разрешён

  try {
    const { searchParams } = new URL(request.url)
    const parsed = querySchema.safeParse(Object.fromEntries(searchParams))
    if (!parsed.success) return err('username required')

    // Как в каталоге: без @, в нижнем регистре (в БД username хранится в lowercase)
    const username = parsed.data.username.replace(/^@/, '').toLowerCase()
    if (!username) return err('username required')
    const { page, limit } = parsed.data

    const channel = await db.channel.findFirst({
      where: { username },
      include: { category: true, _count: { select: { posts: true } } },
    })
    if (!channel) return err('channel not found', 404)

    const [posts, subRow] = await Promise.all([
      db.post.findMany({
        where: { channelId: channel.id },
        orderBy: { publishedAt: 'desc' },
        skip: page * limit,
        take: limit,
        include: { channel: { include: { category: true } }, _count: { select: { bookmarkedBy: true } } },
      }),
      userId
        ? db.subscription.findUnique({
            where: { userId_channelId: { userId, channelId: channel.id } },
            select: { hidden: true },
          })
        : Promise.resolve(null),
    ])

    const postIds = posts.map((p) => p.id)
    const [likes, bookmarks] = await Promise.all([
      userId && postIds.length
        ? db.like.findMany({ where: { userId, postId: { in: postIds } }, select: { postId: true } })
        : Promise.resolve([]),
      userId && postIds.length
        ? db.bookmark.findMany({ where: { userId, postId: { in: postIds } }, select: { postId: true } })
        : Promise.resolve([]),
    ])
    const likeSet = new Set(likes.map((l) => l.postId))
    const bookmarkSet = new Set(bookmarks.map((b) => b.postId))
    const subscribed = !!subRow

    const items: PostDTO[] = posts.map((p) =>
      toPostDTO(p, { liked: likeSet.has(p.id), bookmarked: bookmarkSet.has(p.id), subscribed }, p._count.bookmarkedBy),
    )

    return NextResponse.json({
      channel: toChannelDTO(channel, subscribed, channel._count.posts),
      items,
      page,
      hasMore: (page + 1) * limit < channel._count.posts,
    })
  } catch (e) {
    console.error('[channel]', e)
    return err('channel failed', 500)
  }
}
