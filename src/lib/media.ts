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

/** Заворачивает доверенный Telegram-CDN URL в наш прокси; остальное — как есть.
 *  Уже проксированные /api/media-ссылки не трогаем (идемпотентность). */
export function proxiedMediaUrl(url: string | null | undefined): string | null | undefined {
  if (!url) return url
  if (url.startsWith('/api/media?u=') || url.includes('/api/media?u=')) return url // уже проксирован
  if (!url.startsWith('https://')) return url
  if (!isTrustedMediaUrl(url)) return url
  return `/api/media?u=${encodeURIComponent(url)}`
}

/**
 * v5.60 — БАЙТЫ ×3-5 МЕНЬШЕ: большие JPEG из /api/media сжимаем НАШИМ прокси
 * (sharp на сервере): WebP под ширину экрана. На медленном/душеном канале
 * (типичная жалоба «медиа не грузится») 170КБ JPEG превращаются в ~25-45КБ
 * WebP — часто это разница между «загрузилось» и «вечный shimmer».
 *
 * Почему НЕ /_next/image: Vercel-оптимизатор на этом проекте отвечает
 * INVALID_IMAGE_OPTIMIZE_REQUEST на ЛЮБОЙ запрос (даже статику) — не зависим
 * от него. sharp уже живёт в бандле (аватарки /api/avatar сжимает им в проде).
 * Ресайз только вниз (withoutEnlargement), результат — в тех же кэшах L0/edge.
 */
export function optimizedImgSrc(url: string, width = 828, quality = 70): string {
  if (!url.startsWith('/api/media')) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}w=${width}&q=${quality}`
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
  // Идемпотентность: на вход мог прийти уже готовый клиентский URL (DTO → DTO,
  // клиентский ретрай-хелпер и т.п.) — возвращаем как есть, не ломаем
  if (avatarUrl && (avatarUrl.startsWith('/api/avatar/') || avatarUrl.includes('/api/media?u='))) {
    return avatarUrl
  }
  if (photoFileId) return `/api/avatar/c_${channelId}`
  const raw = avatarUrl && avatarUrl.includes('.supabase.co/') ? null : avatarUrl
  return proxiedMediaUrl(raw) ?? null
}

/**
 * Аватарка ПОЛЬЗОВАТЕЛЯ → прочный URL для клиента (v5.69, единая точка для DTO).
 *
 * Баг «аватарки не отображаются»: User.photoUrl уезжал на фронт СЫРОЙ ссылкой
 * cdn*.telesco.pe (photo_url из initData живёт ~час, дальше 404) — картинка
 * пустая. Теперь:
 *  - `tgfile:<file_id>` (Bot API, вечный) → /api/avatar/<uid> (байты + кэши);
 *  - https telesco.pe/telegram.org/наш Supabase → /api/media?u=… (прокси Vercel,
 *    CDN-кэш 30 дней);
 *  - остальное (мёртвые легаси-хосты) → null → компонент рисует инициал-фолбэк.
 *
 * Изоморфная: вызывается и в DTO на сервере, и в lib/tg.ts на клиенте.
 */
export function userAvatarProxyUrl(
  userId: string,
  photoUrl: string | null | undefined,
): string | null {
  if (!photoUrl) return null
  // Идемпотентность (КРИТИЧНО, v5.71): DTO /api/auth, /api/user/[uid] и др.
  // отдают УЖЕ проксированный URL (страница/стор клиента хранит именно его),
  // а клиентские компоненты (Sidebar, ProfileTab, UserProfileSheet,
  // CommentsSheet, ProfileCustomizer) прогоняют его через хелпер ВТОРОЙ раз.
  // Без этой ветки повторный вызов возвращал null → аватарка «слетала» на
  // инициалы во всех этих местах (баг «не отображаются в Мой канал и много где»).
  if (photoUrl.startsWith('/api/avatar/') || photoUrl.includes('/api/media?u=')) return photoUrl
  if (photoUrl.startsWith('tgfile:')) return `/api/avatar/${userId}`
  if (photoUrl.startsWith('https://')) {
    const proxied = proxiedMediaUrl(photoUrl)
    // Доверенный хост → прокси; чужой/битый хост → null (инициалы вместо битой картинки)
    return proxied && proxied !== photoUrl ? proxied : null
  }
  return null
}
