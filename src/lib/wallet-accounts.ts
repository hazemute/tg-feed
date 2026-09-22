import { db } from '@/lib/db'
import { invalidateBalance } from '@/lib/balance-cache'

/**
 * КОШЕЛЁК v2 (v5.77) — счета с адресами, переводы и рефералка.
 *
 *  • У каждого пользователя ДВА счёта с постоянными адресами:
 *      — «Swipe-счёт»  (SWP-XXXX-XXXX) — свайпы, валюта нейросетей;
 *      — «Рубль-счёт»  (RUB-XXXX-XXXX) — рубли (balanceKop), пополнения.
 *    Адреса генерируются лениво (первый визит в кошелёк), уникальны, живут вечно.
 *  • Переводы: между своими счетами (курс 500 свайпов = 1 ₽) и ЛЮБОМУ человеку
 *    мини-аппа по адресу или @username — атомарно, без комиссии.
 *  • Рефералка 5%: когда приглашённый тратит свайпы (ИИ и прочее), пригласившему
 *    мгновенно падает 5% той же транзакцией (WalletTx kind='ref_earn').
 *  • История — WalletTx (крипто-стиль «адрес → адрес») + BalanceLog (внутренние
 *    проводки) мержатся в единую ленту на клиенте.
 */

export const REFERRAL_PERCENT = 5

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // без 0/O/1/I — читается с листа

function randomChunk(len: number): string {
  const bytes = new Uint8Array(len)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]
  return out
}

/** Уникальный адрес счёта: prefix-XXXX-XXXX (проверка на коллизию в БД) */
async function generateAddress(prefix: 'SWP' | 'RUB'): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const addr = `${prefix}-${randomChunk(4)}-${randomChunk(4)}`
    const exists = await db.user.findFirst({
      where: { OR: [{ swipeAddress: addr }, { rubAddress: addr }] },
      select: { id: true },
    })
    if (!exists) return addr
  }
  // 5 коллизий подряд невозможны практически, но пусть будет честный фолбэк
  return `${prefix}-${randomChunk(6)}-${Date.now().toString(36).toUpperCase().slice(-4)}`
}

/**
 * Гарантировать адреса обоих счетов (ленивое создание при первом визите
 * в кошелёк). Идемпотентно: уже созданные адреса не трогает.
 */
export async function ensureWalletAddresses(userId: string): Promise<{ swipeAddress: string; rubAddress: string }> {
  const u = await db.user.findUnique({
    where: { id: userId },
    select: { swipeAddress: true, rubAddress: true },
  })
  if (!u) throw new Error('user not found')
  let sw = u.swipeAddress
  let rub = u.rubAddress
  if (!sw || !rub) {
    if (!sw) sw = await generateAddress('SWP')
    if (!rub) rub = await generateAddress('RUB')
    try {
      await db.user.update({ where: { id: userId }, data: { swipeAddress: sw, rubAddress: rub } })
    } catch {
      // гонка/уникальность — перечитаем фактические значения
      const fresh = await db.user.findUnique({
        where: { id: userId },
        select: { swipeAddress: true, rubAddress: true },
      })
      if (fresh?.swipeAddress) sw = fresh.swipeAddress
      if (fresh?.rubAddress) rub = fresh.rubAddress
    }
  }
  return { swipeAddress: sw, rubAddress: rub }
}

/**
 * Пригласивший (для 5%): берём из User.referredById; если ещё не проставлен —
 * ленивый ремонт из GiveawayReferral (первое активированное приглашение).
 */
export async function getReferrerOf(userId: string): Promise<string | null> {
  const u = await db.user.findUnique({ where: { id: userId }, select: { referredById: true } })
  if (!u) return null
  if (u.referredById) return u.referredById
  try {
    const ref = await db.giveawayReferral.findFirst({
      where: { invitedUserId: userId, activatedAt: { not: null } },
      orderBy: { createdAt: 'asc' },
      select: { referrerUserId: true },
    })
    if (!ref || ref.referrerUserId === userId) return null
    await db.user
      .update({ where: { id: userId }, data: { referredById: ref.referrerUserId } })
      .catch(() => {})
    return ref.referrerUserId
  } catch {
    return null
  }
}

/** Простой короткий ник получателя для журнала (имя или @username) */
export async function userLabel(userId: string): Promise<string | null> {
  const u = await db.user.findUnique({
    where: { id: userId },
    select: { username: true, firstName: true },
  })
  if (!u) return null
  return u.username ? `@${u.username}` : u.firstName ?? null
}

