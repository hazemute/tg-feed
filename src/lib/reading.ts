import { db } from '@/lib/db'
import { cacheGet, cacheSet } from '@/lib/redis'
import { invalidateBalance } from '@/lib/balance-cache'
import { sendBotNotification } from '@/lib/bot-notify'

/**
 * v5.93 — ЧТЕНИЕ, СТРИК И ЦЕЛЬ НЕДЕЛИ (решение владельца: «удержание без игры»).
 *
 * Продуктовая механика лежит ПОВЕРХ чтения и ничего не требует от юзера:
 *  • день зачитывается АВТОМАТИЧЕСКИ, когда юзер открыл пост в полном экране
 *    (PostOverlay → POST /api/reads); скролл ленты чтением НЕ считается;
 *  • СТРИК — дни подряд. Заморозка (❄️) автоматически покрывает ОДИН
 *    пропущенный день; две «дыры» подряд рвут серию — честно и предсказуемо;
 *  • ВЕХИ 7/30/100 дней: разовая награда свайпами + +1 заморозка (кап 3).
 *    Стрик перезапускается — веха достижима в каждом цикле заново;
 *  • ЦЕЛЬ НЕДЕЛИ: 30 постов за ISO-неделю (MSK, как в лидербордах) →
 *    разовая награда 300 свайпов (weekRewardKey страхует от повтора).
 *
 * Идемпотентность/абьюз:
 *  • один пост считается один раз в сутки на юзера (Redis-дедуп read:* 24ч,
 *    переживает рестарты инстансов — в отличие от in-memory Set);
 *  • все начисления — атомарные increment'ы, уникальные ключи и маркеры;
 *  • гости не пишутся вовсе (нет наград — нет и строк в БД).
 *
 * CPU-бюджет: запись прочтения — 1 Redis GET + 3 дешёвых SQL upsert'а только
 * в день первого прочтения (дедуп отсекает повторы ДО БД). GET /api/reading —
 * один юзер, индексные выборки.
 */

/** Цель недели: сколько постов нужно прочитать */
export const WEEK_GOAL = 30
/** Награда за выполнение цели недели (раз в неделю) */
export const WEEK_REWARD = 300
/** Вехи стрика: дней → свайпов */
export const STREAK_MILESTONES: ReadonlyArray<{ days: number; reward: number }> = [
  { days: 7, reward: 500 },
  { days: 30, reward: 2500 },
  { days: 100, reward: 10000 },
]
/** Максимум заморозок на балансе */
export const FREEZE_CAP = 3

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000

/** 'YYYY-MM-DD' UTC — та же конвенция дней, что у DailyCheckin (v5.70) */
export function dayKeyUtc(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

function dayKeyShifted(days: number, now = new Date()): string {
  return dayKeyUtc(new Date(now.getTime() - days * 24 * 3_600_000))
}

/** ISO-неделя по MSK: ключ '2026-W38', начало — понедельник 00:00 MSK (как в lb-payouts) */
export function readingWeekKey(now = new Date()): string {
  const shifted = new Date(now.getTime() + MSK_OFFSET_MS)
  const t = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()))
  const dayNum = (t.getUTCDay() + 6) % 7 // Пн=0..Вс=6
  const monday = new Date(t)
  monday.setUTCDate(t.getUTCDate() - dayNum)
  const thursday = new Date(monday)
  thursday.setUTCDate(monday.getUTCDate() + 3)
  const isoYear = thursday.getUTCFullYear()
  const jan4 = new Date(Date.UTC(isoYear, 0, 4))
  const jan4Day = (jan4.getUTCDay() + 6) % 7
  const week1Monday = new Date(jan4)
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day)
  const week = 1 + Math.round((monday.getTime() - week1Monday.getTime()) / (7 * 24 * 3_600_000))
  return `${isoYear}-W${String(week).padStart(2, '0')}`
}

/* --------------------------------- Типы ---------------------------------- */

export type ReadingStats = {
  streak: number
  bestStreak: number
  freezes: number
  todayReads: number
  totalReads: number
  weekReads: number
  weekGoal: number
  weekReward: number
  /** последняя выполненная веха и ближайшая следующая (для прогресса в UI) */
  milestones: { days: number; reward: number; reached: boolean }[]
  /** последние 35 дней: { day, reads } — календарь в UI */
  history: { day: string; reads: number }[]
}

/* ------------------------------ Начисления ------------------------------- */

async function creditSwipes(userId: string, amount: number, note: string): Promise<void> {
  await db
    .$transaction([
      db.user.update({ where: { id: userId }, data: { swipes: { increment: amount } } }),
      db.balanceLog.create({ data: { userId, kind: 'admin', currency: 'swp', amount, note } }),
    ])
    .catch((e) => console.error('[reading] creditSwipes', userId, e))
  await invalidateBalance(userId).catch(() => {})
}

/* --------------------------- Запись прочтения ---------------------------- */

export type RecordReadResult = { counted: boolean; streak: number }

