/**
 * L0-кэш ответа GET /api/notifications (память процесса, 10с).
 *
 * Зачем: бейдж колокольчика опрашивается при каждом bump ленты (у активного
 * пользователя — каждые ~20-45с) плюс открытие шторки. Каждая попытка — 3-5
 * SQL-запросов (user + подписки + count + инбокс + посты). Короткий кэш
 * поглощает бёрсты поллинга и повторные открытия, не меняя ощущения
 * «живости» (10с — меньше клиентского троттлинга 30с).
 *
 * Инвалидация: POST seen сбрасывает кэш пользователя (бейдж/прочтения сразу
 * честные); новые события (комментарий/поддержка/кампания) догорают ≤10с —
 * для push-уведомлений это незаметно.
 */

type NotifCacheEntry = { data: unknown; exp: number }

const cache = new Map<string, NotifCacheEntry>()
const NOTIF_TTL_MS = 10_000
const NOTIF_CACHE_MAX = 2_000

function evict(): void {
  if (cache.size < NOTIF_CACHE_MAX) return
  const now = Date.now()
  for (const [k, e] of cache) if (e.exp <= now) cache.delete(k)
  if (cache.size >= NOTIF_CACHE_MAX) {
    const first = cache.keys().next().value
    if (first !== undefined) cache.delete(first)
  }
}

/** Ответ из кэша (≤10с свежести); null — промах, строить заново */
export function getCachedNotifications<T>(userId: string): T | null {
  const e = cache.get(userId)
  if (e && e.exp > Date.now()) return e.data as T
  if (e) cache.delete(userId)
  return null
}

/** Сохранить ответ в кэше */
export function putCachedNotifications(userId: string, data: unknown): void {
  evict()
  cache.set(userId, { data, exp: Date.now() + NOTIF_TTL_MS })
}

/** Сброс кэша пользователя (seen / новые события) */
export function clearNotificationsCache(userId: string): void {
  cache.delete(userId)
}
