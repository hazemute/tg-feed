import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { resolveTelegramFileUrl } from '@/lib/tg-bot'
import { guardIp } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * GET /api/avatar/[uid] — аватар пользователя.
 *
 * <img> не умеет Authorization, поэтому роут публичный (uid — не секрет,
 * выдаётся только картинка профиля; лимит по IP от сканирования).
 *
 * Источники photoUrl:
 *  - "tgfile:<file_id>" — файл из Bot API → getFile → отдаём байты
 *    (file_url временный, кэшируется в Redis 45 мин);
 *  - http(s):// — редирект на CDN-URL ТОЛЬКО доверенных хостов Telegram
 *    (photoUrl демо-пользователя приходит с клиента — редирект на
 *    произвольный URL запрещён: open-redirect/phishing);
 *  - иначе 404 → клиент рисует инициалы.
 */

/** Доверенные хосты аватарок Telegram (redirect только на них) */
const AVATAR_HOST_RE = /^(?:t\.me|(?:[a-z0-9-]+\.)?telegram\.org|(?:[a-z0-9-]+\.)?telesco\.pe)$/i

function isSafePhotoUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:') return false
    return AVATAR_HOST_RE.test(u.hostname)
  } catch {
    return false
  }
}

export async function GET(request: Request, ctx: { params: Promise<{ uid: string }> }) {
  const ip = guardIp(request, { limit: 120, windowMs: 60_000, bucket: 'avatar' })
  if (!ip.ok) return ip.res

  const { uid } = await ctx.params
  if (!uid.startsWith('tg_') && !uid.startsWith('c_'))
    return new NextResponse('not found', { status: 404 })

  try {
    /* Источник photoUrl: пользователь (tgfile:/https) или канал (tgfile: из getChat) */
    let photo: string | null = null
    if (uid.startsWith('c_')) {
      const channel = await db.channel.findUnique({
        where: { id: uid.slice('c_'.length) },
        select: { photoFileId: true },
      })
      photo = channel?.photoFileId ? `tgfile:${channel.photoFileId}` : null
    } else {
      const user = await db.user.findUnique({ where: { id: uid }, select: { photoUrl: true } })
      photo = user?.photoUrl ?? null
    }
    if (!photo) return new NextResponse('not found', { status: 404 })

    if (photo.startsWith('http')) {
      if (!isSafePhotoUrl(photo)) return new NextResponse('not found', { status: 404 })
      return NextResponse.redirect(photo, {
        headers: {
          'Cache-Control': 'public, max-age=600, s-maxage=3600, stale-while-revalidate=86400',
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
          'Cache-Control': 'public, max-age=1800, stale-while-revalidate=86400',
        },
      })
    }

    return new NextResponse('not found', { status: 404 })
  } catch (e) {
    console.error('[avatar]', e)
    return new NextResponse('failed', { status: 500 })
  }
}