/** L0-дедуп в памяти процесса (глобальный синглтон — роут-бандлы Next изолированы) */
const readDedupe = (globalThis as unknown as { __tgfeedReadDedupe?: Map<string, number> }).__tgfeedReadDedupe ??= new Map<string, number>()

function dedupeSeen(key: string): boolean {
  const now = Date.now()
  const at = readDedupe.get(key)
  if (at && now - at < 24 * 3_600_000) return true
  if (readDedupe.size > 3000) {
    for (const [k, t] of readDedupe) if (now - t > 24 * 3_600_000) readDedupe.delete(k)
  }
  return false
}

function dedupeMark(key: string): void {
  readDedupe.set(key, Date.now())
}

/**
 * Зачесть прочтение поста. Дедуп «один пост в сутки на юзера» — L0 память +
 * L1 Redis (переживает рестарты и работает между инстансами Vercel) ДО любых
 * обращений к БД. Вся логика стрика/недели — лениво, здесь же.
 */
export async function recordRead(userId: string, postId: string, now = new Date()): Promise<RecordReadResult> {
  const dedupeKey = `read:${userId}:${postId}`
  if (dedupeSeen(dedupeKey)) return { counted: false, streak: 0 }
  dedupeMark(dedupeKey)
  const seen = await cacheGet<string>(dedupeKey).catch(() => null)
  if (seen) return { counted: false, streak: 0 }
  await cacheSet(dedupeKey, '1', 24 * 3600).catch(() => {})

  const today = dayKeyUtc(now)

  // Дневной счётчик (создаётся/инкрементируется одним upsert'ом)
  await db.readingDay
    .upsert({
      where: { userId_day: { userId, day: today } },
      create: { userId, day: today, reads: 1 },
      update: { reads: { increment: 1 } },
    })
    .catch((e) => console.error('[reading] ReadingDay upsert', userId, e))

  // Стрик + неделя: одна строка на юзера, читаем-решаем-пишем
  const row = await db.readingStreak.findUnique({ where: { userId } })
  if (!row) {
    // Первое прочтение вообще: серия 1, неделя стартует
    await db.readingStreak
      .create({
        data: { userId, streak: 1, bestStreak: 1, lastDate: today, totalReads: 1, weekKey: readingWeekKey(now), weekReads: 1 },
      })
      .catch(async (e) => {
        // Гонка двух параллельных прочтений — строка уже есть: досчитываем общим путём
        if ((e as { code?: string })?.code === 'P2002') {
          return recheckRow(userId, today, now)
        }
        console.error('[reading] ReadingStreak create', userId, e)
        return null
      })
    await milestoneCheck(userId, 1)
    return { counted: true, streak: 1 }
  }

  if (row.lastDate !== today) {
    const yesterday = dayKeyShifted(1, now)
    const dayBefore = dayKeyShifted(2, now)
    let streak: number
    let freezes = row.freezes
    if (row.lastDate === yesterday) {
      streak = row.streak + 1
    } else if (row.lastDate === dayBefore && freezes > 0) {
      // Заморозка молча покрыла вчера — серия продолжается
      streak = row.streak + 1
      freezes -= 1
    } else {
      streak = 1
      freezes = row.freezes // длинная пауза: заморозки не тратим (покрывают ровно 1 день)
    }
    const bestStreak = Math.max(row.bestStreak, streak)
    const weekKey = readingWeekKey(now)
    const newWeek = row.weekKey !== weekKey
    const weekReads = newWeek ? 1 : row.weekReads + 1
    const totalReads = row.totalReads + 1
    await db.readingStreak
      .update({
        where: { userId },
        data: { streak, bestStreak, lastDate: today, freezes, totalReads, weekKey, weekReads },
      })
      .catch((e) => console.error('[reading] ReadingStreak update', userId, e))
    await milestoneCheck(userId, streak)
    await weekGoalCheck(userId, weekReads, weekKey, row.weekRewardKey)
    return { counted: true, streak }
  }

  // Уже читали сегодня: стрик не трогаем, считаем неделю и тотал
  const weekKey = readingWeekKey(now)
  const newWeek = row.weekKey !== weekKey
  const weekReads = newWeek ? 1 : row.weekReads + 1
  await db.readingStreak
    .update({
      where: { userId },
      data: { totalReads: { increment: 1 }, weekKey, weekReads },
    })
    .catch((e) => console.error('[reading] ReadingStreak update same-day', userId, e))
  if (newWeek) {
    await weekGoalCheck(userId, weekReads, weekKey, row.weekRewardKey)
  }
  return { counted: true, streak: row.streak }
}

