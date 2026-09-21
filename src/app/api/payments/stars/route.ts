import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  /** Сколько свайпов покупаем (1 свайп = 1 Stars) */
  swipes: z.coerce.number().int().min(50).max(2500),
})

const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN?.trim() ?? ''

/**
 * POST /api/payments/stars { swipes } — счёт в Telegram Stars.
 *
 * Bot API createInvoiceLink с currency=XTR: возвращает t.me-ссылку на инвойс,
 * оплату пользователь подтверждает в самом Telegram (Stars — внутренняя валюта
 * Telegram). После оплаты бот получает message.successful_payment (курс XTR) —
 * вебхук зачисляет свайпы идемпотентно.
 *
 * Курс: 1 Star ≈ 1 свайп (≈1 ₽). Telegram ограничивает инвойс XTR сверху —
 * держим 50…2500 звёзд за операцию; крупная сумма = несколько платежей.
 */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 10, windowMs: 60_000, bucket: 'pay-stars' })
  if (!g.ok) return g.res

  if (!BOT_TOKEN()) return err('Оплата Stars временно недоступна', 503)

  try {
    const parsed = createSchema.safeParse(await readJson(request))
    if (!parsed.success) return err('Сумма: от 50 до 2500 ₽ за один платёж Stars')
    const { swipes } = parsed.data

    // Платёж создаём ДО ссылки: вебхук найдёт его по payload
    const payment = await db.pendingPayment.create({
      data: {
        userId: g.uid,
        amountKop: swipes * 100, // 1 Star = 1 ₽ (учёт в копейках)
        provider: 'stars',
        providerPaymentId: null, // придёт в successful_payment
        confirmationUrl: null,
      },
      select: { id: true },
    })
    const payload = `topup:${g.uid}:${swipes}:${payment.id}`

    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `${swipes} ₽ — Tg Swipe`,
        description: 'Пополнение рублёвого баланса Tg Swipe: свайпы для нейросетей, тарифы, продвижение.',
        payload,
        currency: 'XTR',
        prices: [{ label: `${swipes} ₽`, amount: swipes }],
      }),
      signal: AbortSignal.timeout(8000),
    })
    // Терпимый парсинг: Telegram при сбое может отдать не-JSON (HTML 502) —
    // тогда трактуем как отказ и отменяем платёж (иначе висит вечный pending)
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean
      result?: string
      description?: string
    } | null
    if (!data?.ok || typeof data.result !== 'string') {
      console.error('[payments/stars] createInvoiceLink failed', data?.description)
      await db.pendingPayment.updateMany({
        where: { id: payment.id, status: 'pending' },
        data: { status: 'canceled' },
      })
      return err('Telegram не выдал счёт — попробуйте ещё раз', 502)
    }

    await db.pendingPayment.update({
      where: { id: payment.id },
      data: { providerPaymentId: payload },
    })

    return NextResponse.json({ ok: true, paymentId: payment.id, invoiceUrl: data.result, stars: swipes })
  } catch (e) {
    console.error('[payments/stars]', e)
    return err('Не удалось создать счёт в Stars', 500)
  }
}
