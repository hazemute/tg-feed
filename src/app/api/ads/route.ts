import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { guardPublic } from '@/lib/guard'
import { cacheAside, famKey, shortHash } from '@/lib/redis'
import type { AdDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

/**
 * GET /api/ads — активные рекламные карточки (каждый 10-й пост в ленте).
 * Ротация: порядок перемешивается раз в 20 секунд — одна и та же реклама
 * не приедается, а показы распределяются между активными кампаниями
 * (для рекламодателя это честные показы, а не «кто первый создал»).
 * Публичные данные, лимит 120 запросов в минуту.
 */
export async function GET(request: Request) {
  const g = guardPublic(request, { limit: 120, windowMs: 60_000, bucket: 'ads' })
  if (!g.ok) return g.res

  try
  {
    const load = async (): Promise<{ items: AdDTO[] }> => {
      const ads = await db.ad.findMany({
        where: { isActive: true },
        select: { id: true, title: true, body: true, ctaLabel: true, link: true, imageUrl: true },
        take: 8,
      })
      // детерминированная ротация по 20-секундному окну: SSR/клиент и все
      // инстансы видят одинаковый порядок внутри окна
      const slot = Math.floor(Date.now() / 20_000)
      let seed = slot
      const shuffled = [...ads]
      for (let i = shuffled.length - 1; i > 0; i--) {
        seed = (seed * 1103515245 + 12345) >>> 0
        const j = seed % (i + 1)
        ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
      }
      const items: AdDTO[] = shuffled.map((a) => ({
        id: a.id,
        title: a.title,
        body: a.body,
        ctaLabel: a.ctaLabel,
        link: a.link,
        imageUrl: a.imageUrl,
      }))
      return { items }
    }

    const key = await famKey('ct', `ads:${shortHash('v2')}`)
    const data = await cacheAside({ key, ttlSec: 20, memoryTtlMs: 5000, fetcher: load })
    return NextResponse.json(data)
  } catch (e) {
    console.error('[ads]', e)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