/** Фолбэк гонки create: строка существует — дозачёт тем же алгоритмом */
async function recheckRow(userId: string, today: string, now: Date): Promise<null> {
  const row = await db.readingStreak.findUnique({ where: { userId } }).catch(() => null)
  if (!row) return null
  if (row.lastDate !== today) {
    const yesterday = dayKeyShifted(1, now)
    const dayBefore = dayKeyShifted(2, now)
    let streak: number
    let freezes = row.freezes
    if (row.lastDate === yesterday) streak = row.streak + 1
    else if (row.lastDate === dayBefore && freezes > 0) {
      streak = row.streak + 1
      freezes -= 1
    } else streak = 1
    const weekKey = readingWeekKey(now)
    const weekReads = row.weekKey !== weekKey ? 1 : row.weekReads + 1
    await db.readingStreak
      .update({
        where: { userId },
        data: {
          streak,
          bestStreak: Math.max(row.bestStreak, streak),
          lastDate: today,
          freezes,
          totalReads: { increment: 1 },
          weekKey,
          weekReads,
        },
      })
      .catch(() => {})
    await milestoneCheck(userId, streak)
    await weekGoalCheck(userId, weekReads, weekKey, row.weekRewardKey)
  } else {
    const weekKey = readingWeekKey(now)
    const weekReads = row.weekKey !== weekKey ? 1 : row.weekReads + 1
    await db.readingStreak
      .update({ where: { userId }, data: { totalReads: { increment: 1 }, weekKey, weekReads } })
      .catch(() => {})
    if (row.weekKey !== weekKey) await weekGoalCheck(userId, weekReads, weekKey, row.weekRewardKey)
  }
  return null
}

/** Веха стрика: streak ровно на значении вехи (монотонный +1 — один раз за цикл) */
async function milestoneCheck(userId: string, streak: number): Promise<void> {
  const m = STREAK_MILESTONES.find((x) => x.days === streak)
  if (!m) return
  await creditSwipes(userId, m.reward, `Награда за стрик чтения: ${m.days} дней`)
  await db.readingStreak
    .updateMany({
      where: { userId, freezes: { lt: FREEZE_CAP } },
      data: { freezes: { increment: 1 } },
    })
    .catch(() => {})
  sendBotNotification({
    userId,
    type: 'system',
    title: `🔥 Стрик чтения: ${m.days} ${m.days === 7 ? 'дней' : 'дней'}!`,
    body: `Вы читаете ${m.days} дней подряд. +${m.reward.toLocaleString('ru-RU')} свайпов и +1 заморозка уже на балансе — не останавливайтесь!`,
  })
}

/** Цель недели: ровно на пороге и награда за эту неделю ещё не выдавалась */
async function weekGoalCheck(
  userId: string,
  weekReads: number,
  weekKey: string,
  rewardKey: string,
): Promise<void> {
  if (weekReads !== WEEK_GOAL || rewardKey === weekKey) return
  // Условная запись + повторная проверка внутри — защита от гонки двух прочтений
  const res = await db.readingStreak
    .updateMany({ where: { userId, weekRewardKey: { not: weekKey } }, data: { weekRewardKey: weekKey } })
    .catch(() => null)
  if (!res || res.count === 0) return
  await creditSwipes(userId, WEEK_REWARD, `Цель недели выполнена: ${WEEK_GOAL} постов (${weekKey})`)
  sendBotNotification({
    userId,
    type: 'system',
    title: '🎯 Цель недели выполнена!',
    body: `${WEEK_GOAL} постов за неделю — солидно. +${WEEK_REWARD} свайпов уже на балансе. Новая цель стартовала!`,
  })
}

/* ------------------------------ Чтение статов ----------------------------- */

/** Статы для карточки/экрана в профиле (индексные выборки, один юзер) */
export async function getReadingStats(userId: string, now = new Date()): Promise<ReadingStats> {
  const today = dayKeyUtc(now)
  const historyStart = dayKeyShifted(34, now)
  const [row, todayRow, history] = await Promise.all([
    db.readingStreak.findUnique({ where: { userId } }),
    db.readingDay.findUnique({ where: { userId_day: { userId, day: today } }, select: { reads: true } }),
    db.readingDay.findMany({
      where: { userId, day: { gte: historyStart } },
      select: { day: true, reads: true },
      orderBy: { day: 'asc' },
    }),
  ])
  const byDay = new Map(history.map((h) => [h.day, h.reads]))
  const calendar: { day: string; reads: number }[] = []
  for (let i = 34; i >= 0; i--) {
    const d = dayKeyShifted(i, now)
    calendar.push({ day: d, reads: byDay.get(d) ?? 0 })
  }
  const best = row?.bestStreak ?? 0
  return {
    streak: row?.streak ?? 0,
    bestStreak: best,
    freezes: row?.freezes ?? 0,
    todayReads: todayRow?.reads ?? 0,
    totalReads: row?.totalReads ?? 0,
    weekReads: row?.weekKey === readingWeekKey(now) ? row.weekReads : 0,
    weekGoal: WEEK_GOAL,
    weekReward: WEEK_REWARD,
    milestones: STREAK_MILESTONES.map((m) => ({ ...m, reached: best >= m.days })),
    history: calendar,
  }
}

/**
 * Порог неактивности для реактивационного пуша: daysBetween по строкам дней.
 * Возвращает null для битых дат (не пишем таким).
 */
export function inactiveDaysSince(lastDate: string, now = new Date()): number | null {
  const t = Date.parse(`${lastDate}T00:00:00Z`)
  if (!Number.isFinite(t)) return null
  const today = Date.parse(`${dayKeyUtc(now)}T00:00:00Z`)
  return Math.round((today - t) / 86_400_000)
}
