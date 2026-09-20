import { NextResponse } from 'next/server'
import { bearerToken, verifySessionEdge } from '@/lib/session-edge'
import { readCachedBalance } from '@/lib/balance-cache'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

/**
 * GET /api/wallet/balance — БАЛАНС КОШЕЛЬКА НА EDGE (v5.39).
 *
 * Главный «чит-код» масштабирования: роут живёт в Vercel Edge Functions
 * (по всему миру, в т.ч. Франкфурт/Стокгольм рядом с СНГ) и читает баланс
 * ИСКЛЮЧИТЕЛЬНО из Redis по Upstash REST — ноль обращений к PostgreSQL,
 * латентность в единицы миллисекунд. Десятки тысяч одновременных проверок
 * баланса (например, после конкурса) не трогают Supabase вовсе.
 *
 * Схема данных:
 *   • ключ bal:{uid} заполняет GET /api/wallet (Node, write-through) после
 *     любой операции кошелька; TTL 120с;
 *   • любые списания/конвертации/покупки инвалидируют ключ мгновенно.
 * Если кэш холодный — отдаём { ok:false, cached:false } и клиент добирает
 * полным /api/wallet (Node + Prisma + БД), который снова прогреет кэш.
 *
 * Rate limit: общий middleware (edge) считает запросы как и для всего /api/*.
 */

export async function GET(request: Request) {
  const s = await verifySessionEdge(bearerToken(request))
  if (!s || s.guest) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const b = await readCachedBalance(s.uid)
  if (!b) {
    return NextResponse.json({ ok: false, cached: false })
  }

  return NextResponse.json({
    ok: true,
    cached: true,
    balanceKop: b.balanceKop,
    swipes: b.swipes,
    // v5.48: было 100 — расхождение с SWP_PER_RUB=500 (lib/wallet.ts) ломало
    // клиентскую конверсию в 5 раз. Константа продублирована литералом:
    // edge-роут не может импортировать lib/wallet (там Node-Prisma)
    swpPerRub: 500,
  })
}
