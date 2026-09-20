import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * GET /api/upload/[id] — выдача чатовой картинки. Публично (в <img> нельзя
 * передать Bearer; id — некугадарный cuid), immutable-кэш.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  if (!/^[a-zA-Z0-9_-]{10,40}$/.test(id)) return new Response('bad id', { status: 400 })

  // v5.48: try/catch — сбой пула БД раньше давал 500 без лога
  let row: { mime: string; data: string } | null = null
  try {
    row = await db.upload.findUnique({ where: { id }, select: { mime: true, data: true } })
  } catch (e) {
    console.error('[upload:get]', e)
    return new Response('storage error', { status: 500 })
  }
  if (!row) return new Response('not found', { status: 404 })

  const buf = Buffer.from(row.data, 'base64')
  return new Response(new Uint8Array(buf), {
    headers: {
      'Content-Type': row.mime,
      'Content-Length': String(buf.length),
      // s-maxage: Vercel CDN кэширует картинку НАВСЕГДА (id некугадарный) —
      // из Postgres (Supabase) байты уходят ОДИН раз на edge-регион, остальное
      // раздаёт CDN. Экономия исходящего трафика Supabase (v5.33).
      'Cache-Control': 'public, max-age=31536000, s-maxage=31536000, immutable',
    },
  })
}
