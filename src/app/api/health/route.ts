import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { botEnabled, getBotUsername, botBanRemainSecAsync } from '@/lib/tg-bot'
import { redisHealth } from '@/lib/redis'
import { APP_VERSION } from '@/lib/server'
import { checkSchema, ensureAppSchema } from '@/lib/ensure-schema'
import { cronAuthorized } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * Сводка строк подключения БД БЕЗ секретов: хост:порт, имя юзера, параметры.
 * Нужно для диагностики cutover'а (в Vercel могут оказаться значения от
 * другого проекта Supabase — видено в 5.36.1: приложение молча само создало
 * пустую схему на чужой БД).
 *
 * v5.48: выдается ТОЛЬКО за cron-секретом — раньше хост/юзер/имя БД и
 * фингерпринт (размер БД, current_user) отдавались любому, это инфра-
 * разведка для прицельного брутфорса/прямого подключения.
 */
function envDbSummary(raw: string | undefined): Record<string, string> | null {
  if (!raw) return null
  try {
    const u = new URL(raw)
    return {
      host: u.hostname,
      port: u.port || '5432',
      user: decodeURIComponent(u.username),
      db: u.pathname.replace(/^\//, '') || 'postgres',
      params: [...u.searchParams.keys()].join(','),
    }
  } catch {
    return { host: '<unparseable>' }
  }
}

/**
 * GET /api/health — статус здоровья бэкенда (мониторинг/cron-сервис).
 * Публичная часть: ok/db/schema/cache/bot/version. Диагностические сводки
 * env/фингерпринт — только с cron-секретом (v5.48: закрыта инфра-разведка).
 */
export async function GET(request: Request) {
  const diag = cronAuthorized(request)

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
  // botUsername — наружу не отдаём (цель для спам-ботов), только факт наличия
  const botUsername = diag && bot ? await getBotUsername() : null

  // Фингерпринт фактической БД (какой проект реально подключён): размер,
  // наличие таблиц, current_user. Достаточно, чтобы различить старый/новый/
  // посторонний пустой проект Supabase. pg_* существует только на Postgres —
  // на SQLite-песочнице (file:) запрос бессмыслен и шумел ошибкой в лог.
  // v5.48: только за cron-секретом.
  let dbFinger: Record<string, unknown> | null = null
  if (diag && !(process.env.DATABASE_URL ?? '').startsWith('file:')) {
    try {
      const r = await db.$queryRaw<{ sz: string; usr: string; has_post: string | null; has_sys: string | null }[]>`
        select pg_database_size(current_database())::text as sz,
               current_user as usr,
               to_regclass('public."Post"')::text as has_post,
               to_regclass('public."SystemSetting"')::text as has_sys`
      dbFinger = r[0] ?? null
    } catch {
      dbFinger = null
    }
  }

  return NextResponse.json(
    {
      ok: dbOk && schema.ok,
      db: dbOk,
      schema,
      ...(diag
        ? {
            dbFinger,
            dbEnv: {
              database_url: envDbSummary(process.env.DATABASE_URL),
              direct_url: envDbSummary(process.env.DIRECT_URL),
            },
          }
        : {}),
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