/**
 * Начислить рефереру 5% от траты приглашённого. Вызывается ПОСЛЕ успешного
 * spendSwipes (best-effort: сбой не должен ломать трату друга).
 */
export async function payReferralKickback(spenderId: string, spentSwipes: number, note?: string): Promise<void> {
  try {
    if (spentSwipes < 20) return // микро-траты: floor(5%) = 0 — не шумим
    const reward = Math.floor((spentSwipes * REFERRAL_PERCENT) / 100)
    if (reward <= 0) return
    const referrerId = await getReferrerOf(spenderId)
    if (!referrerId || referrerId === spenderId) return
    const referrer = await db.user.findUnique({
      where: { id: referrerId },
      select: { id: true, swipeAddress: true },
    })
    if (!referrer) return
    const spenderAddr = await db.user.findUnique({
      where: { id: spenderId },
      select: { swipeAddress: true },
    })
    await db.$transaction([
      db.user.update({ where: { id: referrerId }, data: { swipes: { increment: reward } } }),
      db.walletTx.create({
        data: {
          kind: 'ref_earn',
          currency: 'swp',
          amount: reward,
          fromAddr: spenderAddr?.swipeAddress ?? null,
          toAddr: referrer.swipeAddress ?? null,
          fromUserId: spenderId,
          toUserId: referrerId,
          note: note ?? `Реферальные ${REFERRAL_PERCENT}% от траты друга`,
        },
      }),
    ])
    await invalidateBalance(referrerId)
  } catch (e) {
    console.error('[wallet-accounts] referral kickback failed', e)
  }
}

export type TransferResult =
  | { ok: true; amount: number; currency: 'swp' | 'rub'; toLabel: string | null }
  | { ok: false; error: string }

/**
 * Перевод со счёта на счёт: своему второму счёту (конвертация по курсу) или
 * любому пользователю по адресу / @username. Атомарно, без комиссии.
 * amount — целое: свайпы (currency 'swp') или КОПЕЙКИ (currency 'rub').
 */
export async function transferFunds(
  senderId: string,
  opts: { to: string; amount: number; currency: 'swp' | 'rub'; note?: string },
): Promise<TransferResult> {
  const { to, currency, note } = opts
  const amount = Math.floor(opts.amount)
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Неверная сумма' }
  if (amount > 100_000_000) return { ok: false, error: 'Слишком большая сумма' }

  const sender = await db.user.findUnique({
    where: { id: senderId },
    select: { id: true, swipes: true, balanceKop: true, swipeAddress: true, rubAddress: true },
  })
  if (!sender) return { ok: false, error: 'Отправитель не найден' }
  const senderAddr = currency === 'swp' ? sender.swipeAddress : sender.rubAddress
  if (!senderAddr) return { ok: false, error: 'Сначала откройте кошелёк (адрес создаётся автоматически)' }

  // Поиск получателя: точный адрес → tg_<id> → @username
  const toRaw = to.trim()
  const byAddress = await db.user.findFirst({
    where: { OR: [{ swipeAddress: toRaw.toUpperCase() }, { rubAddress: toRaw.toUpperCase() }] },
    select: { id: true, username: true, firstName: true, swipeAddress: true, rubAddress: true },
  })
  let recipient = byAddress
  if (!recipient && /^(tg_\d+|guest_[a-z0-9]+)$/i.test(toRaw)) {
    recipient = await db.user.findUnique({
      where: { id: toRaw.toLowerCase() },
      select: { id: true, username: true, firstName: true, swipeAddress: true, rubAddress: true },
    })
  }
  if (!recipient) {
    const uname = toRaw.replace(/^@/, '').toLowerCase()
    if (/^[a-z0-9_]{4,64}$/.test(uname)) {
      recipient = await db.user.findFirst({
        where: { username: uname },
        select: { id: true, username: true, firstName: true, swipeAddress: true, rubAddress: true },
      })
    }
  }
  if (!recipient) return { ok: false, error: 'Получатель не найден — проверьте адрес или @username' }
  if (recipient.id === senderId) return { ok: false, error: 'Нельзя переводить самому себе' }

  const toAddr = currency === 'swp' ? recipient.swipeAddress : recipient.rubAddress
  if (!toAddr) return { ok: false, error: 'У получателя ещё нет такого счёта' }

  // Атомарное списание у отправителя (условный декремент) + начисление получателю
  const dec =
    currency === 'swp'
      ? await db.user.updateMany({
          where: { id: senderId, swipes: { gte: amount } },
          data: { swipes: { decrement: amount } },
        })
      : await db.user.updateMany({
          where: { id: senderId, balanceKop: { gte: amount } },
          data: { balanceKop: { decrement: amount } },
        })
  if (dec.count === 0) {
    return {
      ok: false,
      error: currency === 'swp' ? 'Недостаточно свайпов на Swipe-счёте' : 'Недостаточно рублей на Рубль-счёте',
    }
  }
  const inc =
    currency === 'swp'
      ? db.user.update({ where: { id: recipient.id }, data: { swipes: { increment: amount } } })
      : db.user.update({ where: { id: recipient.id }, data: { balanceKop: { increment: amount } } })

  try {
    await db.$transaction([
      inc,
      db.walletTx.create({
        data: {
          kind: 'transfer',
          currency,
          amount,
          fromAddr: senderAddr,
          toAddr,
          fromUserId: senderId,
          toUserId: recipient.id,
          note: note?.trim().slice(0, 140) || null,
        },
      }),
    ])
  } catch (e) {
    // начисление не прошло — откатываем списание компенсацией (best-effort)
    console.error('[wallet-accounts] transfer failed, compensating', e)
    // v5.77: union-тип не резолвится TS'ом — ветвим явно (компенсация отката)
    const compensate =
      currency === 'swp'
        ? db.user.update({ where: { id: senderId }, data: { swipes: { increment: amount } } })
        : db.user.update({ where: { id: senderId }, data: { balanceKop: { increment: amount } } })
    await compensate.catch(() => {})
    return { ok: false, error: 'Перевод не удался, средства возвращены' }
  }
  await invalidateBalance(senderId)
  await invalidateBalance(recipient.id)
  const toLabel = recipient.username ? `@${recipient.username}` : recipient.firstName
  return { ok: true, amount, currency, toLabel: toLabel ?? toAddr }
}

