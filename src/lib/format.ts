/** Форматирование чисел и времени */

import type { Lang } from '@/lib/i18n'

export function formatCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace('.0', '') + 'M'
  if (n >= 10_000) return Math.round(n / 1000) + 'K'
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace('.0', '') + 'K'
  return String(n)
}

export function timeAgo(iso: string, lang: Lang = 'ru'): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return lang === 'en' ? 'just now' : 'только что'
  if (m < 60) return `${m} ${lang === 'en' ? 'min' : 'мин'}`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} ${lang === 'en' ? 'h' : 'ч'}`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d} ${lang === 'en' ? 'd' : 'дн'}`
  return new Date(iso).toLocaleDateString(lang === 'en' ? 'en-US' : 'ru-RU', {
    day: 'numeric',
    month: 'short',
  })
}

/** Совместимость: компактное русское «5 мин назад»-стиль */
export const timeAgoRu = (iso: string): string => timeAgo(iso, 'ru')

export function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few
  return many
}
