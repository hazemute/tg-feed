import { NextResponse } from 'next/server'
import { err } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { paymentMethods } from '@/lib/payments'

export const dynamic = 'force-dynamic'

/**
 * GET /api/payments/methods — какие способы пополнения доступны сейчас.
 * UI честно показывает только рабочие: Stars (бот), TON (адрес кошелька),
 * карта (ключи ЮKassa). Пользователь не видит «мёртвых» кнопок.
 */
export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'pay-methods' })
  if (!g.ok) return g.res
  return NextResponse.json({ ok: true, methods: paymentMethods() })
}
