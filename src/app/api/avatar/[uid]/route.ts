import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { resolveTelegramFileUrl } from '@/lib/tg-bot'
import { guardIp } from '@/lib/guard'

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
 * Редирект для аватарки КАНАЛА: доверенные хосты Telegram + свой Supabase
 * Storage. БАГФИКС: Storage-ссылки (554 канала, uehhvzutlaxgbpnwmijo.supabase.co)
 * не проходили isSafePhotoUrl — постоянная аватарка отклонялась, и путь падал
 * либо в 404 (без photoFileId — серые инициалы), либо в медленную прокси-скачку
 * байтов через Bot API. Свой Storage доверен по построению: URL ставит только
 * наш парсер (avatar-store.ts), хост совпадает с NEXT_PUBLIC_SUPABASE_URL.
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

export async function GET(request: Request, ctx: { params: Promise<{ uid: string }> }) {
  const ip = guardIp(request, { limit: 240, windowMs: 60_000, bucket: 'avatar' })
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

      // Постоянная аватарка из Storage — самый быстрый путь: 302 + долгий кэш.
      // (v5.33: основной путь аватарок каналов — прокси /api/media в DTO;
      // этот redirect остаётся фолбэком для /api/avatar/c_<id>.)
      if (channel.avatarUrl && isSafeChannelAvatarUrl(channel.avatarUrl)) {
        return NextResponse.redirect(channel.avatarUrl, {
          headers: {
            'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
          },
        })
      }
      if (!channel.photoFileId) return new NextResponse('not found', { status: 404 })

      const url = await resolveTelegramFileUrl(channel.photoFileId)
      if (!url) return new NextResponse('not found', { status: 404 })
      const img = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      if (!img.ok || !img.body) return new NextResponse('not found', { status: 404 })
      const buf = await img.arrayBuffer()
      const contentType = img.headers.get('content-type') ?? 'image/jpeg'
      return new NextResponse(buf, {
        headers: {
          'Content-Type': /^image\//.test(contentType) ? contentType : 'image/jpeg',
          'Cache-Control': 'public, max-age=1800, stale-while-revalidate=86400',
        },
      })
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
        },
      })
    }

    return new NextResponse('not found', { status: 404 })
  } catch (e) {
    console.error('[avatar]', e)
    return new NextResponse('failed', { status: 500 })
  }
}
