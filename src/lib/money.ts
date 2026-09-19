import { formatCount } from '@/lib/format'

/**
 * Валюта платформы — «Свайпы»: внутренняя единица рекламного кабинета.
 * 1 свайп = 1 рубль = 100 копеек. Все денежные поля БД по-прежнему хранятся
 * в копейках (Int) — конвертация только на границе отображения.
 */

export const KOPECKS_PER_SWIPE = 100

/** Копейки → целые свайпы (округление вверх до копейки не нужен: поля целые) */
export function kopToSwipes(kop: number): number {
  return kop / KOPECKS_PER_SWIPE
}

/** Свайпы → копейки (для отправки на сервер) */
export function swipesToKop(swipes: number): number {
  return Math.round(swipes * KOPECKS_PER_SWIPE)
}

/**
 * Красивое число свайпов: 12 500 (дробные свайпы не показываем —
 * вся арифметика кабинета идёт в целых свайпах).
 */
export function formatSwipes(kop: number): string {
  return formatCount(Math.round(kopToSwipes(kop)))
}

/** Плюрализация «свайп/свайпа/свайпов» */
export function pluralSwipes(n: number): string {
  const abs = Math.abs(n) % 100
  const last = abs % 10
  if (abs > 10 && abs < 20) return 'свайпов'
  if (last > 1 && last < 5) return 'свайпа'
  if (last === 1) return 'свайп'
  return 'свайпов'
}
