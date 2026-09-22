import { NextResponse, after } from 'next/server'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { plategaEnabled, plategaStatusInfo } from '@/lib/platega'
import { creditPendingPayment } from '@/lib/payments'

export const dynamic = 'force-dynamic'

/**
 * Callback Platega (v5.43): URL настраивается в кабинете Platega
 * (Settings → Callback URLs) → https://tg-swipe.vercel.app/api/payments/platega/webhook
 *
 * ХАРДНИНГ: формат тела в документации не зафиксирован и подписи нет — ТЕЛО
 * КОЛБЭКА НЕ ДОВЕРЯЕМ. Из тела берём только hint на id транзакции
 * (transactionId | id), после чего перечитываем статус ПРЯМЫМ запросом
 * GET /transaction/{id} с нашими ключами и зачисляем только CONFIRMED.
 * Зачисление идемпотентно (creditPendingPayment: pending → succeeded ровно раз).
 *
 * Ответ всегда 200, чтобы провайдер не ретраил (кроме «конфигурации нет» → 503).
 */
export async function POST(request: Request) {
  if (!plategaEnabled()) return err('Platega не настроена', 503)

  try {
    // Тело может быть любым JSON — достаём только идентификатор транзакции
    let transactionId = ''
    try {
      const body = (await request.json()) as Record<string, unknown>
      const raw = body?.transactionId ?? body?.id ?? body?.transaction_id
      if (typeof raw === 'string') transactionId = raw.trim()
    } catch {
      /* пустое тело — попробуем по query ниже */
    }
    if (!transactionId) transactionId = new URL(request.url).searchParams.get('id')?.trim() ?? ''
    if (!transactionId) return NextResponse.json({ ok: false, reason: 'no-id' })

    // ИСТИНА — только из API: статус + наш payload (PendingPayment.id)
    const info = await plategaStatusInfo(transactionId)

    // Платёж находим по payload (наш id), иначе по сохранённому providerPaymentId
    const payment =
      (info.payload
        ? await db.pendingPayment.findUnique({ where: { id: info.payload } }).catch(() => null)
        : null) ??
      (await db.pendingPayment
        .findFirst({ where: { providerPaymentId: transactionId, provider: 'platega' } })
        .catch(() => null))

    if (!payment) {
      console.error('[payments:platega:webhook] pending payment not found', transactionId)
      return NextResponse.json({ ok: false, reason: 'not-found' })
    }

    if (info.status === 'CONFIRMED') {
      // Сверка суммы (в рублях): расхождение — не зачисляем, требуем разбора
      if (info.amountRub != null && info.amountRub !== Math.round(payment.amountKop / 100)) {
        console.error(
          '[payments:platega:webhook] amount mismatch',
          transactionId,
          info.amountRub,
          payment.amountKop,
        )
        return NextResponse.json({ ok: false, reason: 'amount-mismatch' })
      }
      const purpose = payment.purpose
      const credited = await creditPendingPayment(payment.id, transactionId)
      // v5.98: коммерческие цели — автору мгновенное подтверждение в бота
      if (credited && (purpose === 'sponsor' || purpose.startsWith('adslot:'))) {
        after(async () => {
          try {
            const { notifyCommercePaid } = await import('@/lib/commerce-wizard')
            await notifyCommercePaid(payment.userId, purpose === 'sponsor' ? 'sponsor' : 'adslot')
          } catch (e) {
            console.error('[payments:platega:webhook] notify', e)
          }
        })
      }
      return NextResponse.json({ ok: true, credited })
    }

    if (info.status === 'CANCELED' || info.status === 'EXPIRED' || info.status === 'FAILED') {
      await db.pendingPayment.updateMany({
        where: { id: payment.id, status: 'pending' },
        data: { status: 'canceled' },
      })
      return NextResponse.json({ ok: true, canceled: true })
    }

    // PENDING/UNKNOWN — ждём: провайдер пришлёт колбэк снова, либо поллинг статуса
    return NextResponse.json({ ok: true, status: info.status })
  } catch (e) {
    console.error('[payments:platega:webhook]', e)
    // 200, чтобы не устраивать провайдеру ретраи на наших багах
    return NextResponse.json({ ok: false })
  }
}
