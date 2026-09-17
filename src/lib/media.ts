/**
 * Проксирование медиа Telegram (cdn*.telesco.pe и пр.).
 *
 * Прямые ссылки на CDN Telegram (telesco.pe) из ряда регионов (в т.ч. РФ)
 * не открываются — блокировка на уровне провайдеров. Миниапп ходит через
 * наш домен, поэтому все медиа-URL заворачиваются в /api/media?u=<url>:
 * сервер (Vercel) забирает файл и отдаёт клиенту с долгим CDN-кэшем.
 *
 * Функция изоморфная — используется и в DTO на сервере, и в компонентах
 * на клиенте (эмодзи-картинки внутри текста поста).
 */

/** Доверенные хосты медиа Telegram (только https) */
export const MEDIA_HOST_RE = /(?:^|\.)telesco\.pe$|(?:^|\.)telegram\.org$/i

export function isTrustedMediaUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' && MEDIA_HOST_RE.test(u.hostname)
  } catch {
    return false
  }
}

/** Заворачивает доверенный Telegram-CDN URL в наш прокси; остальное — как есть */
export function proxiedMediaUrl(url: string | null | undefined): string | null | undefined {
  if (!url) return url
  if (!url.startsWith('https://')) return url
  if (url.includes('/api/media?u=')) return url // уже проксирован
  if (!isTrustedMediaUrl(url)) return url
  return `/api/media?u=${encodeURIComponent(url)}`
}
