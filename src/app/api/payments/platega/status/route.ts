import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { plategaEnabled, plategaStatusInfo } from '@/lib/platega'
import { creditPendingPayment } from '@/lib/payments'

export const dynamic = 'force-dynamic'

/**
 * GET /api/payments/platega/status?paymentId=… — статус счёта Platega для UI.
 *
 * Пополнение СБП/картой открывает страницу оплаты Platega (redirect). Когда
 * пользователь возвращается в миниапп, шторка сама должна понять, что платёж
 * прошёл: UI опрашивает этот роут раз в несколько секунд.
 *
 * БЕЗОПАСНОСТЬ:
 *  - только владелец платежа (userId из сессии === payment.userId) — чужие
 *    paymentId не раскрывают никакого статуса;
 *  - статус берём ПРЯМЫМ запросом к API Platega с нашими ключами
 *    (plategaStatusInfo) — телу колбэка и клиенту не доверяем;
 *  - зачисление — creditPendingPayment (атомарно pending → succeeded,
 *    идемпотентно): даже если вебхук ещё не долетел, первый же опрос
 *    проведёт платёж; повторные вызовы безопасны.
 */
export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 120, windowMs: 60_000, bucket: 'platega-status' })
  if (!g.ok) return g.res

  if (!plategaEnabled()) return err('Platega не настроена', 503)

  const paymentId = new URL(request.url).searchParams.get('paymentId')?.trim() ?? ''
  if (!paymentId) return err('paymentId обязателен', 400)

  try {
    const payment = await db.pendingPayment.findFirst({
      where: { id: paymentId, userId: g.uid, provider: 'platega' },
      select: { id: true, status: true, providerPaymentId: true, amountKop: true },
    })
    if (!payment) return err('Платёж не найден', 404)

    // Уже проведён (вебхук успел раньше) — отдаём сразу, без похода в Platega
    if (payment.status === 'succeeded') {
      return NextResponse.json({
        ok: true,
        status: 'succeeded',
        amountKop: payment.amountKop,
      })
    }
    if (payment.status === 'canceled') {
      return NextResponse.json({ ok: true, status: 'failed', amountKop: payment.amountKop })
    }

    const info = await plategaStatusInfo(payment.providerPaymentId ?? '')

    if (info.status === 'CONFIRMED') {
      // Сверка суммы (в рублях): расхождение — не зачисляем молча
      if (info.amountRub != null && info.amountRub !== Math.round(payment.amountKop / 100)) {
        console.error(
          '[payments:platega:status] amount mismatch',
          payment.providerPaymentId,
          info.amountRub,
          Math.round(payment.amountKop / 100),
        )
        return NextResponse.json({ ok: true, status: 'failed', amountKop: payment.amountKop })
      }
      const credited = await creditPendingPayment(payment.id, payment.providerPaymentId)
      return NextResponse.json({
        ok: true,
        status: 'succeeded', // creditPendingPayment идемпотентен; провёл вебхук — всё равно успех
        amountKop: payment.amountKop,
      })
    }
    if (info.status === 'PENDING' || info.status === 'UNKNOWN') {
      return NextResponse.json({ ok: true, status: 'pending', amountKop: payment.amountKop })
    }
    // EXPIRED | CANCELED | FAILED
    return NextResponse.json({ ok: true, status: 'failed', amountKop: payment.amountKop })
  } catch (e) {
    console.error('[payments:platega:status]', e)
    return err('Не удалось получить статус платежа', 500)
  }
}
