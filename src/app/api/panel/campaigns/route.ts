import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * Панель: модерация CPA-кампаний и пополнение рекламных балансов.
 * Пополнение — ручная операция после оплаты переводом (СБП): админ
 * зачисляет сумму на эскроу-счёт рекламодателя, тот уже не может
 * «не оплатить» — кампания списывает бюджет сама за переходы.
 */

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), campaignId: z.string().min(1) }),
  z.object({
    action: z.literal('reject'),
    campaignId: z.string().min(1),
    note: z.string().trim().max(200).optional(),
  }),
  z.object({ action: z.literal('pause'), campaignId: z.string().min(1) }),
  z.object({
    action: z.literal('topup'),
    userId: z.string().min(1),
    amountKop: z.number().int().min(1000).max(5_000_000),
  }),
])

/** GET — все кампании + последние рекламные счета */
export async function GET(request: Request) {
  const g = guardAdmin(request, { limit: 60, windowMs: 60_000, bucket: 'panel-campaigns' })
  if (!g.ok) return g.res

  const [campaigns, accounts] = await Promise.all([
    db.adCampaign.findMany({
      orderBy: { createdAt: 'desc' },
      take: 60,
      include: { owner: { select: { username: true, firstName: true } } },
    }),
    db.advertiserAccount.findMany({ take: 50, orderBy: { updatedAt: 'desc' } }),
  ])

  return NextResponse.json({
    campaigns: campaigns.map((c) => ({
      id: c.id,
      title: c.title,
      body: c.body,
      ctaLabel: c.ctaLabel,
      link: c.link,
      costPerClickKop: c.costPerClickKop,
      budgetKop: c.budgetKop,
      spentKop: c.spentKop,
      impressions: c.impressions,
      clicks: c.clicks,
      status: c.status,
      note: c.note,
      createdAt: c.createdAt.toISOString(),
      owner: c.owner?.username ?? c.owner?.firstName ?? c.ownerId,
    })),
    accounts: accounts.map((a) => ({
      userId: a.userId,
      balanceKop: a.balanceKop,
      topupsTotalKop: a.topupsTotalKop,
      spentTotalKop: a.spentTotalKop,
    })),
  })
}

export async function POST(request: Request) {
  const g = guardAdmin(request, { limit: 30, windowMs: 60_000, bucket: 'panel-campaigns-post' })
  if (!g.ok) return g.res

  try {
    const parsed = schema.safeParse(await readJson(request))
    if (!parsed.success) return err('Некорректное действие')
    const d = parsed.data

    if (d.action === 'topup') {
      const account = await db.advertiserAccount.upsert({
        where: { userId: d.userId },
        create: {
          userId: d.userId,
          balanceKop: d.amountKop,
          topupsTotalKop: d.amountKop,
        },
        update: {
          balanceKop: { increment: d.amountKop },
          topupsTotalKop: { increment: d.amountKop },
        },
      })
      return NextResponse.json({ ok: true, balanceKop: account.balanceKop })
    }

    const campaign = await db.adCampaign.findUnique({ where: { id: d.campaignId } })
    if (!campaign) return err('Кампания не найдена', 404)

    if (d.action === 'approve') {
      if (campaign.status !== 'moderation') return err('Кампания уже обработана')
      if (campaign.budgetKop <= campaign.spentKop) {
        return err('Бюджет кампании пуст — одобрение невозможно')
      }
      await db.adCampaign.update({
        where: { id: campaign.id },
        data: { status: 'active', startedAt: new Date(), note: null },
      })
      return NextResponse.json({ ok: true, status: 'active' })
    }

    if (d.action === 'pause') {
      await db.adCampaign.update({
        where: { id: campaign.id },
        data: { status: 'paused' },
      })
      return NextResponse.json({ ok: true, status: 'paused' })
    }

    // reject: остаток бюджета возвращается на баланс рекламодателя
    const refund = Math.max(0, campaign.budgetKop - campaign.spentKop)
    await db.$transaction([
      db.adCampaign.update({
        where: { id: campaign.id },
        data: { status: 'rejected', note: d.note ?? null, completedAt: new Date() },
      }),
      ...(refund > 0
        ? [
            db.advertiserAccount.update({
              where: { userId: campaign.ownerId },
              data: { balanceKop: { increment: refund } },
            }),
          ]
        : []),
    ])
    return NextResponse.json({ ok: true, status: 'rejected', refundKop: refund })
  } catch (e) {
    console.error('[panel/campaigns]', e)
    return err('Ошибка', 500)
  }
}
