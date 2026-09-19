/**
 * Единый каталог оформления профиля Tg Swipe (v5.27).
 *
 * Три каталога: палитра обложки (background за аватаром), узор поверх
 * обложки, рамка аватара. Анимированные узоры/рамки — только tier Plus/Pro
 * (или Telegram Premium — владелец не должен видеть замки на себе).
 *
 * ── КОНТРАКТ ДЛЯ ФРОНТЕНДА ──────────────────────────────────────────────
 *  - palette.css / bg.css / frame.css — значение для CSS-ШОРТКАТА
 *    `background` (style={{ background: x.css }}). В значениях могут быть
 *    встроены позиция/размер слоёв (`... 0 0 / 24px 24px repeat`), поэтому
 *    именно шорткат, а не backgroundImage.
 *  - Палитра: фон самого блока обложки (шапка профиля).
 *  - Узор (bg): ОТДЕЛЬНЫЙ div-слой ПОВЕРХ палитры (absolute inset-0):
 *    parent style={{ background: palette.css }}, узор style={{ background: bg.css }}.
 *  - Рамка (frame): обёртка вокруг аватара — padding:3px, borderRadius:9999px,
 *    background: frame.css; поле glow (если задано) — boxShadow той же
 *    обёртки; аватар внутри <img class="h-full w-full rounded-full">.
 *  - Анимации: BG_ANIM_CLASS[id] вешается на div узора, FRAME_ANIM_CLASS[id] —
 *    на обёртку рамки. Сами @keyframes/классы живут в src/app/globals.css
 *    (префикс prof-; transform/opacity/background-position — дёшево для CPU).
 *    Для prof-bg-rays контейнер узора должен лежать в overflow-hidden
 *    (обёртка обложки) — слой вращается с запасом масштаба.
 *  - Замки: анимированные узоры и рамки (animated: true / locked: 'plus')
 *    открываются только hasPlusAccess(tier, isPremium) — см. хелперы ниже.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Модуль общий (клиент + сервер): без импортов db/env — безопасен в бандле.
 */

export type ProfileStyleKind = 'palette' | 'bg' | 'frame'

/** Палитра обложки профиля: css — фон шапки, accent — цвет имени/кнопок на ней */
export type ProfilePalette = { id: string; name: string; css: string; accent: string; dark?: boolean }

/** Узор поверх обложки: css — фон отдельного div-слоя (background-шорткат) */
export type ProfileBg = { id: string; name: string; css: string; animated: boolean }

/** Рамка аватара: css — фон обёртки с padding:3px; glow — свечение (boxShadow) */
export type ProfileFrame = { id: string; name: string; css: string; animated: boolean; locked: 'free' | 'plus'; glow?: string }

// ── Палитры обложки (12) ─────────────────────────────────────────────────
// Без синего/индиго как основного: багрово-фиолетово-розовые, тёплые,
// зелёные, тёмные. Первая и главная — crimson (референс владельца:
// тёмно-красная обложка #7f1d1d → #991b1b → #57534e).

