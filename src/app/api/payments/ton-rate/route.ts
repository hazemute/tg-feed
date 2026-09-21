import { NextResponse } from 'next/server'
import { guardAuth } from '@/lib/guard'
import { getTonRubRate } from '@/lib/ton-rate'

export const dynamic = 'force-dynamic'

/**
 * GET /api/payments/ton-rate — текущий курс TON→RUB для превью-эквивалентов
 * в паках вкладки TON (сколько ≈ TON стоит выбранный пакет свайпов).
 * Лёгкий: курс кэшируется в памяти на 10 минут; при ошибке клиент просто
 * скрывает TON-эквиваленты и показывает только рубли.
 */
export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 30, windowMs: 60_000, bucket: 'ton-rate' })
  if (!g.ok) return g.res
  try {
    const rate = await getTonRubRate()
    return NextResponse.json({ ok: true, rub: rate.rub })
  } catch {
    return NextResponse.json({ ok: false, rub: null })
  }
}
