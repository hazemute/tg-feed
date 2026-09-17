import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { guardPublic } from '@/lib/guard'
import { cacheAside, famKey, shortHash } from '@/lib/redis'
import { runParser } from '@/lib/parse-engine'
import { isValidChannelUsername } from '@/lib/server'
import type { AdDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

/**
 * Самонастройка спонсорских каналов: у активной CPA-кампании без channelId,
 * но со ссылкой t.me/<username>, канал создаётся и ОДИН раз парсится — его
 * посты начинают крутиться в первых рядах ленты (см. /api/feed, спонсорский
 * инжект). Запускается в фоне, один раз на кампанию (lock по id).
 */
const ensureLock = new Set<string>()
async function ensureCampaignChannels(): Promise<void> {
  const campaigns = await db.adCampaign
    .findMany({
      where: { status: 'active', channelId: null },
      select: { id: true, link: true },
      take: 10,
    })
    .catch(() => [])
  for (const c of campaigns) {
    if (ensureLock.has(c.id)) continue
    const m = c.link.match(/^https?:\/\/t\.me\/([A-Za-z0-9_]{4,32})\/?$/)
    if (!m) continue
    const username = m[1]
    if (!isValidChannelUsername(username)) continue
    ensureLock.add(c.id)
    void (async () => {
      try {
        let channel = await db.channel.findUnique({ where: { username } })
        if (!channel) {
          const other = await db.category.findUnique({ where: { slug: 'other' } })
          if (!other) return
          channel = await db.channel.create({
            data: {
              tgId: `ad_${username}`,
              title: username,
              username,
              categoryId: other.id,
              status: 'active',
            },
          })
        }
        await db.adCampaign.update({ where: { id: c.id }, data: { channelId: channel.id } })
        // посты спонсора — одним лёгким прогоном (5 постов)
        await runParser(5, username)
      } catch {
        ensureLock.delete(c.id) // следующая попытка — при следующем запросе /api/ads
      }
    })()
  }
}

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

  // фоновая самонастройка спонсорских каналов (не блокирует ответ)
  void ensureCampaignChannels()

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
