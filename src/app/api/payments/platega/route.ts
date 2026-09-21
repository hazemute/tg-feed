import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { plategaCreatePayment, plategaEnabled, PLATEGA_METHOD } from '@/lib/platega'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  amountKop: z.coerce.number().int().min(10_000).max(5_000_000), // 100 ₽ … 50 000 ₽
  method: z.enum(['sbp', 'card']).default('sbp'),
})

/**
 * POST /api/payments/platega { amountKop, method: 'sbp'|'card' } — счёт через
 * эквайринг Platega (v5.43): СБП/QR (8%) или карта МИР (9%).
 *
 * Ключи не настроены → 503 «метод скоро» (UI скрывает метод честно —
 * paymentMethods().sbp = false). Включается env: PLATEGA_MERCHANT_ID +
 * PLATEGA_SECRET. Ответ: redirect — ссылка на оплату (открыть в браузере/
 * Telegram), статус поведёт вебхук /api/payments/platega/webhook.
 */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 10, windowMs: 60_000, bucket: 'payments' })
  if (!g.ok) return g.res

  if (!plategaEnabled()) {
    return err('Оплата через СБП/карту скоро появится. Сейчас доступны карта (ЮKassa), Stars и TON.', 503)
  }

  try {
    const parsed = createSchema.safeParse(await readJson(request))
    if (!parsed.success) return err('Сумма: от 100 ₽ до 50 000 ₽')
    const { amountKop, method } = parsed.data

    const payment = await db.pendingPayment.create({
      data: { userId: g.uid, amountKop, provider: 'platega' },
      select: { id: true, amountKop: true, status: true, createdAt: true },
    })

    const created = await plategaCreatePayment({
      amountKop,
      paymentId: payment.id,
      description: `Пополнение баланса Tg Swipe · ${payment.id}`,
      method: method === 'sbp' ? PLATEGA_METHOD.SBP : PLATEGA_METHOD.CARD_RU,
    })
    if (!created) {
      await db.pendingPayment.updateMany({
        where: { id: payment.id, status: 'pending' },
        data: { status: 'canceled' },
      })
      return err('Платёжная система не ответила — попробуйте ещё раз', 502)
    }

    await db.pendingPayment.update({
      where: { id: payment.id },
      data: { providerPaymentId: created.transactionId, confirmationUrl: created.redirect },
    })

    return NextResponse.json({
      ok: true,
      paymentId: payment.id,
      amountKop: payment.amountKop,
      status: created.status,
      redirect: created.redirect,
      method,
    })
  } catch (e) {
    console.error('[payments:platega:create]', e)
    return err('Не удалось создать платёж', 500)
  }
}
