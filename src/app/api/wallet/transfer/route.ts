import { NextResponse } from 'next/server'
import { z } from 'zod'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { transferFunds } from '@/lib/wallet-accounts'
import { cacheBalance } from '@/lib/balance-cache'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * POST /api/wallet/transfer — перевод между счетами (v5.77).
 * body: { to, amount, currency: 'swp' | 'rub', note? }
 *   • to       — адрес счёта (SWP-XXXX-XXXX / RUB-XXXX-XXXX) или @username
 *   • amount   — целое: свайпы (swp) или КОПЕЙКИ (rub)
 * Атомарно, без комиссии. Свои два счёта: для конвертации — «Обменять»
 * (POST /api/wallet), перевод своему адресу тоже работает.
 */
const bodySchema = z.object({
  to: z.string().trim().min(3).max(80),
  amount: z.coerce.number().int().min(1).max(100_000_000),
  currency: z.enum(['swp', 'rub']),
  note: z.string().trim().max(140).optional(),
})

export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 20, windowMs: 60_000, bucket: 'wallet-transfer' })
  if (!g.ok) return g.res

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('Неверные данные перевода')
    const { to, amount, currency, note } = parsed.data

    const res = await transferFunds(g.uid, { to, amount, currency, note })
    if (!res.ok) return err(res.error, 402)

    // свежий баланс отправителя → Redis (edge-роут читает отсюда)
    const user = await db.user.findUnique({
      where: { id: g.uid },
      select: { balanceKop: true, swipes: true },
    })
    if (user) void cacheBalance(g.uid, { balanceKop: user.balanceKop, swipes: user.swipes })

    return NextResponse.json({
      ok: true,
      amount: res.amount,
      currency: res.currency,
      toLabel: res.toLabel,
      balanceKop: user?.balanceKop ?? 0,
      swipes: user?.swipes ?? 0,
    })
  } catch (e) {
    console.error('[wallet/transfer]', e)
    return err('Ошибка перевода', 500)
  }
}
