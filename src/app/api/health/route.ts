import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { botEnabled, getBotUsername } from '@/lib/tg-bot'
import { redisHealth } from '@/lib/redis'
import { APP_VERSION } from '@/lib/server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/health — статус здоровья бэкенда (мониторинг/cron-сервис).
 * Публичный, но без чувствительных данных.
 */
export async function GET() {
  let dbOk = false
  try {
    await db.$queryRaw`SELECT 1`
    dbOk = true
  } catch {
    dbOk = false
  }

  const cache = await redisHealth()
  const bot = botEnabled()
  const botUsername = bot ? await getBotUsername() : null

  return NextResponse.json(
    {
      ok: dbOk,
      db: dbOk,
      cache,
      bot,
      botUsername,
      session: 'jwt',
      version: APP_VERSION,
      time: new Date().toISOString(),
    },
    { status: dbOk ? 200 : 503 },
  )
}
