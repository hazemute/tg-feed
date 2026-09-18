import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { guardPublic } from '@/lib/guard'
import { cacheAside, famKey } from '@/lib/redis'
import { getNsfwChannelIds } from '@/lib/moderation'

export const dynamic = 'force-dynamic'

// Публичный каталог; сессия опциональна — от неё зависит только флаг subscribed.
const querySchema = z.object({
  category: z.string().max(64).regex(/^[a-z0-9_-]*$/).catch(''),
  q: z.string().trim().max(100).catch(''),
})

type ChannelItem = Omit<Awaited<ReturnType<typeof loadChannels>>[number], 'subscribed'> & {
  subscribed: boolean
}

/**
 * GET /api/channels?category=&q=
 * Каталог активных каналов (для вкладки «Категории»).
 * Без сессии — анонимный просмотр: subscribed = false у всех.
 * Redis: список каналов (глобальная часть, нейтральные флаги) кэшируется
 * на 60с при пустом q; флаг subscribed накладывается после кэша.
 */
export async function GET(request: Request) {
  const g = guardPublic(request, { limit: 120, windowMs: 60_000, bucket: 'channels' })
  if (!g.ok) return g.res
  const userId = g.uid // string | null

  try {
    const { searchParams } = new URL(request.url)
    const parsed = querySchema.safeParse(Object.fromEntries(searchParams))
    const category = parsed.success ? parsed.data.category : ''
    const q = parsed.success ? parsed.data.q : ''

    let items: ChannelItem[]
    if (q) {
      items = await loadChannels(category, q)
    } else {
      items = await cacheAside({
        key: await famKey('ch', category || 'all'),
        ttlSec: 60,
        memoryTtlMs: 10000,
        fetcher: () => loadChannels(category, ''),
      })
    }

    // Персонализация поверх кэша
    if (userId && items.length > 0) {
      const subs = await db.subscription.findMany({
        where: { userId, channelId: { in: items.map((c) => c.id) } },
        select: { channelId: true },
      })
      const subSet = new Set(subs.map((s) => s.channelId))
      items = items.map((c) => ({ ...c, subscribed: subSet.has(c.id) }))
    }

    return NextResponse.json({ items })
  } catch (e) {
    console.error('[channels]', e)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}

async function loadChannels(category: string, q: string) {
  // NSFW-каналы не попадают в каталог ни при каком поиске
  const channels = await db.channel.findMany({
    where: {
      status: 'active',
      id: { notIn: await getNsfwChannelIds() },
      ...(category ? { category: { slug: category } } : {}),
      ...(q ? { OR: [{ title: { contains: q } }, { username: { contains: q } }] } : {}),
    },
    include: { category: true, _count: { select: { posts: true } } },
    // сначала каналы с известным реальным числом подписчиков (Bot API), потом без
    orderBy: [
      { isPremium: 'desc' },
      { membersCount: { sort: 'desc', nulls: 'last' } },
      { subscribersCount: 'desc' },
    ],
    take: 100,
  })

  return channels.map((c) => ({
    id: c.id,
    title: c.title,
    username: c.username,
    description: c.description?.replace(/\s+/g, ' ').trim() ?? null,
    avatarColor: c.avatarColor,
    avatarUrl: c.photoFileId ? `/api/avatar/c_${c.id}` : null,
    subscribersCount: c.membersCount ?? c.subscribersCount,
    isPremium: c.isPremium,
    status: c.status,
    categorySlug: c.category?.slug ?? null,
    categoryTitle: c.category?.title ?? null,
    postsCount: c._count.posts,
    subscribed: false as const,
  }))
}