export const PROFILE_PALETTES: ProfilePalette[] = [
  {
    id: 'crimson',
    name: 'Багровый',
    css: 'linear-gradient(165deg, #7f1d1d 0%, #991b1b 45%, #57534e 100%)',
    accent: '#fecaca',
    dark: true,
  },
  {
    id: 'sunset',
    name: 'Закат',
    css: 'radial-gradient(120% 130% at 80% 0%, #fbbf24 0%, #f97316 42%, #be123c 100%)',
    accent: '#fff7ed',
    dark: true,
  },
  {
    id: 'orchid',
    name: 'Орхидея',
    css: 'linear-gradient(140deg, #f5d0fe 0%, #d8b4fe 35%, #a21caf 100%)',
    accent: '#fdf4ff',
    dark: true,
  },
  {
    id: 'forest',
    name: 'Лес',
    css: 'linear-gradient(160deg, #166534 0%, #14532d 50%, #1a2e05 100%)',
    accent: '#bbf7d0',
    dark: true,
  },
  {
    id: 'midnight',
    name: 'Полночь',
    css: 'linear-gradient(170deg, #292524 0%, #1c1917 55%, #0c0a09 100%)',
    accent: '#e7e5e4',
    dark: true,
  },
  {
    id: 'plum',
    name: 'Слива',
    css: 'linear-gradient(150deg, #6b21a8 0%, #581c87 45%, #2e1065 100%)',
    accent: '#f3e8ff',
    dark: true,
  },
  {
    id: 'honey',
    name: 'Мёд',
    css: 'linear-gradient(145deg, #fbbf24 0%, #f59e0b 40%, #b45309 100%)',
    accent: '#78350f',
    dark: false,
  },
  {
    id: 'sage',
    name: 'Шалфей',
    css: 'linear-gradient(150deg, #f1f5eb 0%, #d8e4d0 45%, #a4b89e 100%)',
    accent: '#3f5240',
    dark: false,
  },
  {
    id: 'rosewood',
    name: 'Розовое дерево',
    css: 'linear-gradient(150deg, #9f1239 0%, #881337 45%, #4c0519 100%)',
    accent: '#fecdd3',
    dark: true,
  },
  {
    id: 'ember',
    name: 'Угли',
    css: 'radial-gradient(95% 120% at 50% 115%, #f97316 0%, #c2410c 32%, #292524 68%, #0c0a09 100%)',
    accent: '#fdba74',
    dark: true,
  },
  {
    id: 'pearl',
    name: 'Жемчуг',
    css: 'linear-gradient(155deg, #fafaf9 0%, #e7e5e4 50%, #c7c3bf 100%)',
    accent: '#44403c',
    dark: false,
  },
  {
    id: 'mono',
    name: 'Графит',
    css: 'linear-gradient(170deg, #3f3f46 0%, #27272a 55%, #18181b 100%)',
    accent: '#fafafa',
    dark: true,
  },
]

// ── Узор поверх палитры (10, 'none' — без узора) ──────────────────────────
// Статические: точки / диагональные полосы / сетка / волны (чешуйка) /
// мягкая шахматка. Анимированные: aurora / bubbles / rays / shimmer —
// движение добавляет класс из BG_ANIM_CLASS (globals.css, prefix prof-).

export const PROFILE_BGS: ProfileBg[] = [
  { id: 'none', name: 'Без узора', css: 'none', animated: false },
  {
    id: 'dots',
    name: 'Точки',
    css: 'radial-gradient(rgba(255,255,255,0.16) 1.5px, transparent 1.6px) 0 0 / 22px 22px repeat',
    animated: false,
  },
  {
    id: 'stripes',
    name: 'Полосы',
    css: 'repeating-linear-gradient(45deg, rgba(255,255,255,0.07) 0 10px, transparent 10px 24px)',
    animated: false,
  },
  {
    id: 'grid',
    name: 'Сетка',
    css: 'linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px) 0 0 / 28px 28px repeat, linear-gradient(90deg, rgba(255,255,255,0.08) 1px, transparent 1px) 0 0 / 28px 28px repeat',
    animated: false,
  },
  {
    id: 'waves',
    name: 'Волны',
    css: 'radial-gradient(circle at 50% 0%, transparent 12px, rgba(255,255,255,0.10) 13px 15px, transparent 16px) 0 0 / 36px 36px repeat',
    animated: false,
  },
  {
    id: 'checker',
    name: 'Шахматка',
    css: 'conic-gradient(rgba(255,255,255,0.06) 0 25%, transparent 0 50%, rgba(255,255,255,0.06) 0 75%, transparent 0) 0 0 / 28px 28px repeat',
    animated: false,
  },
  {
    id: 'aurora',
    name: 'Северное сияние',
    css: 'linear-gradient(110deg, rgba(52,211,153,0.32) 0%, rgba(168,85,247,0.30) 30%, rgba(244,114,182,0.30) 55%, rgba(251,191,36,0.26) 80%, rgba(52,211,153,0.32) 100%) 0 0 / 300% 300%',
    animated: true,
  },
  {
    id: 'bubbles',
    name: 'Пузырьки',
    css: 'radial-gradient(circle at 20% 30%, rgba(255,255,255,0.20) 0 22px, transparent 23px) 0 0 / 100% 100% no-repeat, radial-gradient(circle at 70% 60%, rgba(255,255,255,0.16) 0 34px, transparent 35px) 0 0 / 100% 100% no-repeat, radial-gradient(circle at 45% 85%, rgba(255,255,255,0.14) 0 18px, transparent 19px) 0 0 / 100% 100% no-repeat',
    animated: true,
  },
  {
    id: 'rays',
    name: 'Лучи',
    css: 'repeating-conic-gradient(from 0deg at 50% 50%, rgba(255,255,255,0.09) 0deg 7deg, transparent 7deg 18deg)',
    animated: true,
  },
  {
    id: 'shimmer',
    name: 'Блик',
    css: 'linear-gradient(105deg, transparent 42%, rgba(255,255,255,0.16) 47%, rgba(255,255,255,0.32) 50%, rgba(255,255,255,0.16) 53%, transparent 58%) 0 0 / 300% 100% no-repeat',
    animated: true,
  },
]

