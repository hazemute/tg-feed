/**
 * v5.88: НАГРАДЫ ЛИДЕРБОРДОВ (приказ владельца):
 *   - каждую неделю топ-3 по набранному XP получают по 5 000 свайпов;
 *   - каждый месяц топ-3 по набранному XP получают по 10 000 свайпов.
 *
 * Почему «XP, набранный ЗА ПЕРИОД», а не снапшот таблицы уровней: XP-борд
 * пожизненный — снапшот раз в неделю годами награждал бы одних и тех же.
 * Набранный за период опыт вращает топ и поощряет именно активность
 * (комментарии, лайки к комментариям, задания, чек-ины).
 *
 * Границы периодов — Europe/Moscow (UTC+3, перехода на летнее время нет):
 * неделя — ISO, понедельник 00:00; месяц — календарный, 1-е число 00:00.
 *
 * НЕ участвуют: админы (ADMIN_TG_IDS — «админов в лидербордах не показывать»),
 * гости, забаненные, участники с нетто-XP ≤ 0 за период.
 *
 * Запуск — из дневного крона /api/parse/tick (Vercel cron 02:00 UTC = 05:00 MSK):
 * начисляем ИТОГИ завершившегося периода (прошлая неделя / прошлый месяц).
 * Идемпотентность: маркер в BotSetting + unique-индексы LeaderboardPayout —
 * период не выплатится дважды даже при гонке двух тиков.
 */

import { db } from '@/lib/db'
import { adminUids } from '@/lib/maintenance'
import { invalidateBalance } from '@/lib/balance-cache'
import { sendBotNotification } from '@/lib/bot-notify'
import type { LbEntry, LbPrizeRow, LbPrizes } from '@/lib/types'

export type LbPeriod = 'week' | 'month'

/** Приказ владельца: 5 000 свайпов топ-3 недели, 10 000 — топ-3 месяца */
export const LB_PRIZE_SWIPES: Record<LbPeriod, number> = { week: 5000, month: 10000 }
export const LB_TOP = 3

/** Смещение Moscow относительно UTC (лето/зима не меняются с 2014 года) */
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000

export type LbPeriodInfo = { key: string; start: Date; end: Date }

/** ISO-неделя в MSK: ключ '2026-W38', границы — понедельник 00:00 MSK */
function isoWeekInfo(shifted: Date): LbPeriodInfo {
  const t = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()))
  const dayNum = (t.getUTCDay() + 6) % 7 // Пн=0..Вс=6
  const monday = new Date(t)
  monday.setUTCDate(t.getUTCDate() - dayNum)
  const start = new Date(monday.getTime() - MSK_OFFSET_MS)
  const end = new Date(start.getTime() + 7 * 24 * 3_600_000)
  // Номер ISO-недели — по четвергу этой недели (ISO 8601)
  const thursday = new Date(monday)
  thursday.setUTCDate(monday.getUTCDate() + 3)
  const isoYear = thursday.getUTCFullYear()
  const jan4 = new Date(Date.UTC(isoYear, 0, 4))
  const jan4Day = (jan4.getUTCDay() + 6) % 7
  const week1Monday = new Date(jan4)
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day)
  const week = 1 + Math.round((monday.getTime() - week1Monday.getTime()) / (7 * 24 * 3_600_000))
  return { key: `${isoYear}-W${String(week).padStart(2, '0')}`, start, end }
}

/** Календарный месяц в MSK: ключ '2026-09', границы — 1-е число 00:00 MSK */
function monthInfo(shifted: Date): LbPeriodInfo {
  const y = shifted.getUTCFullYear()
  const m = shifted.getUTCMonth()
  const start = new Date(Date.UTC(y, m, 1) - MSK_OFFSET_MS)
  const end = new Date(Date.UTC(y, m + 1, 1) - MSK_OFFSET_MS)
  return { key: `${y}-${String(m + 1).padStart(2, '0')}`, start, end }
}

/** Период, в который попадает момент now (по часам Moscow) */
export function lbPeriodOf(period: LbPeriod, now = new Date()): LbPeriodInfo {
  const shifted = new Date(now.getTime() + MSK_OFFSET_MS)
  return period === 'week' ? isoWeekInfo(shifted) : monthInfo(shifted)
}

/** Завершившийся период (по нему платим на первом тике нового) */
export function lbPrevPeriodOf(period: LbPeriod, now = new Date()): LbPeriodInfo {
  const cur = lbPeriodOf(period, now)
  return lbPeriodOf(period, new Date(cur.start.getTime() - 12 * 3_600_000))
}

