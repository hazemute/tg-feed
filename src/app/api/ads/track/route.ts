import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardPublic } from '@/lib/guard'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  adId: z.string().min(1).max(64),
  type: z.enum(['impression', 'click']),
})

/**
 * POST /api/ads/track { adId, type: 'impression' | 'click' }
 *
 * Учёт показов и кликов рекламы — фундамент ценности площадки для
 * рекламодателя: он платит за измеримые показы, а CTR виден в панели.
 * Счётчики увеличиваются атомарно (Ad — за всё время, AdStat — по дням).
 * Публичный эндпоинт без сессии: impression срабатывает при появлении
 * карточки в вьюпорте до любого взаимодействия; жёсткий лимит 240/мин/IP.
 */
export async function POST(request: Request) {
  const g = guardPublic(request, { limit: 240, windowMs: 60_000, bucket: 'ads-track' })
  if (!g.ok) return g.res

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('adId and type required')
    const { adId, type } = parsed.data
    const day = new Date().toISOString().slice(0, 10)
    const isClick = type === 'click'

    // если реклама не существует/удалена — updateMany вернёт 0 и AdStat не пишется
    const updated = await db.ad.updateMany({
      where: { id: adId },
      data: isClick ? { clicks: { increment: 1 } } : { impressions: { increment: 1 } },
    })
    if (updated.count === 0) return NextResponse.json({ ok: true, tracked: false })

    await db.adStat.upsert({
      where: { adId_day: { adId, day } },
      create: { adId, day, impressions: isClick ? 0 : 1, clicks: isClick ? 1 : 0 },
      update: isClick ? { clicks: { increment: 1 } } : { impressions: { increment: 1 } },
    })

    return NextResponse.json({ ok: true, tracked: true })
  } catch (e) {
    console.error('[ads/track]', e)
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