// ── Рамки аватара (id: 'none' + статические + анимированные Plus/Pro) ─────
// css — фон обёртки (padding:3px, rounded-full) вокруг аватара; для свечения
// поле glow (boxShadow). Анимированные: вращающийся conic-обод/пульс
// добавляет класс из FRAME_ANIM_CLASS (globals.css), css остаётся статической
// базой (видна до гидрации и при prefers-reduced-motion).

export const PROFILE_FRAMES: ProfileFrame[] = [
  { id: 'none', name: 'Без рамки', css: 'transparent', animated: false, locked: 'free' },
  {
    id: 'ring',
    name: 'Кольцо',
    css: '#ffffff',
    animated: false,
    locked: 'free',
  },
  {
    id: 'gold',
    name: 'Золото',
    css: 'linear-gradient(135deg, #fde68a, #d97706 45%, #f59e0b 70%, #92400e)',
    animated: false,
    locked: 'free',
  },
  {
    id: 'rose',
    name: 'Роза',
    css: 'linear-gradient(135deg, #fda4af, #e11d48 50%, #fbbf24)',
    animated: false,
    locked: 'free',
  },
  {
    id: 'silver',
    name: 'Серебро',
    css: 'linear-gradient(135deg, #f4f4f5, #a1a1aa 50%, #e4e4e7 75%, #71717a)',
    animated: false,
    locked: 'free',
  },
  {
    id: 'candy',
    name: 'Карамель',
    css: 'linear-gradient(135deg, #f9a8d4, #c084fc 50%, #f472b6)',
    animated: false,
    locked: 'free',
  },
  {
    id: 'forest',
    name: 'Хвоя',
    css: 'linear-gradient(135deg, #86efac, #16a34a 55%, #14532d)',
    animated: false,
    locked: 'free',
  },
  {
    id: 'ember',
    name: 'Тлеющий угль',
    css: 'linear-gradient(135deg, #fdba74, #c2410c 60%, #7c2d12)',
    glow: '0 0 14px rgba(249,115,22,0.55)',
    animated: false,
    locked: 'free',
  },
  {
    id: 'aurora-spin',
    name: 'Сияние',
    css: 'linear-gradient(135deg, #34d399, #a855f7)',
    animated: true,
    locked: 'plus',
  },
  {
    id: 'fire',
    name: 'Пламя',
    css: 'linear-gradient(135deg, #fbbf24, #dc2626)',
    animated: true,
    locked: 'plus',
  },
  {
    id: 'pulse',
    name: 'Пульс',
    css: 'linear-gradient(135deg, #fb7185, #a21caf)',
    glow: '0 0 12px rgba(236,72,153,0.45)',
    animated: true,
    locked: 'plus',
  },
  {
    id: 'rainbow',
    name: 'Радуга',
    css: 'linear-gradient(135deg, #ef4444, #eab308, #22c55e, #a855f7)',
    animated: true,
    locked: 'plus',
  },
  {
    id: 'galaxy',
    name: 'Галактика',
    css: 'linear-gradient(135deg, #7e22ce, #db2777 55%, #2e1065)',
    glow: '0 0 16px rgba(168,85,247,0.40)',
    animated: true,
    locked: 'plus',
  },
]

