import { db } from '@/lib/db'

/**
 * КОШЕЛЁК (v5.38) — единая двухвалютная система.
 *
 *  • Рубли — balanceKop (копейки), пополняется картой/Stars/TON.
 *    Покупается ВСЁ: тарифы Snap, рекламные кампании, всё что есть в сервисе.
 *  • Свайпы — swipes. Валюта нейросетей (как кредиты в ChatGPT):
 *    1 запрос к ИИ = 1 свайп. Конвертируются в рубли и обратно.
 *
 * КУРС: 100 свайпов = 1 ₽ (1 копейка = 1 свайп — конвертация без потерь).
 *
 * Все операции атомарны (транзакции), велись в BalanceLog (журнал кошелька).
 * Инвариант: balanceKop ≥ 0, swipes ≥ 0 — условные декременты не дают уйти в минус.
 */

export const SWP_PER_RUB = 100
/** Стоимость одного запроса к нейросети, в свайпах */
export const AI_COST_SWIPES = 1
/** Минимум свайпов для конвертации в рубли */
export const SWP_CONVERT_MIN = SWP_PER_RUB

export type Wallet = { balanceKop: number; swipes: number }

export function swpToKop(swipes: number): number {
  return Math.round(swipes / SWP_PER_RUB)
}
export function kopToSwp(kop: number): number {
  return Math.round(kop) * SWP_PER_RUB
}

/** Формат ₽ из копеек: 123456 → «1 234,56 ₽» (тонкий пробел-разделитель тысяч) */
export function fmtRub(kop: number): string {
  const sign = kop < 0 ? '−' : ''
  const v = Math.abs(kop) / 100
  const [int, frac] = v.toFixed(2).split('.')
  const intSpaced = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `${sign}${intSpaced},${frac} ₽`
}

// --------------------------------------------------------------------------- //
//  Внутренние проводки (всегда в транзакции вызывающего кода или своей)
// --------------------------------------------------------------------------- //

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0]

/** Журнал: +зачисление / −списание. currency 'rub' → amount в копейках, 'swp' → в свайпах. */
async function log(
  tx: Tx,
  userId: string,
  kind: 'topup' | 'convert' | 'ai_spend' | 'purchase' | 'ad_campaign' | 'refund' | 'admin',
  currency: 'rub' | 'swp',
  amount: number,
  note?: string,
): Promise<void> {
  await tx.balanceLog.create({ data: { userId, kind, currency, amount, note: note ?? null } })
}

/**
 * Списать свайпы. Если их не хватает — ДОКУПИТЬ недостающее с рублёвого баланса
 * (1 копейка = 1 свайп, докупаем с запасом ≥100 свайпов, если хватает денег):
 * так «за рубли можно пользоваться всем сервисом, не оплачивая картой на месте».
 * Возвращает false, если и рублей не хватает.
 */
export async function spendSwipes(
  userId: string,
  cost: number,
  note?: string,
): Promise<boolean> {
  if (cost <= 0) return true
  return db.$transaction(async (tx) => {
    const u = await tx.user.findUnique({
      where: { id: userId },
      select: { swipes: true, balanceKop: true },
    })
    if (!u) return false

    if (u.swipes >= cost) {
      await tx.user.update({
        where: { id: userId },
        data: { swipes: { decrement: cost } },
      })
      await log(tx, userId, 'ai_spend', 'swp', -cost, note)
      return true
    }

    // Не хватает свайпов — докупаем с рублёвого баланса
    const deficit = cost - u.swipes
    // Пакет докупки: кратен 100, но не меньше дефицита; если денег впритык — берём ровно дефицит
    const buy = Math.max(
      deficit,
      Math.ceil(deficit / SWP_PER_RUB) * SWP_PER_RUB,
    ) // ≥ deficit, обычно круглыми сотнями
    const affordable = u.balanceKop >= buy ? buy : u.balanceKop >= deficit ? deficit : 0
    if (affordable <= 0) return false

    await tx.user.update({
      where: { id: userId },
      data: { balanceKop: { decrement: affordable }, swipes: { increment: affordable } },
    })
    await log(tx, userId, 'convert', 'swp', affordable, 'авто-покупка свайпов с баланса')
    await tx.user.update({
      where: { id: userId },
      data: { swipes: { decrement: cost } },
    })
    await log(tx, userId, 'ai_spend', 'swp', -cost, note)
    return true
  })
}

/** Конвертация свайпы → рубли: 100 свайпов = 1 ₽. Остаток (<100) остаётся свайпами. */
export async function convertSwpToRub(
  userId: string,
  swipes: number,
): Promise<{ ok: boolean; error?: string; rubKop?: number; spentSwipes?: number }> {
  if (!Number.isInteger(swipes) || swipes < SWP_CONVERT_MIN) {
    return { ok: false, error: `Минимум ${SWP_CONVERT_MIN} свайпов` }
  }
  const rubKop = Math.floor(swipes / SWP_PER_RUB) // целые рубли
  const spentSwipes = rubKop * SWP_PER_RUB
  return db.$transaction(async (tx) => {
    const updated = await tx.user.updateMany({
      where: { id: userId, swipes: { gte: spentSwipes } },
      data: { swipes: { decrement: spentSwipes }, balanceKop: { increment: rubKop } },
    })
    if (updated.count === 0) return { ok: false, error: 'Недостаточно свайпов' }
    await log(tx, userId, 'convert', 'swp', -spentSwipes, 'обмен в рубли')
    await log(tx, userId, 'convert', 'rub', rubKop, 'обмен из свайпов')
    return { ok: true, rubKop, spentSwipes }
  })
}

/** Конвертация рубли → свайпы: 1 копейка = 1 свайп (100 свайпов = 1 ₽). */
export async function convertRubToSwp(
  userId: string,
  kop: number,
): Promise<{ ok: boolean; error?: string; swipes?: number }> {
  if (!Number.isInteger(kop) || kop < 1) {
    return { ok: false, error: 'Минимум 0,01 ₽' }
  }
  return db.$transaction(async (tx) => {
    const updated = await tx.user.updateMany({
      where: { id: userId, balanceKop: { gte: kop } },
      data: { balanceKop: { decrement: kop }, swipes: { increment: kopToSwp(kop) } },
    })
    if (updated.count === 0) return { ok: false, error: 'Недостаточно рублей на балансе' }
    await log(tx, userId, 'convert', 'rub', -kop, 'обмен в свайпы')
    await log(tx, userId, 'convert', 'swp', kopToSwp(kop), 'обмен из рублей')
    return { ok: true, swipes: kopToSwp(kop) }
  })
}

/**
 * Оплата покупки с рублёвого баланса (тарифы, всё что есть в сервисе).
 * Атомарно: условный декремент не даст уйти в минус. Возвращает false — не хватает.
 */
export async function payWithBalance(
  userId: string,
  amountKop: number,
  note?: string,
): Promise<boolean> {
  if (amountKop <= 0) return true
  return db.$transaction(async (tx) => {
    const updated = await tx.user.updateMany({
      where: { id: userId, balanceKop: { gte: amountKop } },
      data: { balanceKop: { decrement: amountKop } },
    })
    if (updated.count === 0) return false
    await log(tx, userId, 'purchase', 'rub', -amountKop, note)
    return true
  })
}

/** Журнал кошелька (новые сверху) */
export async function walletHistory(userId: string, take = 20) {
  return db.balanceLog.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take,
    select: { id: true, kind: true, currency: true, amount: true, note: true, createdAt: true },
  })
}
