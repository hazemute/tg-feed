import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { paymentMethods } from '@/lib/payments'

export const dynamic = 'force-dynamic'

/**
 * GET /api/payments — история платежей пользователя (вкл. доступные способы).
 *
 * v5.83: ЮKassa отключена полностью — POST-создание картой убрано, ВСЕ рублёвые
 * платежи идут через Platega: POST /api/payments/platega (пополнение баланса),
 * POST /api/tiers (тарифы) и POST /api/promote-pack (пакеты продвижений).
 */
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
