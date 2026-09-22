import { db } from '@/lib/db'
import { CHANNEL_LIST_SELECT, POST_LIST_SELECT, channelDTOFromRow, postDTOFromRow } from '@/lib/dto'
import { nsfwPostNotIn, getNsfwChannelIds } from '@/lib/moderation'
import type { ChannelDTO, PostDTO } from '@/lib/types'

/**
 * ТЯЖЁЛОЕ ЯДРО /api/trending (Task 8-b) — вынесено из route-файла в lib,
 * чтобы ФОНОВЫЙ прогрев (feed-warm.ts → /api/warm) собирал его тем же кодом:
 * до наплыва (розыгрыш) ключ tr:core уже лежит в Redis, и первый бёрст
 * пользователей не запускает четыре тяжёлых агрегата на пуле.
 * Формулы считаются один раз здесь — расхождение route/прогрев исключено.
 */

type HashtagItem = { tag: string; clicks: number }
type Pulse = { posts: number; likes: number; views: number; clicks: number }

/** Глобальное ядро агрегата — нейтральные флаги (liked/bookmarked/subscribed = false) */
export type TrendingCore = {
  pulse: Pulse
  hashtags: HashtagItem[]
  topPosts: PostDTO[]
  topChannels: ChannelDTO[]
}

export async function computeTrendingCore(): Promise<TrendingCore> {
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
        where: { publishedAt: { gte: since }, AND: nsfwPostNotIn() },
        select: { ...POST_LIST_SELECT, _count: { select: { bookmarkedBy: true } } },
        orderBy: [{ likesCount: 'desc' }, { viewsCount: 'desc' }],
        take: 60,
      })

    let candidates = await load(since72)
    if (candidates.length < 5) candidates = await load(since7d)

    candidates.sort((a, b) => score(b.likesCount, b.viewsCount) - score(a.likesCount, a.viewsCount))
    const top = candidates.slice(0, 10)

    return top.map((p) =>
      postDTOFromRow(p, { liked: false, bookmarked: false, subscribed: false }, p._count.bookmarkedBy),
    )
  })()

  /* ---------- Топ каналов по подписчикам ----------
     Сортировка по РЕАЛЬНОМУ числу подписчиков (membersCount из Bot API);
     раньше сортировали по локальному счётчику приложения (почти всегда 0) —
     лидерборд был случайным. Каналы без данных — в конце списка. */
  const topChannelsPromise = (async (): Promise<ChannelDTO[]> => {
    const channels = await db.channel.findMany({
      where: { status: 'active', id: { notIn: await getNsfwChannelIds() } },
      select: CHANNEL_LIST_SELECT,
      orderBy: [
        { membersCount: { sort: 'desc', nulls: 'last' } },
        { subscribersCount: 'desc' },
      ],
      take: 8,
    })
    return channels.map((c) => channelDTOFromRow(c, false))
  })()

  const [pulse, hashtags, topPosts, topChannels] = await Promise.all([
    pulsePromise,
    hashtagsPromise,
    topPostsPromise,
    topChannelsPromise,
  ])

  return { pulse, hashtags, topPosts, topChannels }
}
