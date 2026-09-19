import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { creditPendingPayment } from '@/lib/payments'

export const dynamic = 'force-dynamic'

/**
 * POST /api/payments/webhook — нотификация эквайринга (ЮKassa).
 *
 * ЮKassa присылает JSON вида:
 *   { type: "notification", event: "payment.succeeded",
 *     object: { id, status: "succeeded", paid: true,
 *               amount: { value: "500.00", currency: "RUB" },
 *               metadata: { paymentId: "<наш PendingPayment.id>" } } }
 *
 * Начисление идемпотентно: платёж помечается succeeded АТОМАРНО
 * (updateMany по status='pending') — баланс рекламодателя растёт или тир
 * активируется ровно один раз (общая проводка creditPendingPayment).
 * Свайпы: 1 свайп = 1 ₽ → balanceKop += amountKop, topupsTotalKop += amountKop.
 * Тарифы: purpose plus_month/plus_year/pro_month/pro_year → tier + tierUntil.
 *
 * Защита: если задан YOOKASSA_WEBHOOK_SECRET — сверяем заголовок
 * x-yookassa-webhook-secret (настраивается в личном кабинете ЮKassa).
 * Дополнительно принимаем только платежи, существующие в PendingPayment.
 */

type YkNotification = {
  event?: string
  object?: {
    id?: string
    status?: string
    paid?: boolean
    amount?: { value?: string; currency?: string }
    metadata?: { paymentId?: string }
  }
}

export async function POST(request: Request) {
  const secret = process.env.YOOKASSA_WEBHOOK_SECRET?.trim()
  if (secret) {
    const got = (request.headers.get('x-yookassa-webhook-secret') ?? '').trim()
    if (got !== secret) return NextResponse.json({ ok: false }, { status: 401 })
  }

  let body: YkNotification
  try {
    body = (await request.json()) as YkNotification
  } catch {
    return NextResponse.json({ ok: true }) // мусор не роняет вебхук
  }

  try {
    if (body.event !== 'payment.succeeded' && body.event !== 'payment.canceled') {
      return NextResponse.json({ ok: true, ignored: body.event ?? null })
    }

    const obj = body.object ?? {}
    // Наш платёж ищем по metadata.paymentId (появится при интеграции createPayment),
    // фолбэк — по providerPaymentId.
    const ourId = obj.metadata?.paymentId ?? ''
    const payment = await db.pendingPayment.findFirst({
      where: {
        OR: [
          ...(ourId ? [{ id: ourId }] : []),
          ...(obj.id ? [{ providerPaymentId: obj.id }] : []),
        ],
      },
    })
    if (!payment) {
      // Чужой/неизвестный платёж — отвечаем успехом, чтобы ЮKassa не ретраила
      return NextResponse.json({ ok: true, unknown: true })
    }

    if (body.event === 'payment.canceled') {
      await db.pendingPayment.updateMany({
        where: { id: payment.id, status: 'pending' },
        data: { status: 'canceled' },
      })
      return NextResponse.json({ ok: true })
    }

    // payment.succeeded: проверяем сумму и факт оплаты
    const paid = obj.paid === true && obj.status === 'succeeded'
    const kopFromAmount = obj.amount?.value
      ? Math.round(parseFloat(obj.amount.value) * 100)
      : 0
    if (!paid || !Number.isFinite(kopFromAmount) || kopFromAmount <= 0) {
      return NextResponse.json({ ok: true, ignored: 'not paid' })
    }
    if (kopFromAmount !== payment.amountKop) {
      // Сумма не совпала — не начисляем (защита от подмены), помечаем для ручного разбора
      console.error('[payments/webhook] amount mismatch', {
        paymentId: payment.id,
        expected: payment.amountKop,
        got: kopFromAmount,
      })
      return NextResponse.json({ ok: false, error: 'amount mismatch' }, { status: 409 })
    }

    // Атомарная идемпотентная проводка: pending → succeeded + зачисление.
    // purpose='balance' → эскроу-баланс рекламодателя; purpose='plus_month'/
    // 'pro_year'/… → активация/продление тарифа Snap (lib/tiers).
    const result = await creditPendingPayment(payment.id, obj.id ?? payment.providerPaymentId)

    return NextResponse.json({ ok: true, credited: result })
  } catch (e) {
    console.error('[payments/webhook]', e)
    // 500 → ЮKassa повторит нотификацию позже (это нам и нужно при сбое БД)
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
