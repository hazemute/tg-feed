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
 *    (file_url временный, кэшируется на сервере 45 мин);
 *  - http(s):// — редирект на CDN-URL (демо-режим без bot-токена);
 *  - иначе 404 → клиент рисует инициалы.
 */
export async function GET(request: Request, ctx: { params: Promise<{ uid: string }> }) {
  const ip = guardIp(request, { limit: 60, windowMs: 60_000, bucket: 'avatar' })
  if (!ip.ok) return ip.res

  const { uid } = await ctx.params
  if (!uid.startsWith('tg_')) return new NextResponse('not found', { status: 404 })

  try {
    const user = await db.user.findUnique({ where: { id: uid }, select: { photoUrl: true } })
    const photo = user?.photoUrl
    if (!photo) return new NextResponse('not found', { status: 404 })

    if (photo.startsWith('http')) {
      return NextResponse.redirect(photo, {
        headers: { 'Cache-Control': 'public, max-age=600, stale-while-revalidate=3600' },
      })
    }

    if (photo.startsWith('tgfile:')) {
      const fileId = photo.slice('tgfile:'.length)
      const url = await resolveTelegramFileUrl(fileId)
      if (!url) return new NextResponse('not found', { status: 404 })
      const img = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      if (!img.ok || !img.body) return new NextResponse('not found', { status: 404 })
      const buf = await img.arrayBuffer()
      return new NextResponse(buf, {
        headers: {
          'Content-Type': img.headers.get('content-type') ?? 'image/jpeg',
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
