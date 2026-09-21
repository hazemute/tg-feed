import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * GET /api/panel/user-info?userId=... — карточка пользователя для админки:
 * статистика, подписки (для жалоб «скройте канал X»), активность, нити поддержки.
 * Одиночный запрос собирает всё одним batch'ем — панель не должна бегать в БД
 * за каждой мелочью.
 */
export async function GET(request: Request) {
  const g = guardAdmin(request, { limit: 120, windowMs: 60_000, bucket: 'panel-user-info' })
  if (!g.ok) return g.res

  try {
    const { searchParams } = new URL(request.url)
    const userId = searchParams.get('userId')?.trim() ?? ''
    if (!userId) return err('userId required')

    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        firstName: true,
        lastName: true,
        isGuest: true,
        isPremium: true,
        languageCode: true,
        tier: true,
        tierUntil: true,
        badges: true,
        createdAt: true,
      },
    })
    if (!user) return err('user not found', 404)

    const [views, likes, bookmarks, subs, threads] = await Promise.all([
      db.postView.count({ where: { userId } }),
      db.like.count({ where: { userId } }),
      db.bookmark.count({ where: { userId } }),
      db.subscription.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          hidden: true,
          channel: { select: { title: true, username: true, status: true } },
        },
      }),
      db.supportThread.findMany({
        where: { userId },
        orderBy: { lastMessageAt: 'desc' },
        take: 5,
        select: { id: true, status: true, lastMessageAt: true },
      }),
    ])

    return NextResponse.json({
      user,
      stats: { views, likes, bookmarks, subscriptions: subs.length },
      subscriptions: subs.map((s) => ({
        title: s.channel.title,
        username: s.channel.username,
        hidden: s.hidden,
        status: s.channel.status,
      })),
      threads,
    })
  } catch (e) {
    console.error('[panel/user-info]', e)
    return err('user-info failed', 500)
  }
}
