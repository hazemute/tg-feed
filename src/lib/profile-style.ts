/**
 * Единый каталог оформления профиля Tg Swipe (v5.28).
 *
 * Три каталога: палитра обложки (background за аватаром), узор поверх
 * обложки, рамка аватара. v5.28: ВСЁ СТАТИЧНОЕ — анимации оформления
 * убраны (решение владельца), замки Plus на узорах/рамках сняты.
 * Плюс кастомные стили: «своя палитра» (2 цвета градиента обложки) и
 * «своя рамка» (цвет кольца) — кодируются прямо в id (custom:…), валидация
 * строгая hex — XSS через style невозможен.
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
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Модуль общий (клиент + сервер): без импортов db/env — безопасен в бандле.
 */

export type ProfileStyleKind = 'palette' | 'bg' | 'frame'

/** Палитра обложки профиля: css — фон шапки, accent — цвет имени/кнопок на ней */
export type ProfilePalette = { id: string; name: string; css: string; accent: string; dark?: boolean }

/** Узор поверх обложки: css — фон отдельного div-слоя (background-шорткат) */
export type ProfileBg = { id: string; name: string; css: string }

/** Рамка аватара: css — фон обёртки с padding:3px; glow — свечение (boxShadow) */
export type ProfileFrame = { id: string; name: string; css: string; glow?: string }

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
// Только статические: точки / полосы / сетка / волны / шахматка /
// сияние / пузыри / лучи / блик. Движения больше нет (v5.28).

export const PROFILE_BGS: ProfileBg[] = [
  { id: 'none', name: 'Без узора', css: 'none' },
  {
    id: 'dots',
    name: 'Точки',
    css: 'radial-gradient(rgba(255,255,255,0.16) 1.5px, transparent 1.6px) 0 0 / 22px 22px repeat',
  },
  {
    id: 'stripes',
    name: 'Полосы',
    css: 'repeating-linear-gradient(45deg, rgba(255,255,255,0.07) 0 10px, transparent 10px 24px)',
  },
  {
    id: 'grid',
    name: 'Сетка',
    css: 'linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px) 0 0 / 28px 28px repeat, linear-gradient(90deg, rgba(255,255,255,0.08) 1px, transparent 1px) 0 0 / 28px 28px repeat',
  },
  {
    id: 'waves',
    name: 'Волны',
    css: 'radial-gradient(circle at 50% 0%, transparent 12px, rgba(255,255,255,0.10) 13px 15px, transparent 16px) 0 0 / 36px 36px repeat',
  },
  {
    id: 'checker',
    name: 'Шахматка',
    css: 'conic-gradient(rgba(255,255,255,0.06) 0 25%, transparent 0 50%, rgba(255,255,255,0.06) 0 75%, transparent 0) 0 0 / 28px 28px repeat',
  },
  {
    id: 'aurora',
    name: 'Сияние',
    css: 'linear-gradient(110deg, rgba(52,211,153,0.32) 0%, rgba(168,85,247,0.30) 30%, rgba(244,114,182,0.30) 55%, rgba(251,191,36,0.26) 80%, rgba(52,211,153,0.32) 100%)',
  },
  {
    id: 'bubbles',
    name: 'Пузырьки',
    css: 'radial-gradient(circle at 20% 30%, rgba(255,255,255,0.20) 0 22px, transparent 23px) 0 0 / 100% 100% no-repeat, radial-gradient(circle at 70% 60%, rgba(255,255,255,0.16) 0 34px, transparent 35px) 0 0 / 100% 100% no-repeat, radial-gradient(circle at 45% 85%, rgba(255,255,255,0.14) 0 18px, transparent 19px) 0 0 / 100% 100% no-repeat',
  },
  {
    id: 'rays',
    name: 'Лучи',
    css: 'repeating-conic-gradient(from 0deg at 50% 50%, rgba(255,255,255,0.09) 0deg 7deg, transparent 7deg 18deg)',
  },
  {
    id: 'shimmer',
    name: 'Блик',
    css: 'linear-gradient(105deg, transparent 30%, rgba(255,255,255,0.14) 46%, transparent 62%)',
  },
]

