import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { guardPublic } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * GET /api/ads — активные рекламные карточки (каждый 10-й пост в ленте).
 * Публичные данные, лимит 120 запросов в минуту.
 */
export async function GET(request: Request) {
  const g = guardPublic(request, { limit: 120, windowMs: 60_000, bucket: 'ads' })
  if (!g.ok) return g.res

  try {
    const ads = await db.ad.findMany({ where: { isActive: true }, take: 5 })
    return NextResponse.json({ items: ads })
  } catch (e) {
    console.error('[ads]', e)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
