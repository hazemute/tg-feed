/**
 * ПРАВИЛА XP/УРОВНЕЙ (v5.75) — чистая математика без зависимостей от БД.
 * Импортируется и сервером (lib/xp.ts), и клиентом (LevelBar/LevelSheet) —
 * единый источник правды по значениям и кривой уровней.
 */

/** Значения XP по видам активности (знаковые) */
export const XP_RULES = {
  /** Толковый комментарий (≥ commentMinLen символов, не скрытый антирекламой) */
  comment: 2,
  commentMinLen: 10,
  /** Сколько комментариев в сутки приносят XP (дальше — без XP, против фарма) */
  commentDailyCap: 10,
  /** Лайк, полученный на свой комментарий */
  like: 1,
  likeDailyCap: 30,
  /** Выполненное задание (вкладка «Задания») */
  quest: 5,
  /** Ежедневный чек-ин */
  checkin: 3,
  /** Нарушения: комментарий скрыт по жалобам / удалён модератором */
  violationComment: -15,
  /** Нарушение: бан аккаунта */
  violationBan: -50,
  /** Найденный баг: выдаёт ТОЛЬКО админ вручную (панель → пользователи → «XP») */
  bugMin: 10,
  bugMax: 1000,
} as const

/** Шаг кривой: XP от уровня L до L+1 = 100 + 60·(L−1) */
export function xpStepForLevel(level: number): number {
  return 100 + 60 * Math.max(0, level - 1)
}

/** Суммарный XP, необходимый для достижения уровня L (S(1)=0): 100·n + 30·n·(n−1), n = L−1 */
export function xpForLevel(level: number): number {
  const n = Math.max(1, level) - 1
  return 100 * n + 30 * n * (n - 1)
}

/** Уровень по суммарному XP (максимальный L, для которого S(L) ≤ xp) */
export function levelFromXp(xp: number): number {
  let level = 1
  while (xpForLevel(level + 1) <= xp && level < 500) level++
  return level
}

/** Свайпов за достижение уровня newLevel: 60 + 40·newLevel (ур.2→140, ур.10→460, ур.20→860) */
export function swipesForLevelUp(newLevel: number): number {
  return 60 + 40 * Math.max(1, newLevel)
}

export type LevelProgress = {
  xp: number
  level: number
  /** XP внутри текущего уровня (от порога этого уровня) */
  inLevelXp: number
  /** Сколько XP нужно до следующего уровня */
  needXp: number
  levelStart: number
  levelEnd: number
  /** Прогресс 0..1 */
  pct: number
  /** Свайпов дадут за следующий уровень */
  nextRewardSwipes: number
}

export function levelProgress(xp: number, level: number): LevelProgress {
  const safeLevel = Math.max(1, level)
  const levelStart = xpForLevel(safeLevel)
  const levelEnd = xpForLevel(safeLevel + 1)
  const inLevelXp = Math.max(0, xp - levelStart)
  const needXp = Math.max(0, levelEnd - xp)
  return {
    xp,
    level: safeLevel,
    inLevelXp,
    needXp,
    levelStart,
    levelEnd,
    pct: Math.min(1, Math.max(0, inLevelXp / Math.max(1, levelEnd - levelStart))),
    nextRewardSwipes: swipesForLevelUp(safeLevel + 1),
  }
}