/** Классы анимации узора обложки (globals.css) — вешаются на div узора */
export const BG_ANIM_CLASS: Record<string, string> = {
  aurora: 'prof-bg-aurora',
  bubbles: 'prof-bg-bubbles',
  rays: 'prof-bg-rays',
  shimmer: 'prof-bg-shimmer',
}

/** Классы анимации рамки аватара (globals.css) — вешаются на обёртку рамки */
export const FRAME_ANIM_CLASS: Record<string, string> = {
  'aurora-spin': 'prof-frame-aurora-spin',
  fire: 'prof-frame-fire',
  pulse: 'prof-frame-pulse',
  rainbow: 'prof-frame-rainbow',
  galaxy: 'prof-frame-galaxy',
}

/** Стиль по умолчанию (совпадает с default колонок User.profile* в схеме) */
export const DEFAULT_PROFILE_STYLE = { palette: 'crimson', bg: 'none', frame: 'none' } as const

const PALETTE_BY_ID: Record<string, ProfilePalette> = Object.fromEntries(
  PROFILE_PALETTES.map((p) => [p.id, p]),
)
const BG_BY_ID: Record<string, ProfileBg> = Object.fromEntries(PROFILE_BGS.map((b) => [b.id, b]))
const FRAME_BY_ID: Record<string, ProfileFrame> = Object.fromEntries(
  PROFILE_FRAMES.map((f) => [f.id, f]),
)

/** Палитра по id; неизвестный id → undefined (фолбэк вызывающего — DEFAULT_PROFILE_STYLE.palette) */
export function getPalette(id: string | null | undefined): ProfilePalette | undefined {
  return id ? PALETTE_BY_ID[id] : undefined
}

/** Узор по id; неизвестный id → undefined (фолбэк вызывающего — DEFAULT_PROFILE_STYLE.bg) */
export function getBg(id: string | null | undefined): ProfileBg | undefined {
  return id ? BG_BY_ID[id] : undefined
}

/** Рамка по id; неизвестный id → undefined (фолбэк вызывающего — DEFAULT_PROFILE_STYLE.frame) */
export function getFrame(id: string | null | undefined): ProfileFrame | undefined {
  return id ? FRAME_BY_ID[id] : undefined
}

/**
 * Доступ к анимированным стилям оформления: активный tier Plus/Pro
 * ИЛИ Telegram Premium (владелец с Premium не должен видеть замки на себе).
 */
export function hasPlusAccess(tier: string | undefined | null, isPremium?: boolean): boolean {
  return tier === 'plus' || tier === 'pro' || isPremium === true
}

/** Рамка открыта пользователю? 'none'/статические — всегда; анимированные — Plus/Pro (или Premium) */
export function isFrameUnlocked(
  frameId: string,
  tier: string | undefined | null,
  isPremium?: boolean,
): boolean {
  const frame = FRAME_BY_ID[frameId]
  if (!frame) return false
  if (!frame.animated) return true
  return hasPlusAccess(tier, isPremium)
}

/** Анимированный ли узор обложки */
export function isBgAnimated(bgId: string): boolean {
  return BG_BY_ID[bgId]?.animated ?? false
}

/** Все три id существуют в каталогах (валидация сохранённого/присланного стиля) */
export function isValidStyleIds(palette: string, bg: string, frame: string): boolean {
  return Boolean(PALETTE_BY_ID[palette] && BG_BY_ID[bg] && FRAME_BY_ID[frame])
}
