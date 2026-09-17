import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { parseJsonArray } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import type { ProfileResponse } from '@/lib/types'

export const dynamic = 'force-dynamic'

/**
 * GET /api/profile — профиль + статистика.
 * Пользователь берётся из Bearer-сессии; лимит 60 запросов в минуту.
 */
export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'profile' })
  if (!g.ok) return g.res
  const userId = g.uid

  try {
    const user = await db.user.findUnique({ where: { id: userId } })
    if (!user) return NextResponse.json({ error: 'user not found' }, { status: 404 })

    const [likes, subscriptions, views, bookmarks] = await Promise.all([
      db.like.count({ where: { userId } }),
      db.subscription.count({ where: { userId } }),
      db.postView.count({ where: { userId } }),
      db.bookmark.count({ where: { userId } }),
    ])

    const dto: ProfileResponse = {
      user: {
        id: user.id,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        photoUrl: user.photoUrl,
        isGuest: user.isGuest,
        isPremium: user.isPremium,
        languageCode: user.languageCode,
        categories: parseJsonArray(user.categories),
      },
      stats: { likes, subscriptions, views, bookmarks },
    }

    return NextResponse.json(dto)
  } catch (e) {
    console.error('[profile]', e)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
