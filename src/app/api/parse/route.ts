import { NextResponse } from 'next/server'
import { runParser } from '@/lib/parse-engine'
import { notifyNewPosts } from '@/lib/tg-bot'
import { readJson } from '@/lib/server'
import { cronAuthorized, guardIp } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * GET /api/parse — вариант для внешних планировщиков (Vercel Cron):
 * Vercel сам шлёт GET с Authorization: Bearer $CRON_SECRET из env.
 * Логика та же, что и в POST; perChannel по умолчанию 5.
 */
export async function GET(request: Request) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const ip = guardIp(request, { limit: 20, windowMs: 60_000, bucket: 'cron' })
  if (!ip.ok) return ip.res

  try {
    const result = await runParser(5)

    let notified = { sent: 0, failed: 0, recipients: 0 }
    try {
      notified = await notifyNewPosts(result.newPosts)
    } catch (e) {
      console.error('[parse GET] notify failed', e)
    }

    return NextResponse.json({ ...result, notified })
  } catch (e) {
    console.error('[parse GET]', e)
    return NextResponse.json({ error: 'parse failed' }, { status: 500 })
  }
}

/**
 * POST /api/parse { username?: string, perChannel?: number }
 * Служебный эндпоинт для cron-сервиса (mini-services/feed-cron).
 * Вся логика парсинга — в src/lib/parse-engine.ts (runParser).
 *
 * Защита (двойная):
 *  - CRON_SECRET: Authorization: Bearer <secret> ИЛИ x-cron-secret (timing-safe);
 *  - rate limit по IP (20 прогонов/мин).
 * После парсинга новые посты рассылаются подписчикам через Bot API.
 */
export async function POST(request: Request) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const ip = guardIp(request, { limit: 20, windowMs: 60_000, bucket: 'cron' })
  if (!ip.ok) return ip.res

  try {
    const body = await readJson<{ username?: unknown; perChannel?: unknown }>(request)
    const username = typeof body?.username === 'string' ? body.username.trim().slice(0, 128) : undefined
    const perChannel = typeof body?.perChannel === 'number' ? body.perChannel : 5

    const result = await runParser(perChannel, username || undefined)

    // Реальная доставка уведомлений подписчикам (внутри — Bot API и лимиты)
    let notified = { sent: 0, failed: 0, recipients: 0 }
    try {
      notified = await notifyNewPosts(result.newPosts)
    } catch (e) {
      console.error('[parse] notify failed', e)
    }

    return NextResponse.json({ ...result, notified })
  } catch (e) {
    console.error('[parse]', e)
    return NextResponse.json({ error: 'parse failed' }, { status: 500 })
  }
}
