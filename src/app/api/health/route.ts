import { NextResponse, after } from 'next/server'
import { db } from '@/lib/db'
import { botEnabled, getBotUsername, botBanRemainSecAsync, TELEGRAM_REQUIRED_UPDATES } from '@/lib/tg-bot'
import { redisHealth } from '@/lib/redis'
import { APP_VERSION } from '@/lib/server'
import { checkSchema, ensureAppSchema } from '@/lib/ensure-schema'
import { cronAuthorized } from '@/lib/guard'
import { ensureContentCatalog, stepContentCatalog } from '@/lib/content-catalog'

// Прод: очередь контента (discover кураторских каналов) может работать в after()
// до 60с — response возвращается сразу, миграция доезжает в фоне
export const maxDuration = 60

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
/*
 * v5.76: самолечение webhook-URL бота.
 *
 * Канонический домен (в порядке приоритета):
 *   1. NEXT_PUBLIC_APP_URL (задан руками в Vercel env)
 *   2. VERCEL_PROJECT_PRODUCTION_URL (Vercel даёт сам: tg-swipe.vercel.app,
 *      без протокола) — НЕ меняется между деплоями, в отличие от VERCEL_URL
 *
 * Троттлинг getWebhookInfo: раз в 5 минут на инстанс (health дергается часто,
 * а вызов Telegram API из health лишний раз не нужен). setWebhook — только
 * при фактическом расхождении. drop_pending_updates=false: очередь апдейтов
 * (например, накопившиеся /start) доезжает и обрабатывается.
 */
const WEBHOOK_CHECK_INTERVAL_MS = 5 * 60_000
let lastWebhookCheckAt = 0

function canonicalBotOrigin(): string | null {
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.trim()
  if (explicit) return explicit.replace(/\/$/, '')
  const vercelProd = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim()
  if (vercelProd) return `https://${vercelProd.replace(/\/$/, '')}`
  return null
}

