import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { guardPublic } from '@/lib/guard'

export const dynamic = 'force-dynamic'

// Публичный каталог; сессия опциональна — от неё зависит только флаг subscribed.
const querySchema = z.object({
  category: z.string().max(64).regex(/^[a-z0-9_-]*$/).catch(''),
  q: z.string().trim().max(100).catch(''),
})

/**
 * GET /api/channels?category=&q=
 * Каталог активных каналов (для вкладки «Категории»).
 * Без сессии — анонимный просмотр: subscribed = false у всех.
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

    const channels = await db.channel.findMany({
      where: {
        status: 'active',
        ...(category ? { category: { slug: category } } : {}),
        ...(q ? { OR: [{ title: { contains: q } }, { username: { contains: q } }] } : {}),
      },
      include: { category: true, _count: { select: { posts: true } } },
      orderBy: [{ isPremium: 'desc' }, { subscribersCount: 'desc' }],
      take: 100,
    })

    const subs = userId
      ? await db.subscription.findMany({
          where: { userId, channelId: { in: channels.map((c) => c.id) } },
          select: { channelId: true },
        })
      : []
    const subSet = new Set(subs.map((s) => s.channelId))

    return NextResponse.json({
      items: channels.map((c) => ({
        id: c.id,
        title: c.title,
        username: c.username,
        description: c.description,
        avatarColor: c.avatarColor,
        subscribersCount: c.subscribersCount,
        isPremium: c.isPremium,
        status: c.status,
        categorySlug: c.category?.slug ?? null,
        categoryTitle: c.category?.title ?? null,
        postsCount: c._count.posts,
        subscribed: subSet.has(c.id),
      })),
    })
  } catch (e) {
    console.error('[channels]', e)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
