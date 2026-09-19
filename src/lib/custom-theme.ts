/**
 * Кастомная тема (v5.28): пользователь сам выбирает ФОН и АКЦЕНТ —
 * остальная палитра (--tg-*) выводится из этих двух цветов автоматически.
 *
 * Хранение: localStorage 'tgfeed_custom_theme' = {"bg":"#rrggbb","accent":"#rrggbb"}
 * (темы — настройки устройства, как и весь выбор data-theme).
 *
 * Применение: при theme='custom' на <html> ставится ИНЛАЙН-стиль с
 * --tg-* переменными (перекрывает палитры из globals.css), data-theme
 * остаётся 'custom'. Все shadcn-токены следуют --tg-* (v5.27.1), поэтому
 * красится сразу весь интерфейс. Инлайн-стиль снимается при уходе с custom.
 *
 * Формулы derivation продублированы компактно в themeInit (layout.tsx) —
 * держи их синхронными.
 *
 * Модуль клиентский (localStorage), но чистые функции — тестопригодны.
 */

/** Набор --tg-* переменных, которые выводятся из кастомной темы */
export type CustomThemeVars = {
  '--tg-bg': string
  '--tg-surface': string
  '--tg-surface2': string
  '--tg-text': string
  '--tg-text2': string
  '--tg-hint': string
  '--tg-link': string
  '--tg-button': string
  '--tg-like': string
  '--tg-sep': string
  '--tg-green': string
  '--tg-star': string
}

export type CustomTheme = { bg: string; accent: string }

export const CUSTOM_THEME_KEY = 'tgfeed_custom_theme'
export const DEFAULT_CUSTOM_THEME: CustomTheme = { bg: '#f2f2f7', accent: '#0a84ff' }

const HEX_RE = /^#[0-9a-fA-F]{6}$/

export function isValidCustomTheme(v: unknown): v is CustomTheme {
  if (!v || typeof v !== 'object') return false
  const t = v as Partial<CustomTheme>
  return typeof t.bg === 'string' && HEX_RE.test(t.bg) && typeof t.accent === 'string' && HEX_RE.test(t.accent)
}

/** Прочитать сохранённую кастомную тему (client-only); невалидная → null */
export function loadCustomTheme(): CustomTheme | null {
  try {
    const raw = localStorage.getItem(CUSTOM_THEME_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isValidCustomTheme(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function saveCustomTheme(t: CustomTheme): void {
  try {
    localStorage.setItem(CUSTOM_THEME_KEY, JSON.stringify(t))
  } catch {}
}

/** Смешать hexA→hexB, w — доля B (0..1) */
export function blendHex(a: string, b: string, w: number): string {
  const pa = parseInt(a.slice(1), 16)
  const pb = parseInt(b.slice(1), 16)
  const mix = (sa: number, sb: number) => Math.round(sa + (sb - sa) * w)
  const r = mix((pa >> 16) & 255, (pb >> 16) & 255)
  const g = mix((pa >> 8) & 255, (pb >> 8) & 255)
  const bl = mix(pa & 255, pb & 255)
  return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`
}

/** Яркость 0..1 (Rec.709) */
export function hexLum(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
}

/**
 * Полный набор --tg-* из двух цветов. Тёмная база — по яркости фона.
 * surface — фг towards text 7%, surface2 — 14%; text2/hint — text к bg 22%/45%.
 */
export function deriveCustomVars(t: CustomTheme): CustomThemeVars {
  const dark = hexLum(t.bg) < 0.45
  const fg = dark ? '#eef2f6' : '#17181c'
  return {
    '--tg-bg': t.bg,
    '--tg-surface': blendHex(t.bg, fg, 0.07),
    '--tg-surface2': blendHex(t.bg, fg, 0.14),
    '--tg-text': fg,
    '--tg-text2': blendHex(fg, t.bg, 0.22),
    '--tg-hint': blendHex(fg, t.bg, 0.45),
    '--tg-link': t.accent,
    '--tg-button': t.accent,
    '--tg-like': t.accent,
    '--tg-sep': dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.12)',
    '--tg-green': '#34c759',
    '--tg-star': '#f5a623',
  }
}

/** Тёмная ли кастомная тема (для .dark на <html>) */
export function customThemeIsDark(t: CustomTheme): boolean {
  return hexLum(t.bg) < 0.45
}

/** Применить vars на элемент (обычно documentElement); возвращает снятый стиль-функцию */
export function applyCustomVars(t: CustomTheme, el: HTMLElement): void {
  const vars = deriveCustomVars(t)
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v)
}

export function removeCustomVars(el: HTMLElement): void {
  for (const k of Object.keys(deriveCustomVars(DEFAULT_CUSTOM_THEME))) {
    el.style.removeProperty(k)
  }
}
