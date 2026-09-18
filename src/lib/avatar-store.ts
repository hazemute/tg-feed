import { createHash } from 'node:crypto'
import { db } from '@/lib/db'

/**
 * Постоянные аватарки каналов в Supabase Storage.
 *
 * ПРОБЛЕМА: раньше аватарку получал только Bot API (getChat → file_id →
 * прокси /api/avatar). Он душится флуд-банами (ramp 2 канала/тик), поэтому
 * у сотен каналов аватарки нет неделями — вместо фото серые инициалы.
 *
 * РЕШЕНИЕ: каждая страница t.me/s/<username>, которую парсер И ТАК качает
 * каждый тик, содержит og:image — прямую ссылку на аватарку в CDN Telegram.
 * Скачиваем байты один раз и складываем в публичный бакет Supabase Storage:
 * ссылка вечная, раздаётся с CDN-кэшем, Bot API не участвует вовсе.
 *
 * Контроль изменений по sha1 байтов: одна и та же картинка не перезаливается
 * (круг парсера ~1-2 часа — иначе это были бы сотни пустых аплоадов в сутки).
 */

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '')
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
const BUCKET = 'avatars'

/*
 * Заголовки Storage API. Новый формат ключей Supabase (sb_secret_…) — НЕ JWT,
 * поэтому Service Role передаётся и в authorization, и в apikey (гейт требует
 * именно apikey — без него 403 «Invalid Compact JWS»).
 */
function storageHeaders(contentType?: string): Record<string, string> {
  return {
    apikey: SERVICE_KEY,
    authorization: `Bearer ${SERVICE_KEY}`,
    ...(contentType ? { 'content-type': contentType } : {}),
  }
}

/** Публичный URL аватарки канала в Storage (null — Storage не сконфигурирован) */
export function storageAvatarUrl(channelId: string): string | null {
  if (!SUPABASE_URL) return null
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/c_${channelId}.jpg`
}

let bucketReady = false

/** Создаём публичный бакет один раз за процесс (идемпотентно, ошибки тихо) */
async function ensureBucket(): Promise<boolean> {
  if (bucketReady) return true
  if (!SUPABASE_URL || !SERVICE_KEY) return false
  try {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
      method: 'POST',
      headers: storageHeaders('application/json'),
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
      signal: AbortSignal.timeout(8_000),
    })
    // 200 — создан; 400 «already exists» — тоже хорошо
    if (res.ok || res.status === 400) bucketReady = true
  } catch {
    // повторим на следующем вызове
  }
  return bucketReady
}

/** Извлекает og:image (аватар канала) из HTML страницы t.me/s/<username> */
export function ogAvatarOf(html: string): string | null {
  const m =
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/) ??
    html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/)
  if (!m) return null
  let url = m[1]
  if (url.startsWith('//')) url = `https:${url}`
  return url.startsWith('https://') ? url : null
}

export type AvatarSyncResult =
  | { status: 'ok'; changed: boolean }
  | { status: 'skipped' }
  | { status: 'error'; reason: string }

/**
 * Синхронизация аватарки канала из HTML страницы t.me/s: og:image → байты →
 * Storage → Channel.avatarUrl. Вызывается парсером на каждом тике (канал и так
 * скачан); повторные круги дешёвые — при неизменной картинке только sha1.
 */
export async function syncChannelAvatar(channelId: string, html: string): Promise<AvatarSyncResult> {
  const imageUrl = ogAvatarOf(html)
  if (!imageUrl) return { status: 'skipped' }

  try {
    const res = await fetch(imageUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return { status: 'error', reason: `image HTTP ${res.status}` }
    const buf = Buffer.from(await res.arrayBuffer())
    // Аватарки Telegram ~5-60КБ; большой ответ — не аватарка, не рискуем
    if (buf.length < 512 || buf.length > 400_000) return { status: 'error', reason: `size ${buf.length}` }
    if (!/^image\//.test(res.headers.get('content-type') ?? 'image/jpeg'))
      return { status: 'error', reason: 'not an image' }

    const hash = createHash('sha1').update(buf).digest('hex')

    const channel = await db.channel.findUnique({
      where: { id: channelId },
      select: { avatarHash: true },
    })
    if (!channel) return { status: 'skipped' }
    if (channel.avatarHash === hash) {
      // картинка не менялась — только освежаем штамп времени (дёшево)
      await db.channel
        .update({ where: { id: channelId }, data: { avatarFetchedAt: new Date() } })
        .catch(() => {})
      return { status: 'ok', changed: false }
    }

    if (!(await ensureBucket())) return { status: 'error', reason: 'storage unavailable' }

    const path = `c_${channelId}.jpg`
    const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
      method: 'POST',
      headers: {
        ...storageHeaders(res.headers.get('content-type') ?? 'image/jpeg'),
        'cache-control': 'public, max-age=604800, immutable',
        'x-upsert': 'true',
      },
      body: new Uint8Array(buf),
      signal: AbortSignal.timeout(15_000),
    })
    if (!up.ok) return { status: 'error', reason: `upload HTTP ${up.status}` }

    const publicUrl = storageAvatarUrl(channelId)
    if (!publicUrl) return { status: 'error', reason: 'no public url' }

    await db.channel
      .update({
        where: { id: channelId },
        data: { avatarUrl: publicUrl, avatarHash: hash, avatarFetchedAt: new Date() },
      })
      .catch(() => {})
    return { status: 'ok', changed: true }
  } catch (e) {
    return { status: 'error', reason: String((e as Error)?.message ?? e) }
  }
}

/**
 * Скачивает и заливает аватарку по прямой ссылке (для бэкфилл-скрипта).
 * Обновляет БД только если канал ещё без постоянной аватарки или она изменилась.
 */
export async function syncChannelAvatarFromUrl(channelId: string, imageUrl: string): Promise<AvatarSyncResult> {
  return syncChannelAvatar(channelId, `<meta property="og:image" content="${imageUrl}">`)
}