/* --------------------------- Топ по XP за период --------------------------- */

type TopRow = { userId: string; xpGained: number }

/**
 * Топ по нетто-XP за период: groupBy по XpLog (индекс userId+createdAt),
 * после — фильтр валидных участников (не гость, не бан, не админ).
 * Детерминизм при равенстве XP: userId по алфавиту.
 */
async function topByXp(info: LbPeriodInfo, take = 200): Promise<TopRow[]> {
  const admins = adminUids()
  const g = await db.xpLog.groupBy({
    by: ['userId'],
    where: {
      createdAt: { gte: info.start, lt: info.end },
      ...(admins.length ? { userId: { notIn: admins } } : {}),
    },
    _sum: { amount: true },
    orderBy: { _sum: { amount: 'desc' } },
    take,
  })

  const rows: TopRow[] = g
    .map((x) => ({ userId: x.userId, xpGained: x._sum.amount ?? 0 }))
    .filter((x) => x.xpGained > 0)
    .sort((a, b) => b.xpGained - a.xpGained || a.userId.localeCompare(b.userId))

  if (rows.length === 0) return []

  // Валидность участников: гость/бан отсекают; админы уже отсеяны notIn'ом,
  // но перепроверка здесь же бесплатна (id из rows, а не скан всей таблицы)
  const users = await db.user.findMany({
    where: {
      id: { in: rows.map((r) => r.userId), ...(admins.length ? { notIn: admins } : {}) },
      isGuest: false,
      bannedAt: null,
    },
    select: { id: true },
  })
  const valid = new Set(users.map((u) => u.id))
  return rows.filter((r) => valid.has(r.userId))
}

/* ------------------------------- Выплаты ---------------------------------- */

export type LbPayoutResult = {
  period: LbPeriod
  periodKey: string
  /** false — период уже был выплачен (маркер/unique), топ не трогали */
  paid: { userId: string; place: number; amount: number; xpGained: number }[]
}

function medalOf(place: number): string {
  return place === 1 ? '🥇' : place === 2 ? '🥈' : '🥉'
}

async function payoutPeriod(period: LbPeriod, info: LbPeriodInfo): Promise<LbPayoutResult> {
  const markerKey = `lb_payout:${period}:${info.key}`
  const marker = await db.botSetting.findUnique({ where: { key: markerKey }, select: { key: true } })
  if (marker) return { period, periodKey: info.key, paid: [] }

  const top = (await topByXp(info)).slice(0, LB_TOP)
  const paid: LbPayoutResult['paid'] = []

  for (let i = 0; i < top.length; i++) {
    const place = i + 1
    const amount = LB_PRIZE_SWIPES[period]
    const w = top[i]
    const label = period === 'week' ? `неделя ${info.key}` : `месяц ${info.key}`
    try {
      await db.$transaction([
        db.user.update({ where: { id: w.userId }, data: { swipes: { increment: amount } } }),
        // kind 'admin' — проверенный путь (так же идут призы розыгрышей);
        // примечание видится в истории кошелька — владелец и QA понимают источник
        db.balanceLog.create({
          data: {
            userId: w.userId,
            kind: 'admin',
            currency: 'swp',
            amount,
            note: `Награда лидерборда: ${place} место, ${label}`,
          },
        }),
        db.leaderboardPayout.create({
          data: { period, periodKey: info.key, userId: w.userId, place, xpGained: w.xpGained, amount },
        }),
      ])
      paid.push({ userId: w.userId, place, amount, xpGained: w.xpGained })
      await invalidateBalance(w.userId).catch(() => {})
    } catch (e) {
      // P2002 — период уже выплачен параллельным тиком: дальше не идём
      if ((e as { code?: string })?.code === 'P2002') return { period, periodKey: info.key, paid }
      console.error(`[lb-payouts] ${period} ${info.key} #${place} ${w.userId}`, e)
    }
  }

  // ЛС победителям от бота (fire-and-forget, только tg_-аккаунты)
  for (const w of paid) {
    const scope = period === 'week' ? 'неделю' : 'месяц'
    sendBotNotification({
      userId: w.userId,
      type: 'system',
      title: `🏆 Ты в топ-3 лидерборда!`,
      body: `${medalOf(w.place)} Твоё ${w.place}-е место по активности за ${scope}. +${w.amount.toLocaleString('ru-RU')} свайпов уже на балансе — держи темп!`,
    })
  }

  await db.botSetting
    .upsert({
      where: { key: markerKey },
      create: { key: markerKey, value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    })
    .catch(() => {})

  if (paid.length > 0) console.log(`[lb-payouts] ${period} ${info.key}: paid ${paid.length}`)
  return { period, periodKey: info.key, paid }
}

/** Итоги завершившихся периодов — вызывать из дневного крона */
export async function runLbPayouts(now = new Date()): Promise<{ week: LbPayoutResult; month: LbPayoutResult }> {
  const week = await payoutPeriod('week', lbPrevPeriodOf('week', now))
  const month = await payoutPeriod('month', lbPrevPeriodOf('month', now))
  return { week, month }
}

/* ------------------- Снапшот наград для API лидерборда -------------------- */

/** Имя для снапшотов: «Имя Фамилия» → @username → «Участник» (как в таблицах) */
function nameOf(u: { username: string | null; firstName: string | null; lastName: string | null }): string {
  const full = [u.firstName, u.lastName].filter(Boolean).join(' ').trim()
  return full || (u.username ? `@${u.username}` : 'Участник')
}

const PRIZE_USER_SELECT = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
  photoUrl: true,
  isPremium: true,
  level: true,
} as const

