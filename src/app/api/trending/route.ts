import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { guardPublic } from '@/lib/guard'
import { toPostDTO, toChannelDTO } from '@/lib/dto'
import type { ChannelDTO, PostDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

type HashtagItem = { tag: string; clicks: number }
type Pulse = { posts: number; likes: number; views: number; clicks: number }

/**
 * GET /api/trending — агрегат для вкладки «Тренды».
 *
 * Состав ответа:
 *  • pulse      — пульс за 24 часа: новые посты, лайки, просмотры, клики по #тегам;
 *  • hashtags   — топ-10 хэштегов за 72ч (клики), фолбэк — частотные из свежих постов;
 *  • topPosts   — топ-10 постов за 72ч по вовлечённости (лайки×10 + просмотры/10),
 *                 если за 72ч набирается меньше 5 — окно расширяется до 7 дней;
 *  • topChannels— топ-8 активных каналов по подписчикам.
 * Публичный (сессия опциональна): при наличии Bearer добавляются флаги
 * liked/bookmarked/subscribed. Лимит 30/мин.
 */
export async function GET(request: Request) {
  const g = guardPublic(request, { limit: 30, windowMs: 60_000, bucket: 'trending' })
  if (!g.ok) return g.res
  const uid = g.uid

  try {
    const now = Date.now()
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000)
    const since72 = new Date(now - 72 * 60 * 60 * 1000)
    const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000)

    /* ---------- Пульс 24ч (параллельно с остальными запросами) ---------- */
    const pulsePromise = Promise.all([
      db.post.count({ where: { publishedAt: { gte: dayAgo } } }),
      db.like.count({ where: { createdAt: { gte: dayAgo } } }),
      db.postView.count({ where: { createdAt: { gte: dayAgo } } }),
      db.hashtagClick.count({ where: { createdAt: { gte: dayAgo } } }),
    ]).then(([posts, likes, views, clicks]): Pulse => ({ posts, likes, views, clicks }))

    /* ---------- Хэштеги: клики за 72ч + фолбэк из текстов ---------- */
    const hashtagsPromise = (async (): Promise<HashtagItem[]> => {
      const grouped = await db.hashtagClick.groupBy({
        by: ['tag'],
        where: { createdAt: { gte: since72 } },
        _count: { tag: true },
        orderBy: { _count: { tag: 'desc' } },
        take: 10,
      })
      let items = grouped.map((r) => ({ tag: r.tag, clicks: r._count.tag }))

      if (items.length < 5) {
        const posts = await db.post.findMany({
          where: { publishedAt: { gte: since7d } },
          orderBy: { publishedAt: 'desc' },
          take: 200,
          select: { text: true },
        })
        const counts = new Map<string, number>()
        const re = /#([\wа-яё]{2,30})/gi
        for (const p of posts) {
          const tags = p.text.match(re) ?? []
          for (const t of tags) {
            const tag = t.slice(1).toLowerCase()
            counts.set(tag, (counts.get(tag) ?? 0) + 1)
          }
        }
        const fromPosts = [...counts.entries()]
          .map(([tag, n]) => ({ tag, clicks: n }))
          .sort((a, b) => b.clicks - a.clicks)
          .slice(0, 10)

        const seen = new Set(items.map((i) => i.tag))
        for (const f of fromPosts) {
          if (items.length >= 10) break
          if (!seen.has(f.tag)) items.push(f)
        }
      }
      return items
    })()

    /* ---------- Топ постов: окно 72ч, фолбэк 7д ---------- */
    const topPostsPromise = (async (): Promise<PostDTO[]> => {
      const score = (likes: number, views: number) => likes * 10 + views / 10

      const load = async (since: Date) =>
        db.post.findMany({
          where: { publishedAt: { gte: since } },
          include: {
            channel: { include: { category: true } },
            _count: { select: { bookmarkedBy: true } },
          },
          orderBy: [{ likesCount: 'desc' }, { viewsCount: 'desc' }],
          take: 60,
        })

      let candidates = await load(since72)
      if (candidates.length < 5) candidates = await load(since7d)

      candidates.sort((a, b) => score(b.likesCount, b.viewsCount) - score(a.likesCount, a.viewsCount))
      const top = candidates.slice(0, 10)

      const postIds = top.map((p) => p.id)
      const channelIds = [...new Set(top.map((p) => p.channelId))]

      const [likes, bookmarks, subs] = await Promise.all([
        uid && postIds.length
          ? db.like.findMany({ where: { userId: uid, postId: { in: postIds } }, select: { postId: true } })
          : Promise.resolve([]),
        uid && postIds.length
          ? db.bookmark.findMany({ where: { userId: uid, postId: { in: postIds } }, select: { postId: true } })
          : Promise.resolve([]),
        uid && channelIds.length
          ? db.subscription.findMany({ where: { userId: uid, channelId: { in: channelIds } }, select: { channelId: true } })
          : Promise.resolve([]),
      ])
      const likeSet = new Set(likes.map((l) => l.postId))
      const bookmarkSet = new Set(bookmarks.map((b) => b.postId))
      const subSet = new Set(subs.map((s) => s.channelId))

      return top.map((p) =>
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
    })()

    /* ---------- Топ каналов по подписчикам ---------- */
    const topChannelsPromise = (async (): Promise<ChannelDTO[]> => {
      const channels = await db.channel.findMany({
        where: { status: 'active' },
        include: { category: true },
        orderBy: { subscribersCount: 'desc' },
        take: 8,
      })
      const ids = channels.map((c) => c.id)
      const subs =
        uid && ids.length
          ? await db.subscription.findMany({ where: { userId: uid, channelId: { in: ids } }, select: { channelId: true } })
          : []
      const subSet = new Set(subs.map((s) => s.channelId))
      return channels.map((c) => toChannelDTO(c, subSet.has(c.id)))
    })()

    const [pulse, hashtags, topPosts, topChannels] = await Promise.all([
      pulsePromise,
      hashtagsPromise,
      topPostsPromise,
      topChannelsPromise,
    ])

    return NextResponse.json({ pulse, hashtags, topPosts, topChannels })
  } catch (e) {
    console.error('[trending]', e)
    return err('trending failed', 500)
  }
}
