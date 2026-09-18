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
  /** Вкладка экрана канала (как в Telegram): all — посты, media — фото/видео, links — ссылки */
  tab: z.enum(['all', 'media', 'links']).catch('all'),
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
    const { tab } = parsed.data

    const channel = await db.channel.findFirst({
      where: { username },
      include: { category: true, _count: { select: { posts: true } } },
    })
    if (!channel) return err('channel not found', 404)

    /* Вкладки фильтруются НА СЕРВЕРЕ (жалоба владельца: «на странице про канал
        сделай вкладки… а то вниз листается бесконечно») — иначе пагинация
        смешанных страниц давала рваную выдачу: на «Медиа» попадало 1-2 поста
        со страницы. total считается по тому же фильтру — hasMore честный. */
    const postWhere = {
      channelId: channel.id,
      ...(tab === 'media'
        ? { OR: [{ mediaUrl: { not: null } }, { gallery: { not: null } }] }
        : tab === 'links'
          ? { link: { not: null } }
          : {}),
    }

    const [posts, tabTotal, subRow] = await Promise.all([
      db.post.findMany({
        where: postWhere,
        orderBy: { publishedAt: 'desc' },
        skip: page * limit,
        take: limit,
        include: { channel: { include: { category: true } }, _count: { select: { bookmarkedBy: true } } },
      }),
      db.post.count({ where: postWhere }),
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
      tab,
      hasMore: (page + 1) * limit < tabTotal,
    })
  } catch (e) {
    console.error('[channel]', e)
    return err('channel failed', 500)
  }
}
