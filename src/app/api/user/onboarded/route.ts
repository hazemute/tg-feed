import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { guardAuth } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * v5.85 — POST /api/user/onboarded: серверная отметка «онбординг показан».
 *
 * Зачем: гайд/тутор раньше жили ТОЛЬКО в localStorage, а Telegram-клиенты
 * (особенно Desktop/iOS) могут чистить хранилище между сессиями — пользователь
 * видел онбординг при каждом заходе. Теперь клиент после показа шлёт этот
 * запрос (fire-and-forget), и отметка живёт на User.onboardedAt: /api/auth
 * отдаёт user.onboarded, и гайды больше не показываются никогда.
 *
 * Идемпотентно: повторные вызовы не трогают уже выставленную дату.
 */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 10, windowMs: 60_000, bucket: 'onboard' })
  if (!g.ok) return g.res

  try {
    const user = await db.user.findUnique({ where: { id: g.uid }, select: { id: true, onboardedAt: true } })
    if (!user) return err('user not found', 404)
    if (user.onboardedAt) return NextResponse.json({ ok: true, already: true })

    await db.user.update({ where: { id: g.uid }, data: { onboardedAt: new Date() } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[user/onboarded]', e)
    return err('onboarded failed', 500)
  }
}
