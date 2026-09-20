import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { invalidateBalance } from '@/lib/balance-cache'

export const dynamic = 'force-dynamic'

/**
 * CPA-кампании пользователя («Мой канал» → Реклама).
 *
 * МОДЕЛЬ (v5.39): бюджет кампании резервируется с ОБЩЕГО рублёвого кошелька
 * (User.balanceKop) сразу при создании — проводка kind='ad_campaign' в
 * BalanceLog. Дальше кампания крутится бесплатно для площадки: каждый
 * уникальный переход списывает стоимость клика из внесённого бюджета.
 * Отмена — возврат неизрасходованного остатка на кошелёк (kind='refund').
 * Долгов нет по построению; эскроу-счёт рекламодателя (AdvertiserAccount)
 * выведен из оборота — старые итоги читаются только как легаси-статистика.
 */

const createSchema = z.object({
  channelId: z.string().max(64).optional(),
  title: z.string().trim().min(4).max(80),
  body: z.string().trim().min(4).max(200),
  ctaLabel: z.string().trim().max(24).default('Подписаться'),
  link: z.string().trim().url().max(300),
  imageUrl: z.string().trim().url().max(300).optional().or(z.literal('')),
  costPerClickKop: z.number().int().min(100).max(10_000), // 1₽…100₽ за переход
  budgetKop: z.number().int().min(5_000).max(5_000_000), // 50₽…50 000₽
})

const patchSchema = z.object({
  id: z.string().min(1),
  action: z.enum(['pause', 'resume', 'cancel']),
})

/** GET — мои кампании + баланс кошелька (легаси-итоги эскроу — только статистика) */
export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'campaigns' })
  if (!g.ok) return g.res

  const [campaigns, user, account] = await Promise.all([
    db.adCampaign.findMany({
      where: { ownerId: g.uid },
      orderBy: { createdAt: 'desc' },
      take: 30,
    }),
    db.user.findUnique({ where: { id: g.uid }, select: { balanceKop: true } }),
    db.advertiserAccount
      .findUnique({
        where: { userId: g.uid },
        select: { topupsTotalKop: true, spentTotalKop: true },
      })
      .catch(() => null),
  ])

  return NextResponse.json({
    campaigns: campaigns.map((c) => ({
      id: c.id,
      title: c.title,
      body: c.body,
      ctaLabel: c.ctaLabel,
      link: c.link,
      imageUrl: c.imageUrl,
      costPerClickKop: c.costPerClickKop,
      budgetKop: c.budgetKop,
      spentKop: c.spentKop,
      impressions: c.impressions,
      clicks: c.clicks,
      rawClicks: c.rawClicks,
      status: c.status,
      note: c.note,
      createdAt: c.createdAt.toISOString(),
    })),
    advertiser: {
      // v5.39: реальный баланс — рублёвый кошелёк пользователя
      balanceKop: user?.balanceKop ?? 0,
      topupsTotalKop: account?.topupsTotalKop ?? 0,
      spentTotalKop: account?.spentTotalKop ?? 0,
    },
  })
}

