/**
 * СИСТЕМА ДОСТИЖЕНИЙ (v5.90) — каталог ачивок.
 *
 * Этот файл — ОБЩИЙ источник правды для сервера (lib/achievements-server.ts)
 * и клиента (AchievementsSheet). ВАЖНО: здесь НЕТ импортов БД/сервера —
 * модуль попадает в клиентский бандл.
 *
 * Устройство:
 *  • 10 ачивок × 3 ступени (бронза/серебро/золото);
 *  • метрики дёшево вычисляются по индексам (count/сумма/одно поле);
 *  • прогресс ступени = «дошёл до порога N» (монотонный, не откатывается);
 *  • награды за ступень: свайпы + XP (XP через grantXp kind 'achievement');
 *  • названия/описания — ru/en пары прямо в каталоге (i18n словарь не тянем:
 *    бот-уведомления сервера тоже берут текст отсюда).
 */

export type AchievementMetric =
  | 'views'
  | 'likes_given'
  | 'comments'
  | 'bookmarks'
  | 'likes_received'
  | 'streak'
  | 'checkins'
  | 'level'
  | 'subscriptions'
  | 'quests'

export type AchievementTier = {
  /** Порог: метрика >= value → ступень открыта */
  value: number
  /** Награда: свайпы на баланс + XP в уровень */
  swipes: number
  xp: number
}

export type AchievementDef = {
  id: string
  metric: AchievementMetric
  /** Категория для группировки/цвета в UI */
  group: 'activity' | 'social' | 'collection' | 'progress'
  /** lucide-иконка (строкой — чтобы не тянуть компоненты в серверный код) */
  icon: string
  name: { ru: string; en: string }
  desc: { ru: string; en: string }
  tiers: [AchievementTier, AchievementTier, AchievementTier]
}

/** Награды ступеней (единая сетка: бронза/серебро/золото) */
export const TIER_REWARDS: [AchievementTier, AchievementTier, AchievementTier] = [
  { value: 0, swipes: 50, xp: 10 }, // value подменяется порогом конкретной ачивки
  { value: 0, swipes: 150, xp: 25 },
  { value: 0, swipes: 400, xp: 50 },
]

