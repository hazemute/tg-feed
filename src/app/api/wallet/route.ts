import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import {
  AI_COST_SWIPES,
  SWP_PER_RUB,
  SWP_CONVERT_MIN,
  convertRubToSwp,
  convertSwpToRub,
  walletHistory,
} from '@/lib/wallet'

export const dynamic = 'force-dynamic'

/**
 * GET /api/wallet — кошелёк: рубли (balanceKop), свайпы, курс, журнал (20 последних).
 * POST /api/wallet { action: 'swp2rub' | 'rub2swp', amount } — конвертация.
 *   • swp2rub: amount в свайпах (≥100) → рубли по курсу 100 свайпов = 1 ₽,
 *     остаток < 100 остаётся свайпами;
 *   • rub2swp: amount в КОПЕЙКАХ (1 копейка = 1 свайп) → свайпы.
 */

const postSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('swp2rub'),
    amount: z.coerce.number().int().min(SWP_CONVERT_MIN).max(10_000_000),
  }),
  z.object({
    action: z.literal('rub2swp'),
    amount: z.coerce.number().int().min(1).max(5_000_000), // копейки
  }),
])

export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'wallet-get' })
  if (!g.ok) return g.res

  try {
    const user = await db.user.findUnique({
      where: { id: g.uid },
      select: { balanceKop: true, swipes: true },
    })
    if (!user) return err('Пользователь не найден', 404)
    const history = await walletHistory(g.uid, 20)
    return NextResponse.json({
      ok: true,
      balanceKop: user.balanceKop,
      swipes: user.swipes,
      swpPerRub: SWP_PER_RUB,
      aiCostSwipes: AI_COST_SWIPES,
      swpConvertMin: SWP_CONVERT_MIN,
      history,
    })
  } catch (e) {
    console.error('[wallet GET]', e)
    return err('Ошибка кошелька', 500)
  }
}

export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 20, windowMs: 60_000, bucket: 'wallet-post' })
  if (!g.ok) return g.res

  try {
    const parsed = postSchema.safeParse(await readJson(request))
    if (!parsed.success) return err('Неверная сумма конвертации')
    const { action, amount } = parsed.data

    const res = action === 'swp2rub' ? await convertSwpToRub(g.uid, amount) : await convertRubToSwp(g.uid, amount)
    if (!res.ok) return err(res.error ?? 'Конвертация не удалась', 402)

    const user = await db.user.findUnique({
      where: { id: g.uid },
      select: { balanceKop: true, swipes: true },
    })
    return NextResponse.json({
      ok: true,
      balanceKop: user?.balanceKop ?? 0,
      swipes: user?.swipes ?? 0,
      ...(res as { rubKop?: number; swipes?: number }),
    })
  } catch (e) {
    console.error('[wallet POST]', e)
    return err('Ошибка конвертации', 500)
  }
}