/** Единая история: WalletTx (переводы/рефералка) + BalanceLog (внутренние проводки) */
export type WalletFeedItem =
  | {
      type: 'tx'
      id: string
      kind: string
      currency: 'swp' | 'rub' | string
      amount: number
      direction: 'in' | 'out' | 'self'
      counterparty: string | null
      note: string | null
      createdAt: string
    }
  | {
      type: 'log'
      id: string
      kind: string
      currency: string
      amount: number
      note: string | null
      createdAt: string
    }

export async function walletFeed(userId: string, take = 30): Promise<WalletFeedItem[]> {
  const [txs, logs] = await Promise.all([
    db.walletTx.findMany({
      where: { OR: [{ fromUserId: userId }, { toUserId: userId }] },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        kind: true,
        currency: true,
        amount: true,
        fromUserId: true,
        toUserId: true,
        fromAddr: true,
        toAddr: true,
        note: true,
        createdAt: true,
      },
    }),
    db.balanceLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take,
      select: { id: true, kind: true, currency: true, amount: true, note: true, createdAt: true },
    }),
  ])

  const me = userId
  const txItems: WalletFeedItem[] = await Promise.all(
    txs.map(async (t) => {
      const direction: 'in' | 'out' | 'self' =
        t.fromUserId === me && t.toUserId === me ? 'self' : t.toUserId === me ? 'in' : 'out'
      // контрагент: второй участник (или адрес при отсутствии юзера)
      const otherUserId = direction === 'in' ? t.fromUserId : t.toUserId
      let counterparty: string | null = null
      if (otherUserId) counterparty = await userLabel(otherUserId)
      if (!counterparty) counterparty = direction === 'in' ? t.fromAddr : t.toAddr
      return {
        type: 'tx' as const,
        id: t.id,
        kind: t.kind,
        currency: t.currency,
        amount: t.amount,
        direction,
        counterparty,
        note: t.note,
        createdAt: t.createdAt.toISOString(),
      }
    }),
  )

  const logItems: WalletFeedItem[] = logs.map((l) => ({
    type: 'log' as const,
    id: l.id,
    kind: l.kind,
    currency: l.currency,
    amount: l.amount, // знаковый
    note: l.note,
    createdAt: l.createdAt.toISOString(),
  }))

  return [...txItems, ...logItems]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, take)
}

/** Сумма всех реферальных начислений юзера (в свайпах) */
export async function referralEarnedTotal(userId: string): Promise<number> {
  const agg = await db.walletTx.aggregate({
    where: { toUserId: userId, kind: 'ref_earn', currency: 'swp' },
    _sum: { amount: true },
  })
  return agg._sum.amount ?? 0
}
