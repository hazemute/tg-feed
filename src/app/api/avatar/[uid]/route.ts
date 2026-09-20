import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { resolveTelegramFileUrl } from '@/lib/tg-bot'
import { guardIp } from '@/lib/guard'
import { cacheGet, cacheSet } from '@/lib/redis'

/*
 * sharp — лениво (dynamic import): если бандлер не включит пакет,
 * аватарки всё равно отдаются исходными байтами, а не 500-й.
 */
async function resizeAvatarWebp(raw: Buffer): Promise<Buffer | null> {
  try {
    const mod = (await import('sharp').catch(() => null)) as
      | { default: (b: Buffer) => any }
      | null
    if (!mod) return null
    return (await mod.default(raw).resize(256, 256, { fit: 'cover' }).webp({ quality: 82 }).toBuffer()) as Buffer
  } catch {
    return null
  }
}

export const dynamic = 'force-dynamic'

/**
 * GET /api/avatar/[uid] — аватар пользователя или канала.
 *
 * <img> не умеет Authorization, поэтому роут публичный (uid — не секрет,
 * выдаётся только картинка профиля; лимит по IP от сканирования).
 *
 * Источники photoUrl:
 *  - канал c_<id>: Channel.avatarUrl (постоянная ссылка Supabase Storage,
 *    заливается парсером) → 302 редирект с долгим кэшем; иначе tgfile:<file_id>
 *    (Bot API getFile → отдаём байты, file_url кэшируется в Redis 45 мин);
 *  - пользователь tg_<id>: "tgfile:<file_id>" → getFile → байты; http(s):// —
 *    редирект ТОЛЬКО на доверенные хосты Telegram (open-redirect защита);
 *  - иначе 404 → клиент рисует инициалы.
 *
 * СКОРОСТЬ: channelId → (avatarUrl, photoFileId) кэшируется в памяти процесса
 * (5 мин / негативный 60с) — каждый запрос аватарки больше не стоит RTT до
 * дальнего Supabase; повторные круги ленты отдают аватарки мгновенно.
 */

/** Доверенные хосты аватарок Telegram (redirect только на них) */
const AVATAR_HOST_RE = /^(?:t\.me|(?:[a-z0-9-]+\.)?telegram\.org|(?:[a-z0-9-]+\.)?telesco\.pe)$/i

/** Хост НАШЕГО Supabase Storage — аватарки каналов заливает туда только наш парсер */
const STORAGE_HOST = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').hostname || null
  } catch {
    return null
  }
})()

function isSafePhotoUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:') return false
    return AVATAR_HOST_RE.test(u.hostname)
  } catch {
    return false
  }
}

/**
 * Редирект для аватарки КАНАЛА: доверенные хосты Telegram (+ исторически —
 * свой Supabase Storage; v5.56: мёртвые *.supabase.co отсекаются ДО этого
 * вызова — проект с бакетом удалён, см. комментарий в GET).
 */
function isSafeChannelAvatarUrl(raw: string): boolean {
  if (isSafePhotoUrl(raw)) return true
  if (!STORAGE_HOST) return false
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' && u.hostname === STORAGE_HOST
  } catch {
    return false
  }
}

// --- L0-кэш каналов: id → { avatarUrl, photoFileId } (5 мин, негатив 60с) ---
type ChannelAvatarEntry = { avatarUrl: string | null; photoFileId: string | null; exp: number }
const chanCache = new Map<string, ChannelAvatarEntry>()
const CHAN_TTL_MS = 5 * 60_000
const CHAN_NEG_TTL_MS = 60_000
const CHAN_MAX = 2_000

function chanCacheGet(id: string): ChannelAvatarEntry | null {
  const hit = chanCache.get(id)
  if (hit && hit.exp > Date.now()) return hit
  if (hit) chanCache.delete(id)
  return null
}

function chanCacheSet(id: string, e: Omit<ChannelAvatarEntry, 'exp'>, ttl: number) {
  if (chanCache.size >= CHAN_MAX) {
    const now = Date.now()
    for (const [k, v] of chanCache) if (v.exp <= now) chanCache.delete(k)
    if (chanCache.size >= CHAN_MAX) {
      const first = chanCache.keys().next().value
      if (first !== undefined) chanCache.delete(first)
    }
  }
  chanCache.set(id, { ...e, exp: Date.now() + ttl })
}

