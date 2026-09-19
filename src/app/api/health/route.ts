import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { botEnabled, getBotUsername, botBanRemainSecAsync } from '@/lib/tg-bot'
import { redisHealth } from '@/lib/redis'
import { APP_VERSION } from '@/lib/server'
import { checkSchema, ensureAppSchema } from '@/lib/ensure-schema'

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

  // Схема: критичные объекты v5.15/v5.17; если чего-то нет — самолечение
  // (идемпотентные ALTER'ы) прямо здесь, без ре-деплоя.
  let schema = await checkSchema()
  if (!schema.ok) {
    const healed = await ensureAppSchema()
    schema = { ok: healed.ok, missing: healed.missing }
  }

  const cache = await redisHealth()
  const bot = botEnabled()
  const botUsername = bot ? await getBotUsername() : null

  return NextResponse.json(
    {
      ok: dbOk && schema.ok,
      db: dbOk,
      schema,
      cache,
      bot,
      botUsername,
      botBanSec: await botBanRemainSecAsync(),
      session: 'jwt',
      version: APP_VERSION,
      time: new Date().toISOString(),
    },
    { status: dbOk && schema.ok ? 200 : 503 },
  )
}