export const ACHIEVEMENTS: AchievementDef[] = [
  {
    id: 'viewer',
    metric: 'views',
    group: 'activity',
    icon: 'Eye',
    name: { ru: 'Листатель', en: 'Page Turner' },
    desc: { ru: 'Смотри посты в ленте', en: 'Browse posts in the feed' },
    tiers: [
      { value: 100, swipes: 50, xp: 10 },
      { value: 1000, swipes: 150, xp: 25 },
      { value: 10000, swipes: 400, xp: 50 },
    ],
  },
  {
    id: 'liker',
    metric: 'likes_given',
    group: 'social',
    icon: 'Heart',
    name: { ru: 'Щедрая душа', en: 'Generous Heart' },
    desc: { ru: 'Отмечай посты «Интересно»', en: 'Like posts you enjoy' },
    tiers: [
      { value: 10, swipes: 50, xp: 10 },
      { value: 100, swipes: 150, xp: 25 },
      { value: 1000, swipes: 400, xp: 50 },
    ],
  },
  {
    id: 'commenter',
    metric: 'comments',
    group: 'social',
    icon: 'MessageCircle',
    name: { ru: 'Голос', en: 'Voice' },
    desc: { ru: 'Пиши комментарии (видимые)', en: 'Write visible comments' },
    tiers: [
      { value: 5, swipes: 50, xp: 10 },
      { value: 50, swipes: 150, xp: 25 },
      { value: 500, swipes: 400, xp: 50 },
    ],
  },
  {
    id: 'saver',
    metric: 'bookmarks',
    group: 'collection',
    icon: 'Bookmark',
    name: { ru: 'Коллекционер', en: 'Collector' },
    desc: { ru: 'Сохраняй посты на потом', en: 'Bookmark posts for later' },
    tiers: [
      { value: 5, swipes: 50, xp: 10 },
      { value: 25, swipes: 150, xp: 25 },
      { value: 100, swipes: 400, xp: 50 },
    ],
  },
  {
    id: 'applauded',
    metric: 'likes_received',
    group: 'social',
    icon: 'Sparkles',
    name: { ru: 'Признание', en: 'Recognition' },
    desc: { ru: 'Собирай лайки на свои комментарии', en: 'Earn likes on your comments' },
    tiers: [
      { value: 10, swipes: 50, xp: 10 },
      { value: 100, swipes: 150, xp: 25 },
      { value: 1000, swipes: 400, xp: 50 },
    ],
  },
  {
    id: 'streaker',
    metric: 'streak',
    group: 'progress',
    icon: 'Flame',
    name: { ru: 'Терпение', en: 'Persistence' },
    desc: { ru: 'Держи серию ежедневных входов', en: 'Keep your daily streak alive' },
    tiers: [
      { value: 3, swipes: 50, xp: 10 },
      { value: 7, swipes: 150, xp: 25 },
      { value: 30, swipes: 400, xp: 50 },
    ],
  },
  {
    id: 'loyalist',
    metric: 'checkins',
    group: 'progress',
    icon: 'CalendarCheck',
    name: { ru: 'Верный читатель', en: 'Loyal Reader' },
    desc: { ru: 'Заходи каждый день (чек-ины)', en: 'Check in every day' },
    tiers: [
      { value: 10, swipes: 50, xp: 10 },
      { value: 50, swipes: 150, xp: 25 },
      { value: 200, swipes: 400, xp: 50 },
    ],
  },
  {
    id: 'climber',
    metric: 'level',
    group: 'progress',
    icon: 'TrendingUp',
    name: { ru: 'Восхождение', en: 'Climber' },
    desc: { ru: 'Качай уровень за активность', en: 'Level up with activity' },
    tiers: [
      { value: 5, swipes: 50, xp: 10 },
      { value: 10, swipes: 150, xp: 25 },
      { value: 25, swipes: 400, xp: 50 },
    ],
  },
  {
    id: 'explorer',
    metric: 'subscriptions',
    group: 'collection',
    icon: 'Compass',
    name: { ru: 'Исследователь', en: 'Explorer' },
    desc: { ru: 'Подписывайся на каналы', en: 'Subscribe to channels' },
    tiers: [
      { value: 3, swipes: 50, xp: 10 },
      { value: 10, swipes: 150, xp: 25 },
      { value: 30, swipes: 400, xp: 50 },
    ],
  },
  {
    id: 'hunter',
    metric: 'quests',
    group: 'activity',
    icon: 'ListChecks',
    name: { ru: 'Достигатор', en: 'Quest Hunter' },
    desc: { ru: 'Выполняй задания', en: 'Complete quests' },
    tiers: [
      { value: 1, swipes: 50, xp: 10 },
      { value: 10, swipes: 150, xp: 25 },
      { value: 50, swipes: 400, xp: 50 },
    ],
  },
]

export const ACHIEVEMENT_MAP: Map<string, AchievementDef> = new Map(
  ACHIEVEMENTS.map((a) => [a.id, a]),
)

/** Максимальный порог ачивки (для глобального прогресса «до золота») */
export function achievementMaxValue(def: AchievementDef): number {
  return def.tiers[def.tiers.length - 1].value
}

/** Всего ступеней во всём каталоге (10 × 3) */
export const ACHIEVEMENT_TOTAL_STEPS = ACHIEVEMENTS.reduce((n, a) => n + a.tiers.length, 0)

/** Тип ответа GET /api/achievements (клиентский контракт) */
export type AchievementRow = {
  id: string
  tier: number // 0 — ничего не открыто
  unlockedAt: string | null // ISO первого зачёта (tier >= 1)
  tierAt: string | null // ISO последнего апгрейда
}

export type AchievementsResponse = {
  achievements: AchievementRow[]
  metrics: Record<AchievementMetric, number>
  /** Сколько ступеней открыто (для карточки в профиле) */
  unlockedSteps: number
  totalSteps: number
}

/** Название ступени (для UI и уведомлений) */
export function tierTitle(tier: number, lang: 'ru' | 'en'): string {
  if (lang === 'en') return tier >= 3 ? 'Gold' : tier === 2 ? 'Silver' : 'Bronze'
  return tier >= 3 ? 'золото' : tier === 2 ? 'серебро' : 'бронза'
}

/** Иконка ступени для UI: 🥉 / 🥈 / 🥇 */
export function tierEmoji(tier: number): string {
  return tier >= 3 ? '🥇' : tier === 2 ? '🥈' : '🥉'
}