async function channelPhotoOf(channelId: string): Promise<ChannelAvatarEntry | null> {
  const hit = chanCacheGet(channelId)
  if (hit) return hit
  try {
    const channel = await db.channel.findUnique({
      where: { id: channelId },
      select: { avatarUrl: true, photoFileId: true },
    })
    if (!channel) return null
    const entry = {
      avatarUrl: channel.avatarUrl,
      photoFileId: channel.photoFileId,
      exp: Date.now() + (channel.avatarUrl || channel.photoFileId ? CHAN_TTL_MS : CHAN_NEG_TTL_MS),
    }
    if (chanCache.size >= CHAN_MAX) {
      const now = Date.now()
      for (const [k, v] of chanCache) if (v.exp <= now) chanCache.delete(k)
      if (chanCache.size >= CHAN_MAX) {
        const first = chanCache.keys().next().value
        if (first !== undefined) chanCache.delete(first)
      }
    }
    chanCache.set(channelId, entry)
    return entry
  } catch {
    return null // пул перегружен — отдаём 404, клиент покажет инициалы
  }
}

// --- L0-кэш БАЙТОВ аватарок: fileId → { buf, type } (30 мин, кап 300 ≈ 4.5МБ) ---
type AvatarBytesEntry = { buf: Buffer; type: string }
type AvatarBytesCached = AvatarBytesEntry & { exp: number }
const bytesCache = new Map<string, AvatarBytesCached>()
const BYTES_TTL_MS = 30 * 60_000
const BYTES_MAX = 300

function avatarBytesMemGet(key: string): AvatarBytesEntry | null {
  const hit = bytesCache.get(key)
  if (hit && hit.exp > Date.now()) return hit
  if (hit) bytesCache.delete(key)
  return null
}

function avatarBytesMemSet(key: string, entry: AvatarBytesEntry): void {
  if (bytesCache.size >= BYTES_MAX) {
    const now = Date.now()
    for (const [k, v] of bytesCache) if (v.exp <= now) bytesCache.delete(k)
    if (bytesCache.size >= BYTES_MAX) {
      const first = bytesCache.keys().next().value
      if (first !== undefined) bytesCache.delete(first)
    }
  }
  bytesCache.set(key, { ...entry, exp: Date.now() + BYTES_TTL_MS })
}

/** Единый ответ байтами с долгим кэшем (браузер сутки + edge Vercel сутки) */
function avatarBytesResponse(entry: AvatarBytesEntry): NextResponse {
  return new NextResponse(new Uint8Array(entry.buf), {
    headers: {
      'Content-Type': entry.type,
      'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
      // v5.58: edge-кэш динамического роута — второй запрос любого юзера — HIT
      'Vercel-CDN-Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800',
    },
  })
}

