import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardPublic } from '@/lib/guard'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  adId: z.string().min(1).max(64),
  type: z.enum(['impression', 'click']),
  /** kind=client — CPA-кампания пользователя (биллинг за уникальный клик) */
  kind: z.enum(['ad', 'campaign']).default('ad'),
})

/**
 * POST /api/ads/track { adId, type, kind }
 *
 * Учёт показов и кликов. Для CPA-кампаний (kind='campaign') клик тарифицируется:
 *
 *  АНТИ-НАКРУТКА: оплачен только УНИКАЛЬНЫЙ клик пользователя на кампанию в сутки
 *  (CampaignClick: unique campaignId+userId, окно — календарный день UTC).
 *  Повторные тапы того же человека не списывают деньги рекламодателя.
 *
 *  АНТИ-НЕОПЛАТА: деньги внесены в кампанию заранее (эскроу AdvertiserAccount),
 *  каждый подтверждённый клик списывает costPerClickKop из бюджета кампании.
 *  Кампания крутится ровно до исчерпания бюджета — «не оплатить» невозможно.
 *
 * Публичный эндпоинт (impression до любого взаимодействия), лимит 240/мин/IP.
 */
export async function POST(request: Request) {
  const g = guardPublic(request, { limit: 240, windowMs: 60_000, bucket: 'ads-track' })
  if (!g.ok) return g.res

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('adId and type required')
    const { adId, type, kind } = parsed.data
    const isClick = type === 'click'

    if (kind === 'campaign') {
      return NextResponse.json(await trackCampaign(adId, isClick, g.uid))
    }

    const day = new Date().toISOString().slice(0, 10)
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

/** Уникальный клик пользователя на кампанию в текущем дне UTC? */
function sameDay(a: Date, dayStart: Date): boolean {
  return a.getTime() >= dayStart.getTime()
}

async function trackCampaign(campaignId: string, isClick: boolean, uid: string | null) {
  const campaign = await db.adCampaign.findUnique({ where: { id: campaignId } })
  if (!campaign || campaign.status !== 'active') {
    return { ok: true, tracked: false, billed: false }
  }
  const day = new Date().toISOString().slice(0, 10)
  const dayStart = new Date(`${day}T00:00:00.000Z`)

  if (!isClick) {
    await db.adCampaign.update({
      where: { id: campaignId },
      data: { impressions: { increment: 1 } },
    })
    await db.campaignStat.upsert({
      where: { campaignId_day: { campaignId, day } },
      create: { campaignId, day, impressions: 1 },
      update: { impressions: { increment: 1 } },
    })
    return { ok: true, tracked: true, billed: false }
  }

  /* ---------- КЛИК: анти-накрутка + биллинг ---------- */
  await db.adCampaign.update({ where: { id: campaignId }, data: { rawClicks: { increment: 1 } } })

  // без сессии клик не тарифицируется (защита от ботов)
  if (!uid) return { ok: true, tracked: true, billed: false }

  // одна тарификация на (кампания, пользователь) в сутки
  const existing = await db.campaignClick.findUnique({
    where: { campaignId_userId: { campaignId, userId: uid } },
  })
  let billed = false
  if (!existing) {
    // v5.48: billed=true ТОЛЬКО если create реально прошёл — раньше при гонке
    // (двойной клик) create падал по unique, но billed оставался true →
    // двойное списание за один клик
    const created = await db.campaignClick
      .create({ data: { campaignId, userId: uid, lastBilledAt: new Date(), billedCount: 1 } })
      .catch(() => null)
    billed = created !== null
  } else if (!sameDay(existing.lastBilledAt, dayStart)) {
    await db.campaignClick.update({
      where: { id: existing.id },
      data: { lastBilledAt: new Date(), billedCount: { increment: 1 } },
    })
    billed = true
  }

  if (!billed) return { ok: true, tracked: true, billed: false }

  // списание: не больше остатка бюджета (последний клик может списать меньше)
  const remaining = Math.max(0, campaign.budgetKop - campaign.spentKop)
  const charge = Math.min(campaign.costPerClickKop, remaining)
  if (charge <= 0) {
    // бюджет исчерпан между показом и кликом — закрываем кампанию
    await db.adCampaign
      .update({ where: { id: campaignId }, data: { status: 'completed', completedAt: new Date() } })
      .catch(() => {})
    return { ok: true, tracked: true, billed: false, completed: true }
  }

  // v5.48: АТОМАРНОЕ списание с условием — раньше spentKop читался вне
  // транзакции и параллельные клики считали remaining по устаревшему значению
  // → перерасход бюджета рекламодателя. Условие spentKop <= budget - charge
  // гарантирует: списание пройдёт только если бюджет реально хватает.
  const billedRows = await db.adCampaign.updateMany({
    where: {
      id: campaignId,
      status: 'active',
      spentKop: { lte: campaign.budgetKop - charge },
    },
    data: { spentKop: { increment: charge }, clicks: { increment: 1 } },
  })
  if (billedRows.count === 0) {
    // бюджет исчерпан в гонке / кампания уже закрыта — списания нет
    await db.adCampaign
      .updateMany({
        where: { id: campaignId, status: 'active', spentKop: { gte: campaign.budgetKop } },
        data: { status: 'completed', completedAt: new Date() },
      })
      .catch(() => {})
    return { ok: true, tracked: true, billed: false, completed: true }
  }
  // кампания исчерпана этим кликом — закрываем (дочитываем строку после инкремента)
  const after = await db.adCampaign
    .findUnique({ where: { id: campaignId }, select: { spentKop: true, budgetKop: true } })
    .catch(() => null)
  if (after && after.spentKop >= after.budgetKop) {
    await db.adCampaign
      .update({ where: { id: campaignId }, data: { status: 'completed', completedAt: new Date() } })
      .catch(() => {})
  }
  await db.advertiserAccount
    .update({
      where: { userId: campaign.ownerId },
      data: { spentTotalKop: { increment: charge } },
    })
    .catch(() => {})
  await db.campaignStat.upsert({
    where: { campaignId_day: { campaignId, day } },
    create: { campaignId, day, clicks: 1, spentKop: charge },
    update: { clicks: { increment: 1 }, spentKop: { increment: charge } },
  })

  return { ok: true, tracked: true, billed: true, charge }
}