// ── Рамки аватара (все статичные, замок снят в v5.28) ─────────────────────
// css — фон обёртки (padding:3px, rounded-full) вокруг аватара; для свечения
// поле glow (boxShadow).

export const PROFILE_FRAMES: ProfileFrame[] = [
  { id: 'none', name: 'Без рамки', css: 'transparent' },
  { id: 'ring', name: 'Кольцо', css: '#ffffff' },
  {
    id: 'gold',
    name: 'Золото',
    css: 'linear-gradient(135deg, #fde68a, #d97706 45%, #f59e0b 70%, #92400e)',
  },
  {
    id: 'rose',
    name: 'Роза',
    css: 'linear-gradient(135deg, #fda4af, #e11d48 50%, #fbbf24)',
  },
  {
    id: 'silver',
    name: 'Серебро',
    css: 'linear-gradient(135deg, #f4f4f5, #a1a1aa 50%, #e4e4e7 75%, #71717a)',
  },
  {
    id: 'candy',
    name: 'Карамель',
    css: 'linear-gradient(135deg, #f9a8d4, #c084fc 50%, #f472b6)',
  },
  {
    id: 'forest',
    name: 'Хвоя',
    css: 'linear-gradient(135deg, #86efac, #16a34a 55%, #14532d)',
  },
  {
    id: 'ember',
    name: 'Тлеющий угль',
    css: 'linear-gradient(135deg, #fdba74, #c2410c 60%, #7c2d12)',
    glow: '0 0 14px rgba(249,115,22,0.55)',
  },
  {
    id: 'aurora',
    name: 'Сияние',
    css: 'linear-gradient(135deg, #34d399, #a855f7)',
    glow: '0 0 14px rgba(168,85,247,0.35)',
  },
  {
    id: 'fire',
    name: 'Пламя',
    css: 'linear-gradient(135deg, #fbbf24, #dc2626)',
    glow: '0 0 14px rgba(220,38,38,0.40)',
  },
  {
    id: 'pulse',
    name: 'Пульс',
    css: 'linear-gradient(135deg, #fb7185, #a21caf)',
    glow: '0 0 12px rgba(236,72,153,0.45)',
  },
  {
    id: 'rainbow',
    name: 'Радуга',
    css: 'linear-gradient(135deg, #ef4444, #eab308, #22c55e, #a855f7)',
  },
  {
    id: 'galaxy',
    name: 'Галактика',
    css: 'linear-gradient(135deg, #7e22ce, #db2777 55%, #2e1065)',
    glow: '0 0 16px rgba(168,85,247,0.40)',
  },
]

/** Стиль по умолчанию (совпадает с default колонок User.profile* в схеме) */
export const DEFAULT_PROFILE_STYLE = { palette: 'crimson', bg: 'none', frame: 'none' } as const

// ── Кастомные стили (v5.28) ───────────────────────────────────────────────
// Кодируем цвета ПРЯМО в id (те же строковые колонки БД, без миграции):
//   палитра: custom:<hex6>:<hex6>  — градиент из двух цветов обложки
//   рамка:   custom:<hex6>         — сплошное кольцо выбранного цвета
// Валидация строго ^#[0-9a-fA-F]{6}$ — в style попадает только проверенный
// hex, инъекция CSS невозможна.

const HEX_RE = /^#[0-9a-fA-F]{6}$/
const CUSTOM_PALETTE_RE = /^custom:#[0-9a-fA-F]{6}:#[0-9a-fA-F]{6}$/
const CUSTOM_FRAME_RE = /^custom:#[0-9a-fA-F]{6}$/

