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
 * Живая перекраска (v5.30): saveCustomTheme диспатчит window-событие
 * CUSTOM_THEME_EVENT — эффект темы в page.tsx слушает его и применяет vars
 * сразу, даже если тема уже 'custom' (эффект завязан на [theme], который
 * при правке палитры не менялся — из-за этого палитра «кривила» до перезагрузки).
 *
 * Все константы derivation (порог яркости, fg, веса смешивания, sep/green/star)
 * экспортируются ниже и ИНТЕРПОЛИРУЮТСЯ в themeInit-скрипт layout.tsx —
 * единый источник формул, дрейф между модулями исключён структурно.
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

/** window-событие: сохранена новая кастомная палитра (слушает page.tsx) */
export const CUSTOM_THEME_EVENT = 'tgfeed:custom-theme'

/* ── Единый источник формул derivation ───────────────────────────────────
 * Эти же константы интерполируются в themeInit (layout.tsx) до гидрации.
 * Меняются ТОЛЬКО здесь — иначе до/после гидрации получатся разные палитры. */
export const CUSTOM_LUM_THRESHOLD = 0.45 // Rec.709-яркость фона: ниже — тёмная база
export const CUSTOM_FG_DARK = '#eef2f6' // текст на тёмном фоне
export const CUSTOM_FG_LIGHT = '#17181c' // текст на светлом фоне
export const CUSTOM_BLEND_SURFACE = 0.07 // surface = bg → fg 7%
export const CUSTOM_BLEND_SURFACE2 = 0.14 // surface2 = bg → fg 14%
export const CUSTOM_BLEND_TEXT2 = 0.22 // text2 = fg → bg 22%
export const CUSTOM_BLEND_HINT = 0.45 // hint = fg → bg 45%
export const CUSTOM_SEP_DARK = 'rgba(255,255,255,0.10)'
export const CUSTOM_SEP_LIGHT = 'rgba(0,0,0,0.12)'
export const CUSTOM_GREEN = '#34c759'
export const CUSTOM_STAR = '#f5a623'
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
    // Живая перекраска: эффект темы в page.tsx перезапускается только по смене
    // theme, а правка цветов палитры тему не меняет — без события приложение
    // оставалось в старой палитре до перезагрузки («кривая палитра», v5.30).
    window.dispatchEvent(new Event(CUSTOM_THEME_EVENT))
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
  const dark = hexLum(t.bg) < CUSTOM_LUM_THRESHOLD
  const fg = dark ? CUSTOM_FG_DARK : CUSTOM_FG_LIGHT
  return {
    '--tg-bg': t.bg,
    '--tg-surface': blendHex(t.bg, fg, CUSTOM_BLEND_SURFACE),
    '--tg-surface2': blendHex(t.bg, fg, CUSTOM_BLEND_SURFACE2),
    '--tg-text': fg,
    '--tg-text2': blendHex(fg, t.bg, CUSTOM_BLEND_TEXT2),
    '--tg-hint': blendHex(fg, t.bg, CUSTOM_BLEND_HINT),
    '--tg-link': t.accent,
    '--tg-button': t.accent,
    '--tg-like': t.accent,
    '--tg-sep': dark ? CUSTOM_SEP_DARK : CUSTOM_SEP_LIGHT,
    '--tg-green': CUSTOM_GREEN,
    '--tg-star': CUSTOM_STAR,
  }
}

/** Тёмная ли кастомная тема (для .dark на <html>) */
export function customThemeIsDark(t: CustomTheme): boolean {
  return hexLum(t.bg) < CUSTOM_LUM_THRESHOLD
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
