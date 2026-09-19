/**
 * Бейджи пользователей Tg Swipe (v5.19).
 *
 * Хранение: User.badges — JSON-массив слагов (как categories) — колонка одна,
 * чтение вместе с юзером без JOIN, новые виды бейджей добавляются кодом.
 * Выдача/отзыв — только через админ-панель (x-admin-key), каждое действие
 * пишется в AdminLog (badge_grant / badge_revoke).
 *
 * Модуль общий (клиент + сервер): без импортов db/env — безопасен в бандле.
 */

export type BadgeSlug =
  | 'developer'
  | 'manager'
  | 'sponsor'
  | 'moderator'
  | 'vip'
  | 'early'

export type BadgeDef = {
  slug: BadgeSlug
  /** Название на русском */
  label: string
  /** Короткое описание (подсказка в админке) */
  hint: string
  /** Иконка — имя из lucide-react (рендер на клиенте) */
  icon: 'Code2' | 'ClipboardCheck' | 'HeartHandshake' | 'ShieldCheck' | 'Crown' | 'Sparkles'
  /**
   * Цвета чипа (Tailwind-классы): фон/текст светлой темы + dark-вариант,
   * сплошной фон для «серьёзных» мест (аватар-статтер, список админки).
   */
  chip: string
  chipDark: string
  solid: string
  /** Hex-цвет для аватар-ринга и акцентов */
  hex: string
  /** Порядок значимости (меньше — главнее) */
  rank: number
}

export const BADGES: Record<BadgeSlug, BadgeDef> = {
  developer: {
    slug: 'developer',
    label: 'Разработчик',
    hint: 'Команда разработки Tg Swipe',
    icon: 'Code2',
    chip: 'bg-violet-100 text-violet-700 border-violet-200',
    chipDark: 'dark:bg-violet-500/15 dark:text-violet-300 dark:border-violet-500/30',
    solid: 'bg-violet-600 text-white',
    hex: '#7c3aed',
    rank: 0,
  },
  manager: {
    slug: 'manager',
    label: 'Менеджер',
    hint: 'Менеджер проекта: поддержка, работа с каналами',
    icon: 'ClipboardCheck',
    chip: 'bg-cyan-100 text-cyan-700 border-cyan-200',
    chipDark: 'dark:bg-cyan-500/15 dark:text-cyan-300 dark:border-cyan-500/30',
    solid: 'bg-cyan-600 text-white',
    hex: '#0891b2',
    rank: 1,
  },
  moderator: {
    slug: 'moderator',
    label: 'Модератор',
    hint: 'Модерация комментариев, каналов и рекламных кампаний',
    icon: 'ShieldCheck',
    chip: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    chipDark: 'dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30',
    solid: 'bg-emerald-600 text-white',
    hex: '#059669',
    rank: 2,
  },
  sponsor: {
    slug: 'sponsor',
    label: 'Спонсор',
    hint: 'Поддержал проект финансово',
    icon: 'HeartHandshake',
    chip: 'bg-amber-100 text-amber-700 border-amber-200',
    chipDark: 'dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30',
    solid: 'bg-amber-500 text-white',
    hex: '#f59e0b',
    rank: 3,
  },
  vip: {
    slug: 'vip',
    label: 'VIP',
    hint: 'Особый статус по решению администрации',
    icon: 'Crown',
    chip: 'bg-rose-100 text-rose-700 border-rose-200',
    chipDark: 'dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/30',
    solid: 'bg-rose-500 text-white',
    hex: '#f43f5e',
    rank: 4,
  },
  early: {
    slug: 'early',
    label: 'Ранний',
    hint: 'Первые пользователи Tg Swipe',
    icon: 'Sparkles',
    chip: 'bg-orange-100 text-orange-700 border-orange-200',
    chipDark: 'dark:bg-orange-500/15 dark:text-orange-300 dark:border-orange-500/30',
    solid: 'bg-orange-500 text-white',
    hex: '#f97316',
    rank: 5,
  },
}

export const BADGE_LIST: BadgeDef[] = Object.values(BADGES).sort((a, b) => a.rank - b.rank)

export const BADGE_SLUGS: BadgeSlug[] = BADGE_LIST.map((b) => b.slug)

function isBadgeSlug(v: unknown): v is BadgeSlug {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(BADGES, v)
}

/**
 * Распарсить JSON-поле User.badges → массив валидных слагов, отсортированный
 * по значимости. Некорректные/устаревшие значения молча отбрасываются.
 */
export function parseBadges(json?: string | null): BadgeSlug[] {
  if (!json) return []
  if (json.length < 4) return []
  try {
    const raw: unknown = JSON.parse(json)
    if (!Array.isArray(raw)) return []
    const seen = new Set<BadgeSlug>()
    for (const v of raw) if (isBadgeSlug(v)) seen.add(v)
    return [...seen].sort((a, b) => BADGES[a].rank - BADGES[b].rank)
  } catch {
    return []
  }
}

/** Сериализовать массив слагов (дедуп + сортировка) для записи в БД */
export function serializeBadges(slugs: Iterable<BadgeSlug>): string {
  const seen = new Set<BadgeSlug>()
  for (const s of slugs) if (isBadgeSlug(s)) seen.add(s)
  return JSON.stringify([...seen].sort((a, b) => BADGES[a].rank - BADGES[b].rank))
}

/** Главный (самый значимый) бейдж — для показа одной иконки у имени */
export function primaryBadge(slugs: BadgeSlug[] | string | null | undefined): BadgeDef | null {
  const list = typeof slugs === 'string' ? parseBadges(slugs) : slugs ?? []
  return list.length ? BADGES[list[0]] : null
}

/** Все ли слаги существуют (валидация входа админ-API) */
export function allBadgesExist(v: unknown): v is BadgeSlug[] {
  return Array.isArray(v) && v.length > 0 && v.every(isBadgeSlug)
}
