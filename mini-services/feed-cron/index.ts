/**
 * feed-cron — ПОСТОЯННОЕ отслеживание новых постов Tg Swipe (адаптивный режим).
 *
 * Каждые 90 секунд дёргает ОДИН лёгкий тик основного API:
 *   POST /api/parse/tick
 * Тик внутри приложения обрабатывает маленькую ротационную партию каналов
 * (~6 + 2 «горячих» с приоритетом свежих), доливает медиа постам без картинок.
 * Полный круг по всем каналам при 100 каналах ≈ 25 минут, нагрузка постоянная
 * и низкая (никаких часовых мега-прогонов).
 *
 * Авторизация: Authorization: Bearer <CRON_SECRET> из корневого .env.
 *
 * HTTP-интерфейс (порт 3020):
 *   GET  /status — состояние и история тиков
 *   POST /run    — внеочередной тик
 */

import { readFileSync } from 'node:fs'

// Bun читает .env из текущей папки, а секрет лежит в корне проекта — грузим вручную
try {
  const envFile = readFileSync(new URL('../../.env', import.meta.url), 'utf8')
  for (const line of envFile.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m) continue
    const value = m[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
    if (!(m[1] in process.env)) process.env[m[1]] = value
  }
} catch {
  // корневого .env может не быть
}

const PORT = 3020
const MAIN_APP = process.env.MAIN_APP_URL ?? 'http://localhost:3000'
const TICK_MS = 90 * 1000 // тик каждые 90с
const FIRST_TICK_DELAY_MS = 15 * 1000
const CRON_SECRET = (process.env.CRON_SECRET ?? '').trim()

type TickResult = {
  at: string
  ok: boolean
  batch?: number
  added?: number
  enriched?: number
  ms?: number
  error?: string
}

const tickLog: TickResult[] = []
let ticking = false

async function tick(reason: string): Promise<TickResult> {
  const at = new Date().toISOString()
  if (ticking) return { at, ok: false, error: 'тик уже выполняется' }
  ticking = true
  try {
    const res = await fetch(`${MAIN_APP}/api/parse/tick`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(CRON_SECRET ? { authorization: `Bearer ${CRON_SECRET}` } : {}),
      },
      body: JSON.stringify({ reason }),
      signal: AbortSignal.timeout(70_000),
    })
    const data = (await res.json()) as Record<string, unknown>
    const result: TickResult = {
      at,
      ok: res.ok,
      batch: typeof data.batch === 'number' ? data.batch : undefined,
      added: typeof data.added === 'number' ? data.added : undefined,
      enriched: typeof data.enriched === 'number' ? data.enriched : undefined,
      ms: typeof data.ms === 'number' ? data.ms : undefined,
      error: res.ok ? undefined : String(data.error ?? res.status),
    }
    tickLog.unshift(result)
    tickLog.length = Math.min(tickLog.length, 30)
    if (result.added) {
      console.log(`[tick] +${result.added} постов (партия ${result.batch}, ${result.ms}мс)`)
    }
    return result
  } catch (e) {
    const result: TickResult = { at, ok: false, error: String((e as Error)?.message ?? e) }
    tickLog.unshift(result)
    tickLog.length = Math.min(tickLog.length, 30)
    return result
  } finally {
    ticking = false
  }
}

// HTTP-интерфейс для наблюдения и ручного запуска
Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/status') {
      return Response.json({
        mode: 'adaptive',
        tickMs: TICK_MS,
        mainApp: MAIN_APP,
        ticking,
        last: tickLog[0] ?? null,
        history: tickLog.slice(0, 10),
      })
    }
    if (url.pathname === '/run' && req.method === 'POST') {
      return Response.json(await tick('manual'))
    }
    if (url.pathname === '/health') return Response.json({ ok: true })
    return new Response('feed-cron: /status, POST /run, /health\n', { status: 404 })
  },
})

setTimeout(() => {
  void tick('boot')
  setInterval(() => void tick('interval'), TICK_MS)
}, FIRST_TICK_DELAY_MS)

console.log(`[feed-cron] адаптивный режим: тик каждые ${TICK_MS / 1000}с → ${MAIN_APP}/api/parse/tick, порт ${PORT}`)
