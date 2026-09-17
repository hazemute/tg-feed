import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { guardAuth } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * GET /api/subscriptions — подписки пользователя с флагом «скрыт из ленты».
 * Пользователь берётся из Bearer-сессии; лимит 60 запросов в минуту.
 */
export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'subscriptions' })
  if (!g.ok) return g.res
  const userId = g.uid

  try {
    const subs = await db.subscription.findMany({
      where: { userId },
      include: {
        channel: { include: { category: true, _count: { select: { posts: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({
      items: subs.map((s) => ({
        channelId: s.channelId,
        hidden: s.hidden,
        notify: s.notify,
        channel: {
          id: s.channel.id,
          title: s.channel.title,
          username: s.channel.username,
          description: s.channel.description,
          avatarColor: s.channel.avatarColor,
          subscribersCount: s.channel.subscribersCount,
          isPremium: s.channel.isPremium,
          status: s.channel.status,
          categorySlug: s.channel.category?.slug ?? null,
          categoryTitle: s.channel.category?.title ?? null,
          postsCount: s.channel._count.posts,
          subscribed: true,
        },
      })),
    })
  } catch (e) {
    console.error('[subscriptions]', e)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
