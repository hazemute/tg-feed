import { NextResponse } from 'next/server'
import { cronAuthorized, guardIp } from '@/lib/guard'
import { runParser } from '@/lib/parse-engine'
import { notifyNewPosts } from '@/lib/tg-bot'
import { nextAdaptiveBatch, enrichMissingMedia } from '@/lib/parse-scheduler'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST|GET /api/parse/tick — ОДИН тик адаптивного шедулера (для cron-сервиса).
 *
 * Постоянное отслеживание новых постов с минимальным расходом: каждый тик
 * обрабатывает маленькую ротационную партию каналов (~6 + 2 «горячих»),
 * плюс доливает медиа паре постов без картинок (embed-бэкфилл).
 * Призывайте эндпоинт каждые 60–120 секунд — нагрузка постоянная и низкая,
 * свежие каналы опрашиваются чаще за счёт приоритетных слотов.
 * Авторизация: Authorization: Bearer $CRON_SECRET (как /api/parse).
 */
async function handle(request: Request) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const ip = guardIp(request, { limit: 60, windowMs: 60_000, bucket: 'cron-tick' })
  if (!ip.ok) return ip.res

  const started = Date.now()
  try {
    const batch = await nextAdaptiveBatch()
    if (batch.length === 0) {
      return NextResponse.json({ ok: true, batch: 0, added: 0, enriched: 0 })
    }

    // per=5 новых постов на канал, тайм-бюджет 45с — тик остаётся лёгким
    const result = await runParser(5, undefined, batch.length, Date.now() + 45_000, 1, batch)

    let notified = { sent: 0, failed: 0, recipients: 0 }
    try {
      notified = await notifyNewPosts(result.newPosts)
    } catch (e) {
      console.error('[tick] notify failed', e)
    }

    // бэкфилл медиа — в остатке бюджета
    let enriched = 0
    if (Date.now() - started < 40_000) {
      try {
        enriched = (await enrichMissingMedia()).enriched
      } catch (e) {
        console.error('[tick] enrich failed', e)
      }
    }

    return NextResponse.json({
      ok: true,
      batch: batch.length,
      added: result.newPosts.length,
      truncated: result.truncated ?? false,
      enriched,
      notified,
      ms: Date.now() - started,
    })
  } catch (e) {
    console.error('[tick]', e)
    return NextResponse.json({ error: 'tick failed' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  return handle(request)
}

export async function GET(request: Request) {
  return handle(request)
}