/** Яркость hex-цвета 0..1 (Rec. 709) — для выбора контрастного акцента */
export function hexLuminance(hex: string): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex)
  if (!m) return 0.5
  const n = parseInt(m[1], 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Своя палитра собрана и валидна? */
export function isCustomPaletteId(id: string): boolean {
  return CUSTOM_PALETTE_RE.test(id)
}

/** Своя рамка: id валиден? */
export function isCustomFrameId(id: string): boolean {
  return CUSTOM_FRAME_RE.test(id)
}

/** Собрать ProfilePalette из id custom:c1:c2 (вызывать после isCustomPaletteId) */
export function buildCustomPalette(id: string): ProfilePalette {
  const [, c1 = '#7f1d1d', c2 = '#57534e'] = id.split(':')
  const dark = hexLuminance(c1) * 0.45 + hexLuminance(c2) * 0.55 < 0.45
  return {
    id,
    name: 'Своя палитра',
    css: `linear-gradient(165deg, ${c1} 0%, ${c2} 100%)`,
    accent: dark ? '#f5f0ea' : '#26201a',
    dark,
  }
}

/** Собрать ProfileFrame из id custom:hex (вызывать после isCustomFrameId) */
export function buildCustomFrame(id: string): ProfileFrame {
  const hex = id.slice(7)
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return {
    id,
    name: 'Своя рамка',
    css: hex,
    glow: `0 0 12px rgba(${r},${g},${b},0.45)`,
  }
}

const PALETTE_BY_ID: Record<string, ProfilePalette> = Object.fromEntries(
  PROFILE_PALETTES.map((p) => [p.id, p]),
)
const BG_BY_ID: Record<string, ProfileBg> = Object.fromEntries(PROFILE_BGS.map((b) => [b.id, b]))
const FRAME_BY_ID: Record<string, ProfileFrame> = Object.fromEntries(
  PROFILE_FRAMES.map((f) => [f.id, f]),
)

/** Палитра по id (включая custom:…); неизвестный id → undefined */
export function getPalette(id: string | null | undefined): ProfilePalette | undefined {
  if (!id) return undefined
  if (isCustomPaletteId(id)) return buildCustomPalette(id)
  return PALETTE_BY_ID[id]
}

/** Узор по id; неизвестный id → undefined (фолбэк вызывающего — DEFAULT_PROFILE_STYLE.bg) */
export function getBg(id: string | null | undefined): ProfileBg | undefined {
  return id ? BG_BY_ID[id] : undefined
}

/** Рамка по id (включая custom:…); неизвестный id → undefined */
export function getFrame(id: string | null | undefined): ProfileFrame | undefined {
  if (!id) return undefined
  if (isCustomFrameId(id)) return buildCustomFrame(id)
  return FRAME_BY_ID[id]
}

/** Рамка открыта пользователю? С v5.28 все рамки статичные и доступные */
export function isFrameUnlocked(): boolean {
  return true
}

/** Все три id существуют в каталогах/валидный custom (валидация сохранённого стиля) */
export function isValidStyleIds(palette: string, bg: string, frame: string): boolean {
  return Boolean(getPalette(palette) && BG_BY_ID[bg] && getFrame(frame))
}

/** Экспорт для проверки формата (например, hex-инпуты на клиенте) */
export function isValidHex6(hex: string): boolean {
  return HEX_RE.test(hex)
}

/** Цвета из id custom:c1:c2 → {c1,c2}; не кастом/невалидно → null */
export function getCustomPaletteColors(
  id: string | null | undefined,
): { c1: string; c2: string } | null {
  if (!id || !isCustomPaletteId(id)) return null
  const [, c1 = '', c2 = ''] = id.split(':')
  return { c1, c2 }
}

/** Цвет из id custom:hex; не кастом/невалидно → null */
export function getCustomFrameColor(id: string | null | undefined): string | null {
  if (!id || !isCustomFrameId(id)) return null
  return id.slice(7)
}
