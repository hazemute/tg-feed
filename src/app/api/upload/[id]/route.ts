import { db } from '@/lib/db'
import { guardIp } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * GET /api/upload/<id> (v5.65) — раздача загруженных картинок.
 *
 * Публичный GET (<img> и Telegram-бот не умеют Authorization): лимит по IP,
 * immutable-кэш — содержимое загрузки никогда не меняется, id одноразово
 * уникален. Ответ кэшируется CDN Vercel (s-maxage 30 дней).
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ip = guardIp(request, { limit: 240, windowMs: 60_000, bucket: 'upload-get' })
  if (!ip.ok) return ip.res

  const { id } = await params
  if (!/^[a-zA-Z0-9_-]{8,32}$/.test(id)) {
    return new Response('Not found', { status: 404 })
  }

  try {
    const up = await db.upload.findUnique({ where: { id }, select: { mime: true, data: true } })
    if (!up) return new Response('Not found', { status: 404 })

    const buf = Buffer.from(up.data, 'base64')
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        'Content-Type': up.mime,
        'Content-Length': String(buf.length),
        'Cache-Control': 'public, max-age=31536000, s-maxage=2592000, immutable',
      },
    })
  } catch (e) {
    console.error('[upload:get]', e)
    return new Response('Error', { status: 500 })
  }
}
