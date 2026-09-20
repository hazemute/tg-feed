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

/**
 * v5.60 — БАЙТЫ ×3-5 МЕНЬШЕ: большие JPEG из /api/media прогоняем через
 * оптимизатор Vercel (/_next/image): AVIF/WebP под ширину экрана, edge-кэш
 * на год. На медленном/душеном канале (типичная жалоба «медиа не грузится»)
 * 170КБ JPEG превращаются в ~40КБ AVIF — часто это разница между
 * «загрузилось» и «вечный shimmer». Источник относительный (тот же origin),
 * remotePatterns не нужен; при сбое оптимизатора LazyImage падает на прямой
 * /api/media — картинка не теряется ни при каких условиях.
 */
export function optimizedImgSrc(url: string, width = 828, quality = 70): string {
  if (!url.startsWith('/api/media')) return url
  return `/_next/image?url=${encodeURIComponent(url)}&w=${width}&q=${quality}`
}

/**
 * Аватарка канала → URL для клиента (v5.59, единая точка для всех DTO).
 *
 * ПРИОРИТЕТ ВЕЧНОГО ИСТОЧНИКА: photoFileId (Bot API) НЕ ПРОТУХЛИВАЕТ —
 * отдаётся через /api/avatar/c_<id> (байты + ресайз 256px WebP, кэши
 * L0/Redis/edge). Прямая ссылка cdn*.telesco.pe из og:image — ФОЛБЭК:
 * Telegram ротирует эти ссылки (замер прода: трендовые медиа 404 через
 * дни), поэтому аватарки по avatarUrl регулярно «слетали».
 *
 * ЛЕГАСИ-ФИЛЬТР: ссылки *.supabase.co мертвы (проект с бакетом аватарок
 * удалён — DNS NXDOMAIN глобально) — считаем их отсутствующими.
 */
export function channelAvatarUrl(
  avatarUrl: string | null | undefined,
  photoFileId: string | null | undefined,
  channelId: string,
): string | null {
  if (photoFileId) return `/api/avatar/c_${channelId}`
  const raw = avatarUrl && avatarUrl.includes('.supabase.co/') ? null : avatarUrl
  return proxiedMediaUrl(raw) ?? null
}
