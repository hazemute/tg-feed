import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { paymentMethods } from '@/lib/payments'
import { yookassaCreatePayment } from '@/lib/yookassa'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  amountKop: z.coerce.number().int().min(10_000).max(5_000_000), // 100 ₽ … 50 000 ₽
})

/**
 * POST /api/payments { amountKop } — пополнение картой (эквайринг ЮKassa).
 *
 * Ключи не настроены → честная 503 «метод скоро»: UI показывает только
 * рабочие способы (Telegram Stars / TON). Когда заданы YOOKASSA_SHOP_ID +
 * YOOKASSA_SECRET_KEY, здесь создаётся платёж в API ЮKassa с embedded-подтверждением
 * и возвращается confirmation_token: фронт рисует платёжную форму виджетом ЮKassa
 * ПРЯМО НА САЙТЕ (без переадресаций — требование СБ ЮKassa). Статус поведёт вебхук
 * (pending → succeeded), после чего баланс рекламодателя пополнится на amountKop.
 *
 * GET /api/payments — история платежей пользователя.
 */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 10, windowMs: 60_000, bucket: 'payments' })
  if (!g.ok) return g.res

  try {
    const parsed = createSchema.safeParse(await readJson(request))
    if (!parsed.success) return err('Сумма: от 100 ₽ до 50 000 ₽')
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

    /* Платёж в ЮKassa: embedded-подтверждение → виджет НА САЙТЕ (без переадресаций, требование СБ) */
    const yk = await yookassaCreatePayment({
      amountKop,
      description: 'Пополнение рублёвого баланса Tg Swipe',
      paymentId: payment.id,
    })
    if (!yk || !yk.confirmationToken) {
      console.error('[payments:create] yookassa failed')
      await db.pendingPayment.updateMany({
        where: { id: payment.id, status: 'pending' },
        data: { status: 'canceled' },
      })
      return err('Эквайринг не ответил — попробуйте ещё раз', 502)
    }

    await db.pendingPayment.update({
      where: { id: payment.id },
      data: { providerPaymentId: yk.id, confirmationUrl: yk.confirmationUrl },
    })

    return NextResponse.json({
      ok: true,
      paymentId: payment.id,
      amountKop: payment.amountKop,
      status: payment.status,
      confirmationToken: yk.confirmationToken,
      // legacy: раньше был redirect; оставляем поле пустым для совместимости
      confirmationUrl: null,
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
