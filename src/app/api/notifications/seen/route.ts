import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { guardAuth } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * POST /api/notifications/seen — отметить уведомления прочитанными:
 * lastSeenNotifiedAt = now (окно «нового» сдвигается к текущему моменту).
 * Пользователь берётся из Bearer-сессии (userId в теле игнорируется).
 */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 30, windowMs: 60_000, bucket: 'notif-seen' })
  if (!g.ok) return g.res
  const userId = g.uid

  try {
    const user = await db.user.findUnique({ where: { id: userId }, select: { id: true } })
    if (!user) return err('user not found', 404)

    await db.user.update({
      where: { id: userId },
      data: { lastSeenNotifiedAt: new Date() },
    })

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[notifications/seen]', e)
    return err('seen failed', 500)
  }
}
