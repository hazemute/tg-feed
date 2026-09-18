import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  amountKop: z.coerce.number().int().min(10_000).max(5_000_000), // 100 ₽ … 50 000 ₽
})

/**
 * POST /api/payments { amountKop } — ЗАГОТОВКА эквайринга ЮKassa.
 *
 * Создаёт PendingPayment и возвращает confirmationUrl: null — когда ЮKassa
 * будет подключена (env YOOKASSA_SHOP_ID + YOOKASSA_SECRET_KEY), здесь
 * добавится вызов https://api.yookassa.ru/v3/payments и возврат реальной
 * ссылки на оплату; статус поведёт вебхук (pending → succeeded), после чего
 * баланс рекламодателя пополнится на amountKop.
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

    /* TODO(ЮKassa): когда появятся YOOKASSA_SHOP_ID/YOOKASSA_SECRET_KEY —
       создать платёж в API ЮKassa, записать providerPaymentId + confirmationUrl
       и вернуть её. Пока честная заготовка: платёж сохранён, оплаты ждёт. */
    const payment = await db.pendingPayment.create({
      data: { userId: g.uid, amountKop, provider: 'yookassa' },
      select: { id: true, amountKop: true, status: true, createdAt: true },
    })

    return NextResponse.json({
      ok: true,
      paymentId: payment.id,
      amountKop: payment.amountKop,
      status: payment.status,
      confirmationUrl: null as string | null,
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
      where: { userId: g.uid },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, amountKop: true, status: true, createdAt: true },
    })
    return NextResponse.json({ items })
  } catch (e) {
    console.error('[payments:list]', e)
    return err('Не удалось загрузить платежи', 500)
  }
}
