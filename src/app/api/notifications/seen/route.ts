import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { clearNotificationsCache } from '@/lib/notif-cache'

export const dynamic = 'force-dynamic'

/**
 * POST /api/notifications/seen — отметить уведомления прочитанными:
 * lastSeenNotifiedAt = now (окно «нового» сдвигается к текущему моменту),
 * непрочитанная активность (инбокс Notification) получает readAt = now.
 * Пользователь берётся из Bearer-сессии (userId в теле игнорируется).
 */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 30, windowMs: 60_000, bucket: 'notif-seen' })
  if (!g.ok) return g.res
  const userId = g.uid

  try {
    const user = await db.user.findUnique({ where: { id: userId }, select: { id: true } })
    if (!user) return err('user not found', 404)

    const now = new Date()
    await db.user.update({
      where: { id: userId },
      data: { lastSeenNotifiedAt: now },
    })
    // Инбокс активности: непрочитанные события гасим тем же моментом
    await db.notification
      .updateMany({ where: { userId, readAt: null }, data: { readAt: now } })
      .catch(() => {})
    // Кэш GET /api/notifications устарел — сбрасываем (бейджи/инбокс сразу честные)
    clearNotificationsCache(userId)

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[notifications/seen]', e)
    return err('seen failed', 500)
  }
}
