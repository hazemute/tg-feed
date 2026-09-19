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

/**
 * Хост НАШЕГО Supabase Storage (публичный бакет аватарок).
 * ЭКОНОМИКА ИСХОДЯЩЕГО ТРАФИКА SUPABASE (v5.33): Storage-ссылки попадают в DTO
 * напрямую, и каждый браузер качал аватарки ПРЯМО из Supabase (public-объекты
 * живут в их кэше всего час) — это гигабайты исходящего трафика. Теперь такие
 * URL заворачиваются в /api/media: Vercel CDN кэширует объект на 30 дней
 * (s-maxage), Supabase отдаёт файл один раз на edge-регион.
 */
const SUPABASE_STORAGE_HOST = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').hostname || null
  } catch {
    return null
  }
})()

export function isTrustedMediaUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:') return false
    if (MEDIA_HOST_RE.test(u.hostname)) return true
    // Публичные объекты нашего Storage (только чтение, только /object/public/)
    return (
      Boolean(SUPABASE_STORAGE_HOST) &&
      u.hostname === SUPABASE_STORAGE_HOST &&
      u.pathname.startsWith('/storage/v1/object/public/')
    )
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