/** POST — создать кампанию (бюджет резервируется с баланса сразу) */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 10, windowMs: 60_000, bucket: 'campaigns-create' })
  if (!g.ok) return g.res

  try {
    const parsed = createSchema.safeParse(await readJson(request))
    if (!parsed.success) return err('Проверьте поля кампании (заголовок, текст, ссылка, цены)')
    const d = parsed.data
    if (d.budgetKop < d.costPerClickKop * 10) {
      return err('Бюджет должен покрывать минимум 10 переходов')
    }

    // атомарное резервирование с ОБЩЕГО кошелька: списываем бюджет только если он есть
    const reserved = await db.$transaction(async (tx) => {
      const updated = await tx.user.updateMany({
        where: { id: g.uid, balanceKop: { gte: d.budgetKop } },
        data: { balanceKop: { decrement: d.budgetKop } },
      })
      if (updated.count === 0) return false
      await tx.balanceLog.create({
        data: {
          userId: g.uid,
          kind: 'ad_campaign',
          currency: 'rub',
          amount: -d.budgetKop,
          note: `бюджет кампании «${d.title.slice(0, 40)}»`,
        },
      })
      return true
    })
    if (!reserved) {
      return err('Недостаточно средств на балансе — пополните кошелёк в профиле', 402)
    }
    await invalidateBalance(g.uid)

    try {
      const campaign = await db.adCampaign.create({
        data: {
          ownerId: g.uid,
          channelId: d.channelId || null,
          title: d.title,
          body: d.body,
          ctaLabel: d.ctaLabel || 'Подписаться',
          link: d.link,
          imageUrl: d.imageUrl || null,
          costPerClickKop: d.costPerClickKop,
          budgetKop: d.budgetKop,
          status: 'moderation',
        },
      })
      return NextResponse.json({ ok: true, id: campaign.id })
    } catch {
      // кампания не создалась — возвращаем зарезервированные деньги в кошелёк
      await db
        .$transaction([
          db.user.update({ where: { id: g.uid }, data: { balanceKop: { increment: d.budgetKop } } }),
          db.balanceLog.create({
            data: {
              userId: g.uid,
              kind: 'refund',
              currency: 'rub',
              amount: d.budgetKop,
              note: 'возврат: кампания не создалась',
            },
          }),
        ])
        .catch(() => {})
      await invalidateBalance(g.uid)
      return err('Не удалось создать кампанию')
    }
  } catch (e) {
    console.error('[campaigns:create]', e)
    return err('Ошибка создания кампании', 500)
  }
}

/** PATCH — пауза / возобновление / отмена (с возвратом неизрасходованного) */
export async function PATCH(request: Request) {
  const g = guardAuth(request, { limit: 20, windowMs: 60_000, bucket: 'campaigns-patch' })
  if (!g.ok) return g.res

  try {
    const parsed = patchSchema.safeParse(await readJson(request))
    if (!parsed.success) return err('id и action обязательны')
    const { id, action } = parsed.data

    const campaign = await db.adCampaign.findUnique({ where: { id } })
    if (!campaign || campaign.ownerId !== g.uid) return err('Кампания не найдена', 404)

    if (action === 'pause') {
      if (campaign.status !== 'active') return err('Приостановить можно только активную кампанию')
      await db.adCampaign.update({ where: { id }, data: { status: 'paused' } })
      return NextResponse.json({ ok: true, status: 'paused' })
    }

    if (action === 'resume') {
      if (campaign.status !== 'paused') return err('Возобновить можно только приостановленную')
      if (campaign.spentKop >= campaign.budgetKop) return err('Бюджет кампании исчерпан')
      await db.adCampaign.update({ where: { id }, data: { status: 'active' } })
      return NextResponse.json({ ok: true, status: 'active' })
    }

    // cancel: возврат остатка бюджета в кошелёк + завершение
    if (campaign.status === 'completed') return err('Кампания уже завершена')
    const refund = Math.max(0, campaign.budgetKop - campaign.spentKop)
    await db.$transaction([
      db.adCampaign.update({
        where: { id },
        data: { status: 'completed', completedAt: new Date() },
      }),
      ...(refund > 0
        ? [
            db.user.update({
              where: { id: g.uid },
              data: { balanceKop: { increment: refund } },
            }),
            db.balanceLog.create({
              data: {
                userId: g.uid,
                kind: 'refund',
                currency: 'rub',
                amount: refund,
                note: `возврат остатка кампании «${campaign.title.slice(0, 40)}»`,
              },
            }),
          ]
        : []),
    ])
    await invalidateBalance(g.uid)
    return NextResponse.json({ ok: true, status: 'completed', refundKop: refund })
  } catch (e) {
    console.error('[campaigns:patch]', e)
    return err('Ошибка', 500)
  }
}
