import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * CPA-кампании пользователя («Мой канал» → Реклама).
 *
 * Модель эскроу: бюджет кампании заранее снимается с баланса рекламодателя
 * (пополнение — после оплаты переводом, зачисляет админ). Дальше кампания
 * крутится бесплатно для площадки: каждый уникальный переход списывает
 * стоимость клика из внесённого бюджета. Долгов нет по построению.
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

/** GET — мои кампании + рекламный баланс */
export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'campaigns' })
  if (!g.ok) return g.res

  const [campaigns, account] = await Promise.all([
    db.adCampaign.findMany({
      where: { ownerId: g.uid },
      orderBy: { createdAt: 'desc' },
      take: 30,
    }),
    db.advertiserAccount.findUnique({ where: { userId: g.uid } }),
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
      balanceKop: account?.balanceKop ?? 0,
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

    // атомарное резервирование: списываем бюджет только если он есть
    await db.advertiserAccount.upsert({
      where: { userId: g.uid },
      create: { userId: g.uid },
      update: {},
    })
    const updated = await db.advertiserAccount.updateMany({
      where: { userId: g.uid, balanceKop: { gte: d.budgetKop } },
      data: { balanceKop: { decrement: d.budgetKop } },
    })
    if (updated.count === 0) {
      return err('Недостаточно средств на балансе — сначала пополните рекламный счёт')
    }

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
      // кампания не создалась — возвращаем зарезервированные деньги
      await db.advertiserAccount
        .update({ where: { userId: g.uid }, data: { balanceKop: { increment: d.budgetKop } } })
        .catch(() => {})
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

    // cancel: возврат остатка бюджета на баланс + завершение
    if (campaign.status === 'completed') return err('Кампания уже завершена')
    const refund = Math.max(0, campaign.budgetKop - campaign.spentKop)
    await db.$transaction([
      db.adCampaign.update({
        where: { id },
        data: { status: 'completed', completedAt: new Date() },
      }),
      ...(refund > 0
        ? [
            db.advertiserAccount.update({
              where: { userId: g.uid },
              data: { balanceKop: { increment: refund } },
            }),
          ]
        : []),
    ])
    return NextResponse.json({ ok: true, status: 'completed', refundKop: refund })
  } catch (e) {
    console.error('[campaigns:patch]', e)
    return err('Ошибка', 500)
  }
}
