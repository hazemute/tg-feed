import { NextResponse } from 'next/server'
import { emitAppEvent } from '@/lib/events'
import { cronAuthorized, guardIp } from '@/lib/guard'
import { readJson } from '@/lib/server'

export const dynamic = 'force-dynamic'

/**
 * POST /api/events/emit — публикация события в SSE-шину внешними системами
 * (cron-сервис, будущий бот-вебхук). Защита: CRON_SECRET (как /api/parse)
 * + лимит 30/мин с IP.
 *
 * body: { type: 'posts:new', total?: number, usernames?: string[] }
 */
export async function POST(request: Request) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const ip = guardIp(request, { limit: 30, windowMs: 60_000, bucket: 'emit' })
  if (!ip.ok) return ip.res

  const body = await readJson<{ type?: unknown; total?: unknown; usernames?: unknown }>(request)
  if (body?.type !== 'posts:new') {
    return NextResponse.json({ error: 'unknown event type' }, { status: 400 })
  }

  const total = typeof body?.total === 'number' ? Math.max(0, Math.min(500, Math.floor(body.total))) : 0
  const usernames = Array.isArray(body?.usernames)
    ? body.usernames.filter((u): u is string => typeof u === 'string').slice(0, 50)
    : []

  emitAppEvent('posts:new', { total, usernames })
  return NextResponse.json({ ok: true, delivered: 'bus' })
}
