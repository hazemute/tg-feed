import { db } from '@/lib/db'

/**
 * v6.1: МОНЕТИЗАЦИЯ ВЛАДЕЛЬЦА КАНАЛА — единый модуль констант и проводок.
 *
 * Четыре продукта поверх привязанного канала (claimedById != null):
 *  1. ПЛАТНАЯ ВЕРИФИКАЦИЯ — галочка на 30 дней (purpose 'verify:<channelId>');
 *     админская verified остаётся бессрочной поверх платной.
 *  2. БУСТ КАТАЛОГА — канал пиннится в топ каталога на 1 или 7 дней
 *     (purpose 'boost:<channelId>:<days>').
 *  3. ПЛАТНАЯ ПОДПИСКА НА АВТОРА (ревшар 70/30) — владелец включаает цену за
 *     месяц; подписчик платит с рублёвого кошелька, 70% падает автору на
 *     баланс (BalanceLog 'membership_income'), 30% — платформе. Подписчик
 *     видит memberOnly-посты канала в ленте и на экране канала.
 *  4. БИРЖА ВЗАИМОПИАРА — заявки между владельцами сопоставимых каналов.
 */

// ---------- Верификация ----------
export const VERIFY_PRICE_KOP = 49_000 // 490 ₽ за 30 дней
export const VERIFY_DAYS = 30
/** purpose счёта Platega: 'verify:<channelId>' */
export function verifyPurpose(channelId: string): string {
  return `verify:${channelId}`
}
export function isVerifyPurpose(p: string): boolean {
  return p.startsWith('verify:')
}

// ---------- Буст каталога ----------
export type BoostPlan = { id: 'd1' | 'd7'; days: number; priceKop: number; label: string }
export const BOOST_PLANS: BoostPlan[] = [
  { id: 'd1', days: 1, priceKop: 14_900, label: '1 день' },
  { id: 'd7', days: 7, priceKop: 59_900, label: '7 дней' },
]
export function boostPlanById(id: string): BoostPlan | null {
  return BOOST_PLANS.find((p) => p.id === id) ?? null
}
/** purpose счёта: 'boost:<channelId>:<days>' */
export function boostPurpose(channelId: string, days: number): string {
  return `boost:${channelId}:${days}`
}
export function isBoostPurpose(p: string): boolean {
  return /^boost:[^:]+:\d+$/.test(p)
}
export function parseBoostPurpose(p: string): { channelId: string; days: number } | null {
  const m = p.match(/^boost:([^:]+):(\d+)$/)
  if (!m) return null
  return { channelId: m[1], days: Number(m[2]) }
}

// ---------- Платная подписка (ревшар 70/30) ----------
/** Доля автора с каждой подписки (0.7 → автору, 0.3 → платформе) */
export const MEMBERSHIP_AUTHOR_SHARE = 0.7
/** Длительность подписки (дней) */
export const MEMBERSHIP_DAYS = 30
/** Пресеты цены за месяц (копейки); 0 — владелец может ввести свое в пределах 29–2999 ₽ */
export const MEMBERSHIP_PRESETS_KOP = [4_900, 9_900, 19_900, 29_900]
export const MEMBERSHIP_MIN_KOP = 2_900
export const MEMBERSHIP_MAX_KOP = 299_900
/**
 * Покупка/продление подписки: idемпотентная транзакция.
 * Пока активной подписки нет — создаём; если есть (продление за ≤3 дней до
 * конца или уже истекла) — продлеваем от max(now, until).
 * Автору — 70% цены на balanceKop (журнал 'membership_income'), подписка
 * продлевается. Возвращает новую дату 'until' или null (не хватило баланса).
 */
export async function buyMembershipFromBalance(
  userId: string,
  channelId: string,
): Promise<{ until: Date; priceKop: number } | null> {
  const channel = await db.channel.findUnique({
    where: { id: channelId },
    select: { membershipPriceKop: true, claimedById: true, status: true },
  })
  if (!channel?.membershipPriceKop || channel.status !== 'active') return null
  if (channel.claimedById === userId) return null // сам себе не продаёт
  const priceKop = channel.membershipPriceKop

  return db.$transaction(async (tx) => {
    // Атомарное списание (не уйдёт в минус)
    const debited = await tx.user.updateMany({
      where: { id: userId, balanceKop: { gte: priceKop } },
      data: { balanceKop: { decrement: priceKop } },
    })
    if (debited.count === 0) return null

    const existing = await tx.channelMembership.findUnique({
      where: { userId_channelId: { userId, channelId } },
    })
    const now = new Date()
    const base = existing && existing.until > now ? existing.until : now
    const until = new Date(base.getTime() + MEMBERSHIP_DAYS * 86_400_000)
    const authorKop = Math.floor(priceKop * MEMBERSHIP_AUTHOR_SHARE)

    if (existing) {
      await tx.channelMembership.update({
        where: { id: existing.id },
        data: { until, priceKop, incomeKop: { increment: authorKop } },
      })
    } else {
      await tx.channelMembership.create({
        data: { userId, channelId, priceKop, until, incomeKop: authorKop },
      })
    }

    // 70% автору на рублёвый баланс + журнал
    if (channel.claimedById) {
      await tx.user.update({
        where: { id: channel.claimedById },
        data: { balanceKop: { increment: authorKop } },
      })
      await tx.balanceLog.create({
        data: {
          userId: channel.claimedById,
          kind: 'membership_income',
          currency: 'rub',
          amount: authorKop,
          note: `платная подписка · 70% от ${(priceKop / 100).toFixed(0)} ₽`,
        },
      })
    }
    // Журнал списания подписчика
    await tx.balanceLog.create({
      data: {
        userId,
        kind: 'purchase',
        currency: 'rub',
        amount: -priceKop,
        note: `подписка на канал · 30 дней`,
      },
    })
    return { until, priceKop }
  })
}

// ---------- Хелперы эффективных флагов ----------
export type ChannelFlagsSource = {
  verified: boolean
  verifiedUntil: Date | null
  boostUntil: Date | null
}
/** Галочка: админская (бессрочная) ИЛИ платная (до verifiedUntil) */
export function isVerifiedEffective(ch: ChannelFlagsSource, now = new Date()): boolean {
  if (ch.verified) return true
  return Boolean(ch.verifiedUntil && ch.verifiedUntil > now)
}
/** Буст активен */
export function isBoostActive(ch: ChannelFlagsSource, now = new Date()): boolean {
  return Boolean(ch.boostUntil && ch.boostUntil > now)
}
/** Продление от max(now, текущий срок) — для verify/boost */
export function extendFrom(current: Date | null, days: number, now = new Date()): Date {
  const base = current && current > now ? current : now
  return new Date(base.getTime() + days * 86_400_000)
}

/** Владелец ли канала текущим пользователем (для экшенов кабинета) */
export async function assertOwnedChannel(
  userId: string,
  channelId: string,
): Promise<{ id: string; username: string; claimedById: string | null } | null> {
  const ch = await db.channel.findUnique({
    where: { id: channelId },
    select: { id: true, username: true, claimedById: true },
  })
  if (!ch || ch.claimedById !== userId) return null
  return ch
}
