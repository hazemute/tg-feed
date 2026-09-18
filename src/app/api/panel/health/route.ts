import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { APP_VERSION } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'
import { botEnabled, getBotUsername, botBanRemainSecAsync } from '@/lib/tg-bot'

export const dynamic = 'force-dynamic'

function dbProvider(): string {
  const url = process.env.DATABASE_URL ?? ''
  if (url.startsWith('file:')) return 'sqlite'
  if (url.startsWith('postgres')) return 'postgresql'
  if (url.startsWith('mysql:')) return 'mysql'
  return 'unknown'
}

/**
 * GET /api/panel/health — расширенный health для локальной админ-панели.
 * Доступ: x-admin-key. Без секретов — только boolean-флаги их наличия.
 */
export async function GET(request: Request) {
  const g = guardAdmin(request, { limit: 120, windowMs: 60_000, bucket: 'panel-health' })
  if (!g.ok) return g.res

  let dbOk = false
  try {
    await db.$queryRaw`SELECT 1`
    dbOk = true
  } catch {
    dbOk = false
  }

  const bot = botEnabled()
  const botUsername = bot ? await getBotUsername() : null

  // Прогресс бэкфилла карточек: сколько активных каналов ещё без реального
  // числа подписчиков/аватара (заполняется тиками Bot API)
  let channelsMissingCards = 0
  let channelsTotal = 0
  try {
    const [miss, tot] = await Promise.all([
      db.channel.count({ where: { status: 'active', OR: [{ membersCount: null }, { photoFileId: null }] } }),
      db.channel.count({ where: { status: 'active' } }),
    ])
    channelsMissingCards = miss
    channelsTotal = tot
  } catch {
    // БД моргнула — поля останутся 0
  }

  return NextResponse.json(
    {
      ok: dbOk,
      db: dbOk,
      bot,
      botUsername,
      botBanSec: await botBanRemainSecAsync(),
      channelsMissingCards,
      channelsTotal,
      session: 'jwt',
      version: APP_VERSION,
      uptimeSec: Math.round(process.uptime()),
      time: new Date().toISOString(),
      env: {
        nodeEnv: process.env.NODE_ENV ?? 'development',
        cronSecretSet: Boolean(process.env.CRON_SECRET?.trim()),
        adminKeySet: Boolean(process.env.ADMIN_KEY?.trim()),
        botTokenSet: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()),
        dbProvider: dbProvider(),
      },
    },
    { status: dbOk ? 200 : 503 },
  )
}