export async function GET(request: Request, ctx: { params: Promise<{ uid: string }> }) {
  // v5.58: 240→600/мин — каталог каналов (100 аватарок) + лента за общим NAT
  const ip = guardIp(request, { limit: 600, windowMs: 60_000, bucket: 'avatar' })
  if (!ip.ok) return ip.res

  const { uid } = await ctx.params
  if (!uid.startsWith('tg_') && !uid.startsWith('c_'))
    return new NextResponse('not found', { status: 404 })

  try {
    /* Источник photoUrl: пользователь (tgfile:/https) или канал (Storage/tgfile:) */
    if (uid.startsWith('c_')) {
      const channelId = uid.slice('c_'.length)
      const channel = await channelPhotoOf(channelId)
      if (!channel) return new NextResponse('not found', { status: 404 })

      /*
       * v5.59 — ПРИОРИТЕТ ВЕЧНОГО ИСТОЧНИКА: photoFileId (Bot API) не протухает,
       * а прямые ссылки telesco.pe из og:image Telegram ротирует (замер прода:
       * трендовые медиа умирают через дни) → байты по file_id ПЕРВЫМИ,
       * 302 на avatarUrl — только фолбэк (нет file_id / getFile не отдался).
       *
       * БАЙТЫ через три кэша (v5.58):
       *  L0 память процесса (30 мин, кап 300 × ~5КБ) →
       *  L1 Upstash Redis, base64 webp (7 дней) →
       *  L2 edge Vercel (Vercel-CDN-Cache-Control, сутки + SWR неделя).
       * Байты ресайзятся sharp'ом до 256px WebP (~5КБ вместо 160КБ jpeg),
       * при сбое sharp — исходные байты.
       */
      const bytesViaFileId = async (fileId: string): Promise<NextResponse | null> => {
        const sizeKey = `avb:${fileId}`
        const memHit = avatarBytesMemGet(sizeKey)
        if (memHit) return avatarBytesResponse(memHit)
        try {
          const b64 = await cacheGet<string>(sizeKey)
          if (b64) {
            const entry = { buf: Buffer.from(b64, 'base64'), type: 'image/webp' }
            avatarBytesMemSet(sizeKey, entry)
            return avatarBytesResponse(entry)
          }
        } catch {
          /* Redis недоступен — идём в Telegram напрямую */
        }

        const url = await resolveTelegramFileUrl(fileId)
        if (!url) return null
        const img = await fetch(url, { signal: AbortSignal.timeout(10_000) })
        if (!img.ok || !img.body) return null
        const raw: Buffer<ArrayBufferLike> = Buffer.from(await img.arrayBuffer())
        let buf = raw
        let contentType = img.headers.get('content-type') ?? 'image/jpeg'
        const resized = await resizeAvatarWebp(raw)
        if (resized && resized.length > 0 && resized.length < raw.length) {
          // отдаём webp только если он реально меньше исходника (иконки-миксы и пр.)
          buf = resized
          contentType = 'image/webp'
        }
        const entry = { buf, type: contentType }
        avatarBytesMemSet(sizeKey, entry)
        if (contentType === 'image/webp') {
          void cacheSet(sizeKey, buf.toString('base64'), 7 * 24 * 3600).catch(() => {})
        }
        return avatarBytesResponse(entry)
      }

      if (channel.photoFileId) {
        const viaBot = await bytesViaFileId(channel.photoFileId).catch(() => null)
        if (viaBot) return viaBot
        // getFile/файл не отдались — падаем в 302 на прямую ссылку ниже
      }

      // Фолбэк: прямая ссылка og:image (свежая после тика парсера).
      // ЛЕГАСИ (v5.56): ссылки *.supabase.co МЕРТВЫ (проект с бакетом удалён,
      // DNS NXDOMAIN) — раньше Storage доверялся по построению, теперь редирект
      // на него = 307 в яму. Считаем отсутствующей → 404 → инициалы.
      if (
        channel.avatarUrl &&
        !channel.avatarUrl.includes('.supabase.co/') &&
        isSafeChannelAvatarUrl(channel.avatarUrl)
      ) {
        return NextResponse.redirect(channel.avatarUrl, {
          headers: {
            'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
            // v5.58: edge-кэш редиректа (динамическим роутам s-maxage срезается)
            'Vercel-CDN-Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800',
          },
        })
      }
      return new NextResponse('not found', { status: 404 })
    }

    // --- пользователь tg_<id> ---
    const user = await db.user.findUnique({ where: { id: uid }, select: { photoUrl: true } })
    const photo = user?.photoUrl ?? null
    if (!photo) return new NextResponse('not found', { status: 404 })

    if (photo.startsWith('http')) {
      if (!isSafePhotoUrl(photo)) return new NextResponse('not found', { status: 404 })
      return NextResponse.redirect(photo, {
        headers: {
          // v5.33: фото-URL из initData живёт ~час, file_id — вечный; кэшируем
          // смелее (сутки в браузере + сутки на edge Vercel) — аватар профиля
          // появляется мгновенно и не дёргает origin на каждой загрузке
          'Cache-Control': 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800',
        },
      })
    }

    if (photo.startsWith('tgfile:')) {
      const fileId = photo.slice('tgfile:'.length)
      const url = await resolveTelegramFileUrl(fileId)
      if (!url) return new NextResponse('not found', { status: 404 })
      const img = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      if (!img.ok || !img.body) return new NextResponse('not found', { status: 404 })
      const buf = await img.arrayBuffer()
      // Telegram иногда отдаёт application/octet-stream — нормализуем по расширению
      const rawType = img.headers.get('content-type') ?? ''
      const ext = url.split('.').pop()?.toLowerCase() ?? ''
      const contentType = /^image\//.test(rawType)
        ? rawType
        : ext === 'png'
          ? 'image/png'
          : ext === 'webp'
            ? 'image/webp'
            : 'image/jpeg'
      return new NextResponse(buf, {
        headers: {
          'Content-Type': contentType,
          // v5.33: аватар пользователя меняется редко — сутки браузер + сутки
          // Vercel CDN (s-maxage): повторные открытия приложения отдают мгновенно
          'Cache-Control': 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800',
          'Vercel-CDN-Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800',
        },
      })
    }

    return new NextResponse('not found', { status: 404 })
  } catch (e) {
    console.error('[avatar]', e)
    return new NextResponse('failed', { status: 500 })
  }
}
