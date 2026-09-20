import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'
import { invalidateBalance } from '@/lib/balance-cache'
import { logAdmin } from '@/lib/admin-log'

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

/** Уведомление рекламодателю о судьбе его кампании (инбокс «Активность») */
function notifyCampaignOwner(
  ownerId: string,
  title: string,
  status: 'approved' | 'paused' | 'rejected',
  note?: string | null,
) {
  const headline =
    status === 'approved'
      ? `Кампания «${title}» одобрена`
      : status === 'paused'
        ? `Кампания «${title}» приостановлена`
        : `Кампания «${title}» отклонена`
  void db.notification
    .create({
      data: {
        userId: ownerId,
        type: 'campaign',
        title: headline,
        body: note ? note.slice(0, 200) : null,
      },
    })
    .catch((e: unknown) => console.error('[campaigns notify]', e))
}

/** GET — все кампании + последние рекламные счета */
export async function GET(request: Request) {
  const g = guardAdmin(request, { limit: 60, windowMs: 60_000, bucket: 'panel-campaigns' })
  if (!g.ok) return g.res

  // v5.48: try/catch — сбой БД раньше давал 500 без единой строки в логе
  try {
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
  } catch (e) {
    console.error('[panel/campaigns:get]', e)
    return err('Не удалось загрузить кампании', 500)
  }
}

export async function POST(request: Request) {
  const g = guardAdmin(request, { limit: 30, windowMs: 60_000, bucket: 'panel-campaigns-post' })
  if (!g.ok) return g.res

  try {
    const parsed = schema.safeParse(await readJson(request))
    if (!parsed.success) return err('Некорректное действие')
    const d = parsed.data

    if (d.action === 'topup') {
      // v5.54: зачисляем на НАСТОЯЩИЙ кошелёк (User.balanceKop) — раньше деньги
      // уходили в выведенную из оборота легаси-таблицу AdvertiserAccount и
      // «исчезали»: в кошельке их не было, кампанию создать было нельзя.
      const user = await db.user.findUnique({ where: { id: d.userId }, select: { balanceKop: true } })
      if (!user) return err('Пользователь не найден', 404)
      const updated = await db.user.update({
        where: { id: d.userId },
        data: { balanceKop: { increment: d.amountKop } },
        select: { balanceKop: true },
      })
      await db.balanceLog
        .create({
          data: {
            userId: d.userId,
            kind: 'topup',
            currency: 'rub',
            amount: d.amountKop,
            note: 'Пополнение администратором (СБП/перевод)',
          },
        })
        .catch(() => {})
      await invalidateBalance(d.userId).catch(() => {})
      await logAdmin('campaign_topup', d.userId, { amountKop: d.amountKop })
      return NextResponse.json({ ok: true, balanceKop: updated.balanceKop })
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
      notifyCampaignOwner(campaign.ownerId, campaign.title, 'approved')
      return NextResponse.json({ ok: true, status: 'active' })
    }

    if (d.action === 'pause') {
      await db.adCampaign.update({
        where: { id: campaign.id },
        data: { status: 'paused' },
      })
      notifyCampaignOwner(campaign.ownerId, campaign.title, 'paused')
      return NextResponse.json({ ok: true, status: 'paused' })
    }

    // reject: остаток бюджета возвращается на баланс рекламодателя
    // (v5.54: в User.balanceKop — реальный кошелёк, не легаси-таблицу)
    const refund = Math.max(0, campaign.budgetKop - campaign.spentKop)
    await db.$transaction([
      db.adCampaign.update({
        where: { id: campaign.id },
        data: { status: 'rejected', note: d.note ?? null, completedAt: new Date() },
      }),
      ...(refund > 0
        ? [
            db.user.update({
              where: { id: campaign.ownerId },
              data: { balanceKop: { increment: refund } },
            }),
            db.balanceLog.create({
              data: {
                userId: campaign.ownerId,
                kind: 'refund',
                currency: 'rub',
                amount: refund,
                note: `Возврат остатка бюджета — кампания «${campaign.title}» отклонена`,
              },
            }),
          ]
        : []),
    ])
    if (refund > 0) await invalidateBalance(campaign.ownerId).catch(() => {})
    notifyCampaignOwner(campaign.ownerId, campaign.title, 'rejected', d.note ?? null)
    return NextResponse.json({ ok: true, status: 'rejected', refundKop: refund })
  } catch (e) {
    console.error('[panel/campaigns]', e)
    return err('Ошибка', 500)
  }
}
