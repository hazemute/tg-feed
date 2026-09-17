import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { guardPublic } from '@/lib/guard'
import { cacheAside, famKey, shortHash } from '@/lib/redis'
import type { AdDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

/**
 * GET /api/ads — рекламные карточки (каждый 10-й пост в ленте).
 *
 * Источники:
 *  - Ad — классические кампании админки;
 *  - AdCampaign — CPA-кампании пользователей: крутятся, пока status=active
 *    и spentKop < budgetKop (деньги внесены заранее — эскроу), за уникальный
 *    переход списывается costPerClickKop.
 *
 * Ротация: порядок перемешивается раз в 20 секунд — показы распределяются
 * между кампаниями честно. Публичные данные, лимит 120 запросов в минуту.
 */
export async function GET(request: Request) {
  const g = guardPublic(request, { limit: 120, windowMs: 60_000, bucket: 'ads' })
  if (!g.ok) return g.res

  try {
    const load = async (): Promise<{ items: AdDTO[] }> => {
      const [ads, campaigns] = await Promise.all([
        db.ad.findMany({
          where: { isActive: true },
          select: { id: true, title: true, body: true, ctaLabel: true, link: true, imageUrl: true },
          take: 6,
        }),
        db.adCampaign.findMany({
          where: { status: 'active' },
          select: {
            id: true,
            title: true,
            body: true,
            ctaLabel: true,
            link: true,
            imageUrl: true,
            budgetKop: true,
            spentKop: true,
          },
          take: 12,
        }),
      ])

      // CPA-кампания активна, пока не израсходован внесённый бюджет
      const paid = campaigns
        .filter((c) => c.spentKop < c.budgetKop)
        .map<AdDTO>((c) => ({
          id: c.id,
          kind: 'campaign',
          title: c.title,
          body: c.body,
          ctaLabel: c.ctaLabel,
          link: c.link,
          imageUrl: c.imageUrl,
        }))

      const classic: AdDTO[] = ads.map((a) => ({ ...a, kind: 'ad' }))

      // детерминированная ротация по 20-секундному окну: SSR/клиент и все
      // инстансы видят одинаковый порядок внутри окна
      const all = [...classic, ...paid]
      let seed = Math.floor(Date.now() / 20_000)
      for (let i = all.length - 1; i > 0; i--) {
        seed = (seed * 1103515245 + 12345) >>> 0
        const j = seed % (i + 1)
        ;[all[i], all[j]] = [all[j], all[i]]
      }
      return { items: all.slice(0, 10) }
    }

    const key = await famKey('ct', `ads:${shortHash('v3')}`)
    const data = await cacheAside({ key, ttlSec: 20, memoryTtlMs: 5000, fetcher: load })
    return NextResponse.json(data)
  } catch (e) {
    console.error('[ads]', e)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
