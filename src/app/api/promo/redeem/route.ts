import { NextResponse } from 'next/server'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { invalidateBalance } from '@/lib/balance-cache'
import { formatSwipesFull } from '@/lib/money'

export const dynamic = 'force-dynamic'

/**
 * POST /api/promo/redeem (v5.65) — активация промокода пользователем миниаппа.
 *
 * Награды (задаёт админ в генераторе):
 *   swipes → зачисление свайпов на кошелёк
 *   rub    → зачисление рублей (копейки в БД)
 *   tier   → доступ Snap Plus/Pro на N дней (продление, если тот же план активен)
 *
 * Атомарность: активация = строка PromoRedemption (unique promoId+userId) +
 * условный инкремент usedCount (WHERE usedCount < maxUses) — гонки исключают
 * и двойную активацию одним пользователем, и превышение лимита кода.
 */

const bodySchema = z.object({ code: z.string().trim().min(3).max(32) })

const DAY_MS = 24 * 3600 * 1000

function rewardLabel(
  kind: string,
  swipes: number,
  amountKop: number,
  tierPlan: string | null,
  tierDays: number,
): string {
  if (kind === 'swipes') return `${formatSwipesFull(swipes)} свайпов`
  if (kind === 'rub') return `${(amountKop / 100).toLocaleString('ru-RU')} ₽`
  return `Snap ${tierPlan === 'pro' ? 'Pro' : 'Plus'} на ${tierDays} дн.`
}

export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 10, windowMs: 60_000, bucket: 'promo-redeem' })
  if (!g.ok) return g.res

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('Введите промокод')
    // Код нормализуем: upper-case, пробелы убираем
    const code = parsed.data.code.toUpperCase().replace(/\s+/g, '')

    const promo = await db.promoCode.findUnique({ where: { code } })
    if (!promo) return err('Промокод не найден', 404)
    if (!promo.active) return err('Промокод больше не активен')
    if (promo.expiresAt && promo.expiresAt.getTime() < Date.now()) return err('Срок действия промокода истёк')
    if (promo.usedCount >= promo.maxUses) return err('Лимит активаций этого кода исчерпан')

    // 1) Активация пользователя: unique(promoId, userId) отсекает повторную
    const redeemed = await db.promoRedemption
      .create({
        data: {
          promoId: promo.id,
          userId: g.uid,
          reward: rewardLabel(promo.kind, promo.swipes, promo.amountKop, promo.tierPlan, promo.tierDays),
        },
        select: { id: true },
      })
      .catch((e) => {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return null
        throw e
      })
    if (!redeemed) return err('Вы уже активировали этот промокод')

    // 2) Лимит активаций: условный инкремент (гонки не превышают maxUses)
    const bumped = await db.promoCode.updateMany({
      where: {
        id: promo.id,
        active: true,
        usedCount: { lt: promo.maxUses },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      data: { usedCount: { increment: 1 } },
    })
    if (bumped.count === 0) {
      // Между проверкой и инкрементом код исчерпали — откатываем активацию
      await db.promoRedemption.delete({ where: { id: redeemed.id } }).catch(() => {})
      return err('Лимит активаций этого кода исчерпан')
    }

    // 3) Зачисление награды
    let reward = rewardLabel(promo.kind, promo.swipes, promo.amountKop, promo.tierPlan, promo.tierDays)

    if (promo.kind === 'swipes') {
      await db.user.update({ where: { id: g.uid }, data: { swipes: { increment: promo.swipes } } })
      await db.balanceLog.create({
        data: { userId: g.uid, kind: 'promo', currency: 'swp', amount: promo.swipes, note: `Промокод ${promo.code}` },
      })
    } else if (promo.kind === 'rub') {
      await db.user.update({ where: { id: g.uid }, data: { balanceKop: { increment: promo.amountKop } } })
      await db.balanceLog.create({
        data: { userId: g.uid, kind: 'promo', currency: 'rub', amount: promo.amountKop, note: `Промокод ${promo.code}` },
      })
    } else {
      // tier: логика панели — тот же активный план продлевается от текущего срока
      const u = await db.user.findUnique({ where: { id: g.uid }, select: { tier: true, tierUntil: true } })
      const plan = promo.tierPlan === 'pro' ? 'pro' : 'plus'
      const now = Date.now()
      const currentActive = u?.tierUntil && u.tierUntil.getTime() > now ? u.tierUntil.getTime() : now
      const base = plan === u?.tier && currentActive > now ? currentActive : now
      const until = new Date(base + promo.tierDays * DAY_MS)
      await db.user.update({ where: { id: g.uid }, data: { tier: plan, tierUntil: until } })
      reward = `Snap ${plan === 'pro' ? 'Pro' : 'Plus'} до ${until.toLocaleDateString('ru-RU')}`
      await db.balanceLog.create({
        data: { userId: g.uid, kind: 'promo', currency: 'rub', amount: 0, note: `Промокод ${promo.code}: ${reward}` },
      })
    }

    invalidateBalance(g.uid).catch(() => {})

    return NextResponse.json({ ok: true, reward })
  } catch (e) {
    console.error('[promo:redeem]', e)
    return err('Ошибка', 500)
  }
}
