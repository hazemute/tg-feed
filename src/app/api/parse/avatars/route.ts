import { NextResponse } from 'next/server'
import { cronAuthorized, guardIp } from '@/lib/guard'
import { refreshChannelCards } from '@/lib/parse-scheduler'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * POST|GET /api/parse/avatars?limit=60 — бэкфилл карточек каналов.
 *
 * ТОЛЬКО Bot API (getChat / getChatMemberCount) — t.me не трогается.
 * Заполняет аватарки (file_id) и реальные числа подписчиков у активных
 * каналов, где их нет или TTL (7 дней) истёк. Авторизация: Bearer $CRON_SECRET.
 * Возврат: { ok, refreshed, scanned } — сколько каналов обновлено в партии.
 */
async function handle(request: Request) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const ip = guardIp(request, { limit: 12, windowMs: 60_000, bucket: 'cron-avatars' })
  if (!ip.ok) return ip.res

  const started = Date.now()
  try {
    const { searchParams } = new URL(request.url)
    const parsed = Number(searchParams.get('limit') ?? '60')
    const limit = Number.isFinite(parsed) ? Math.min(200, Math.max(1, Math.floor(parsed))) : 60
    const result = await refreshChannelCards(limit)
    return NextResponse.json({ ok: true, ...result, ms: Date.now() - started })
  } catch (e) {
    console.error('[avatars]', e)
    return NextResponse.json({ error: 'avatars failed' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  return handle(request)
}

export async function GET(request: Request) {
  return handle(request)
}
