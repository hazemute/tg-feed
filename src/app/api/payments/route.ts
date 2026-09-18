import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { paymentMethods } from '@/lib/payments'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  amountKop: z.coerce.number().int().min(10_000).max(5_000_000), // 100 ₽ … 50 000 ₽
})

/**
 * POST /api/payments { amountKop } — пополнение картой (эквайринг ЮKassa).
 *
 * Ключи не настроены → честная 503 «метод скоро»: UI показывает только
 * рабочие способы (Telegram Stars / TON). Когда заданы YOOKASSA_SHOP_ID +
 * YOOKASSA_SECRET_KEY, здесь создаётся платёж в API ЮKassa и возвращается
 * confirmationUrl (redirect); статус поведёт вебхук (pending → succeeded),
 * после чего баланс рекламодателя пополнится на amountKop.
 *
 * GET /api/payments — история платежей пользователя.
 */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 10, windowMs: 60_000, bucket: 'payments' })
  if (!g.ok) return g.res

  try {
    const parsed = createSchema.safeParse(await readJson(request))
    if (!parsed.success) return err('amountKop: от 100 до 50 000 свайпов')
    const { amountKop } = parsed.data

    const payment = await db.pendingPayment.create({
      data: { userId: g.uid, amountKop, provider: 'yookassa' },
      select: { id: true, amountKop: true, status: true, createdAt: true },
    })

    const shopId = process.env.YOOKASSA_SHOP_ID?.trim() ?? ''
    const secretKey = process.env.YOOKASSA_SECRET_KEY?.trim() ?? ''
    if (!shopId || !secretKey) {
      // Эквайринг ещё не подключён: не рисуем фейковых платежей
      await db.pendingPayment.updateMany({
        where: { id: payment.id, status: 'pending' },
        data: { status: 'canceled' },
      })
      return err('Пополнение картой скоро появится. Сейчас доступны Telegram Stars и TON.', 503)
    }

    /* Реальное создание платежа в ЮKassa (confirmation: redirect) */
    const idempKey = payment.id
    const res = await fetch('https://api.yookassa.ru/v3/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotence-Key': idempKey,
        Authorization: `Basic ${Buffer.from(`${shopId}:${secretKey}`).toString('base64')}`,
      },
      body: JSON.stringify({
        amount: { value: (amountKop / 100).toFixed(2), currency: 'RUB' },
        capture: true,
        confirmation: {
          type: 'redirect',
          return_url: `${process.env.APP_URL ?? 'https://tg-swipe.vercel.app'}`,
        },
        description: 'Пополнение баланса Tg Swipe (свайпы)',
        metadata: { paymentId: payment.id },
      }),
      signal: AbortSignal.timeout(12_000),
    })
    const data = (await res.json()) as {
      id?: string
      confirmation?: { confirmation_url?: string }
      description?: string
    }
    const confirmationUrl = data.confirmation?.confirmation_url ?? null
    if (!res.ok || !confirmationUrl) {
      console.error('[payments:create] yookassa failed', data.description)
      await db.pendingPayment.updateMany({
        where: { id: payment.id, status: 'pending' },
        data: { status: 'canceled' },
      })
      return err('Эквайринг не ответил — попробуйте ещё раз', 502)
    }

    await db.pendingPayment.update({
      where: { id: payment.id },
      data: { providerPaymentId: data.id ?? null, confirmationUrl },
    })

    return NextResponse.json({
      ok: true,
      paymentId: payment.id,
      amountKop: payment.amountKop,
      status: payment.status,
      confirmationUrl,
    })
  } catch (e) {
    console.error('[payments:create]', e)
    return err('Не удалось создать платёж', 500)
  }
}

export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'payments' })
  if (!g.ok) return g.res

  try {
    const items = await db.pendingPayment.findMany({
      where: { userId: g.uid, status: { not: 'canceled' } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, amountKop: true, status: true, provider: true, createdAt: true },
    })
    return NextResponse.json({ items, methods: paymentMethods() })
  } catch (e) {
    console.error('[payments:list]', e)
    return err('Не удалось загрузить платежи', 500)
  }
}