async function healBotWebhook(botEnabledFlag: boolean): Promise<{
  ok: boolean | null
  url: string | null
  expected: string | null
  healed: boolean
  lastError: string | null
}> {
  const empty = { ok: null, url: null, expected: null, healed: false, lastError: null }
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  if (!botEnabledFlag || !token) return empty

  const expectedOrigin = canonicalBotOrigin()
  if (!expectedOrigin) return empty // локально/preview — не трогаем
  const expectedUrl = `${expectedOrigin}/api/bot/webhook`

  const now = Date.now()
  if (now - lastWebhookCheckAt < WEBHOOK_CHECK_INTERVAL_MS) {
    return { ...empty, expected: expectedUrl }
  }
  lastWebhookCheckAt = now

  try {
    const infoRes = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
      signal: AbortSignal.timeout(6000),
    })
    const info = (await infoRes.json()) as {
      ok?: boolean
      result?: { url?: string; last_error_message?: string; pending_update_count?: number; allowed_updates?: string[] }
    }
    const currentUrl = info.result?.url ?? ''
    const lastError = info.result?.last_error_message ?? null
    /* v5.92: сверяем не только URL, но и allowed_updates (как это делает
       webhook-роут) — раньше самолечение здесь регистрировало вебхук БЕЗ
       channel_post/edited_channel_post, и мгновенные посты привязанных
       каналов молча переставали доезжать. */
    const allowed = info.result?.allowed_updates ?? []
    const updatesOk =
      allowed.length === 0 // пусто = дефолт Telegram (все кроме selected) — норма
        ? true
        : TELEGRAM_REQUIRED_UPDATES.every((u) => allowed.includes(u))
    if (currentUrl === expectedUrl && updatesOk) {
      return { ok: true, url: currentUrl, expected: expectedUrl, healed: false, lastError }
    }

    // Расхождение (пусто / чужой dpl-URL / другой домен) — перерегистрируем
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim()
    const healRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: expectedUrl,
        ...(secret ? { secret_token: secret } : {}),
        allowed_updates: TELEGRAM_REQUIRED_UPDATES,
        max_connections: 40,
        drop_pending_updates: false,
      }),
      signal: AbortSignal.timeout(8000),
    })
    const healed = ((await healRes.json()) as { ok?: boolean } | null)?.ok === true
    console.log(
      `[health] webhook ${healed ? 'перерегистрирован' : 'НЕ удалось перерегистрировать'}: ${currentUrl || '<пусто>'} → ${expectedUrl}`,
    )
    return { ok: healed, url: currentUrl, expected: expectedUrl, healed, lastError }
  } catch {
    return { ok: null, url: null, expected: expectedUrl, healed: false, lastError: null }
  }
}

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

  // v5.76: контент-каталог подростковой ленты — одноразовая миграция (быстрая
  // часть — категории/флаг) + очередь добавления кураторских каналов в after()
  // (сеть/парсинг — НЕ в основном потоке ответа). Шаг планируем на КАЖДЫЙ
  // health-вызов: внутри stepContentCatalog свой троттлинг ≥90с + skip для SQLite
  let catalogDiag: Record<string, unknown> | null = null
  try {
    await ensureContentCatalog()
    after(async () => {
      stepContentCatalog().catch((e) => console.error('[health] catalog step', e))
      // v5.77.4: ФОНОВЫЙ АВТОПАРСИНГ при health (троттлинг 2.5 мин, cross-instance).
      // Vercel cron на Hobby — раз в сутки, этого мало для роста ленты.
      // v5.81: GH Actions пингует каждые 3 мин, троттлинг 2.5 мин → парсинг
      // фактически на КАЖДЫЙ пинг; партия 12+6 каналов, бюджет 35с, 3 воркера —
      // свежие посты появляются в среднем через 3-5 минут с публикации.
      try {
        const last = await db.botSetting.findUnique({ where: { key: 'health_parse_at' } })
        const lastAt = last ? Date.parse(last.value) : 0
        if (Date.now() - lastAt < 150_000) return
        await db.botSetting
          .upsert({
            where: { key: 'health_parse_at' },
            create: { key: 'health_parse_at', value: new Date().toISOString() },
            update: { value: new Date().toISOString() },
          })
          .catch(() => {})
        const [{ nextAdaptiveBatch }, { runParser }] = await Promise.all([
          import('@/lib/parse-scheduler'),
          import('@/lib/parse-engine'),
        ])
        const batch = await nextAdaptiveBatch()
        if (batch.length > 0) {
          const r = await runParser(6, undefined, batch.length, 35_000, 3, batch)
          if (r.newPosts.length > 0) console.log('[health] auto-parse: +' + r.newPosts.length, 'posts')
        }
      } catch (e) {
        console.error('[health] auto-parse failed', e)
      }
    })
    // v5.77: публичная диагностика фазы (phase/счётчики/хвост лога — без секретов):
    // без неё невозможно увидеть, почему discover не добавляет каналы
    try {
      const row = await db.botSetting.findUnique({ where: { key: 'content-catalog:state' } })
      if (row) {
        const st = JSON.parse(row.value) as {
          phase?: string
          done?: unknown[]
          failed?: Array<{ username: string; reason: string }>
          queue?: string[]
          log?: string[]
        }
        catalogDiag = {
          phase: st.phase ?? null,
          done: st.done?.length ?? 0,
          failed: st.failed?.length ?? 0,
          queued: st.queue?.length ?? 0,
          lastFailed: (st.failed ?? []).slice(-4).map((f) => `${f.username}: ${f.reason.slice(0, 60)}`),
          lastLog: (st.log ?? []).slice(-4),
        }
      } else {
        catalogDiag = { phase: 'no-state' }
      }
    } catch {
      catalogDiag = { phase: 'diag-error' }
    }
  } catch (e) {
    console.error('[health] content-catalog init failed', e)
  }

  const cache = await redisHealth()
  const bot = botEnabled()
  // botUsername — наружу не отдаём (цель для спам-ботов), только факт наличия
  const botUsername = diag && bot ? await getBotUsername() : null

  // v5.76: САМОЛЕЧЕНИЕ WEBHOOK. Раньше вебхук мог быть зарегистрирован на
  // dpl-URL (URL конкретного деплоя) — после удаления старых деплоев Telegram
  // шлёт апдейты в никуда: бот «не отвечает, грузит бесконечно». Health —
  // самая частая точка входа, поэтому здесь сверяем URL вебхука с каноническим
  // прод-доменом и перерегистрируем при расхождении (drop_pending=false —
  // накопившиеся /start пользователей доезжают и получают ответ).
  const webhook = await healBotWebhook(bot)

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
      // v5.77: диагностика перезагрузки контента (фаза purge/discover)
      catalog: catalogDiag,
      // v5.76: диагноз вебхука наружу только за cron-секретом (url бота — цель для спама)
      ...(diag ? { webhook } : {}),
      botBanSec: await botBanRemainSecAsync(),
      session: 'jwt',
      version: APP_VERSION,
      time: new Date().toISOString(),
    },
    { status: dbOk && schema.ok ? 200 : 503 },
  )
}
