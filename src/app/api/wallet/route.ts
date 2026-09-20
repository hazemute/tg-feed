import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import {
  AI_MTOK_IN_SWP,
  AI_MTOK_OUT_SWP,
  SWP_PER_RUB,
  SWP_CONVERT_MIN,
  convertRubToSwp,
  convertSwpToRub,
  walletHistory,
} from '@/lib/wallet'
import { cacheBalance } from '@/lib/balance-cache'

export const dynamic = 'force-dynamic'

/**
 * GET /api/wallet — кошелёк: рубли (balanceKop), свайпы, курс, тариф ИИ, журнал (20 последних).
 *   Баланс дополнительно пишется в Redis-кэш (write-through) — его читает
 *   edge-роут GET /api/wallet/balance без обращения к БД.
 * POST /api/wallet { action: 'swp2rub' | 'rub2swp', amount } — конвертация.
 *   • swp2rub: amount в свайпах (≥500) → рубли по курсу 500 свайпов = 1 ₽,
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
    // Write-through: свежий баланс → Redis (горячий путь edge-роута /api/wallet/balance)
    void cacheBalance(g.uid, { balanceKop: user.balanceKop, swipes: user.swipes })
    const history = await walletHistory(g.uid, 20)
    return NextResponse.json({
      ok: true,
      balanceKop: user.balanceKop,
      swipes: user.swipes,
      swpPerRub: SWP_PER_RUB,
      // Тариф нейросетей (v5.39): списание по токенам OpenRouter за 1 млн in/out
      aiPricing: { inSwpPerMtok: AI_MTOK_IN_SWP, outSwpPerMtok: AI_MTOK_OUT_SWP },
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
    if (user) void cacheBalance(g.uid, { balanceKop: user.balanceKop, swipes: user.swipes })
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