type PrizeUser = {
  id: string
  username: string | null
  firstName: string | null
  lastName: string | null
  photoUrl: string | null
  isPremium: boolean
  level: number
}

function liveEntry(u: PrizeUser, rank: number, xpGained: number): LbEntry {
  return {
    rank,
    uid: u.id,
    name: nameOf(u),
    username: u.username,
    photoUrl: u.photoUrl,
    premium: u.isPremium,
    level: u.level,
    value: xpGained,
    sub: `${xpGained} XP`,
  }
}

/** Последняя выплатившаяся неделя/месяц (строки места 1..3 одного periodKey) */
async function lastPayoutRows(period: LbPeriod): Promise<LbPrizeRow[]> {
  const rows = await db.leaderboardPayout.findMany({
    where: { period },
    orderBy: [{ periodKey: 'desc' }, { place: 'asc' }],
    take: 6,
  })
  if (rows.length === 0) return []
  const latestKey = rows[0].periodKey
  const latest = rows.filter((r) => r.periodKey === latestKey).slice(0, LB_TOP)
  const users = await db.user.findMany({
    where: { id: { in: latest.map((r) => r.userId) } },
    select: PRIZE_USER_SELECT,
  })
  const byId = new Map(users.map((u) => [u.id, u]))
  const out: LbPrizeRow[] = []
  for (const r of latest) {
    const u = byId.get(r.userId)
    if (!u) continue
    out.push({
      place: r.place,
      uid: u.id,
      name: nameOf(u),
      username: u.username,
      photoUrl: u.photoUrl,
      premium: u.isPremium,
      level: u.level,
      amount: r.amount,
    })
  }
  return out.sort((a, b) => a.place - b.place)
}

/**
 * Снапшот для блока наград в UI (кэшируется роутом на 60с):
 * суммы призов, живой топ текущих недели/месяца, итоги прошлых периодов.
 */
export async function fetchLbPrizes(now = new Date()): Promise<LbPrizes> {
  const curWeek = lbPeriodOf('week', now)
  const curMonth = lbPeriodOf('month', now)

  const [liveWeekRows, liveMonthRows, lastWeek, lastMonth] = await Promise.all([
    topByXp(curWeek, 50),
    topByXp(curMonth, 50),
    lastPayoutRows('week'),
    lastPayoutRows('month'),
  ])

  const resolve = async (rows: TopRow[]): Promise<LbEntry[]> => {
    const slice = rows.slice(0, LB_TOP)
    if (slice.length === 0) return []
    const users = await db.user.findMany({
      where: { id: { in: slice.map((r) => r.userId) } },
      select: PRIZE_USER_SELECT,
    })
    const byId = new Map(users.map((u) => [u.id, u]))
    return slice
      .map((r, i) => {
        const u = byId.get(r.userId)
        return u ? liveEntry(u, i + 1, r.xpGained) : null
      })
      .filter((x): x is LbEntry => x !== null)
  }

  return {
    weekKey: curWeek.key,
    monthKey: curMonth.key,
    weeklyAmount: LB_PRIZE_SWIPES.week,
    monthlyAmount: LB_PRIZE_SWIPES.month,
    liveWeek: await resolve(liveWeekRows),
    liveMonth: await resolve(liveMonthRows),
    lastWeek,
    lastMonth,
  }
}
