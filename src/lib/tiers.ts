import { db } from '@/lib/db'

/**
 * Тарифы Tg Swipe (v5.17):
 *  - free: 3 ИИ-поиска в день; лайк/комментарий/закладка — только после входа
 *    (ленивая регистрация — шторка «привяжи Telegram за 2 секунды»);
 *  - Snap Plus (390₽/мес или 2990₽/год): безлимитный ИИ-поиск, инкогнито
 *    (просмотры не видны в детальной статистике админов), приоритетная
 *    скорость медиа, анимированные премиум-эмодзи;
 *  - Snap Pro (1490₽/мес или 9990₽/год): всё из Plus + автономный
 *    ИИ-контентщик (стиль → пост → картинка → публикация в TG), продвижение
 *    постов в ленту до 7 раз в неделю, премиум-бейдж автора, CTA-кнопка.
 */

export type Tier = 'free' | 'plus' | 'pro'

export const TIER_PRICES: Record<
  'plus' | 'pro',
  { monthKop: number; yearKop: number; monthStars: number; yearStars: number }
> = {
  plus: { monthKop: 39_000, yearKop: 299_000, monthStars: 390, yearStars: 2990 },
  pro: { monthKop: 149_000, yearKop: 999_000, monthStars: 1490, yearStars: 9990 },
}

export const AI_SEARCH_DAILY_LIMIT = 3 // free-тир, сутки UTC
export const PRO_PROMOTE_WEEKLY_LIMIT = 7 // продвижений в неделю
export const PRO_INITIAL_BOOST = 40 // стартовый буст температуры поста Pro-автора
export const PRO_PROMOTE_HOT_BOOST = 150 // разовый буст температуры при продвижении

const TIER_RANK: Record<Tier, number> = { free: 0, plus: 1, pro: 2 }

/** Есть ли у тира право уровня need (pro ≥ plus ≥ free) */
export function tierAtLeast(tier: Tier, need: Tier): boolean {
  return TIER_RANK[tier] >= TIER_RANK[need]
}

/**
 * Действующий тир пользователя: истёкший срок (tierUntil < now) ведёт себя
 * как free, но поле в БД не переписываем — продление вернёт прежний уровень.
 */
export function effectiveTier(u: { tier?: string | null; tierUntil?: Date | null } | null): Tier {
  const raw = u?.tier as Tier | undefined
  if (raw !== 'plus' && raw !== 'pro') return 'free'
  if (u?.tierUntil && u.tierUntil.getTime() < Date.now()) return 'free'
  return raw
}

/** Загрузить пользователя и определить действующий тир (null — гость без записи) */
export async function tierOfUser(userId: string | null): Promise<Tier> {
  if (!userId) return 'free'
  const u = await db.user.findUnique({
    where: { id: userId },
    select: { tier: true, tierUntil: true },
  })
  return effectiveTier(u)
}

/** Счётчик ИИ-поисков за текущие сутки UTC (для free-лимита) */
export async function aiSearchCountToday(userId: string): Promise<number> {
  const dayStart = new Date()
  dayStart.setUTCHours(0, 0, 0, 0)
  return db.aiSearchLog.count({ where: { userId, createdAt: { gte: dayStart } } })
}

/**
 * Разрешён ли ИИ-поиск: plus/pro — безлимит, free — 3/день.
 * remaining — сколько поисков осталось (для plus/pro — Infinity).
 */
export async function aiSearchAllowance(userId: string): Promise<{
  allowed: boolean
  remaining: number
  tier: Tier
}> {
  const tier = await tierOfUser(userId)
  if (tierAtLeast(tier, 'plus')) return { allowed: true, remaining: Number.POSITIVE_INFINITY, tier }
  const used = await aiSearchCountToday(userId)
  return { allowed: used < AI_SEARCH_DAILY_LIMIT, remaining: Math.max(0, AI_SEARCH_DAILY_LIMIT - used), tier }
}

/** Дата окончания подписки при покупке с текущего момента (продление суммируется) */
export function tierExpiryFor(currentUntil: Date | null | undefined, period: 'month' | 'year'): Date {
  const base =
    currentUntil && currentUntil.getTime() > Date.now() ? currentUntil.getTime() : Date.now()
  const d = new Date(base)
  if (period === 'month') d.setUTCMonth(d.getUTCMonth() + 1)
  else d.setUTCFullYear(d.getUTCFullYear() + 1)
  return d
}

/** purpose платежа → { plan, period } (null — не тарифный платёж) */
export function parseTierPurpose(purpose: string): { plan: 'plus' | 'pro'; period: 'month' | 'year' } | null {
  if (purpose === 'plus_month') return { plan: 'plus', period: 'month' }
  if (purpose === 'plus_year') return { plan: 'plus', period: 'year' }
  if (purpose === 'pro_month') return { plan: 'pro', period: 'month' }
  if (purpose === 'pro_year') return { plan: 'pro', period: 'year' }
  return null
}
