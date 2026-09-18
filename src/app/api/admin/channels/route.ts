import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { guardAuth } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/channels — каналы, добавленные пользователем.
 * userId берётся из Bearer-сессии (query-параметр игнорируется); 30 запросов в минуту.
 */
export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 30, windowMs: 60_000, bucket: 'adm-ch' })
  if (!g.ok) return g.res
  const userId = g.uid

  try {
    const channels = await db.channel.findMany({
      where: { addedById: userId },
      include: { category: true, _count: { select: { posts: true } } },
      orderBy: { createdAt: 'desc' },
    })

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
        subscribed: false,
      })),
    })
  } catch (e) {
    console.error('[admin/channels]', e)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
