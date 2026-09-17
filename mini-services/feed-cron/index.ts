/**
 * feed-cron — планировщик обновления ленты TG-Feed.
 *
 * Раз в час дергает основной API Next.js (порт 3000):
 *   POST /api/parse { perChannel: 5 }
 * Парсер внутри приложения забирает новейшие посты с t.me/s/<username>
 * активных каналов (не более 5 постов на канал за прогон).
 *
 * Авторизация: если у Next задан CRON_SECRET, сервис шлёт заголовок
 *   Authorization: Bearer <CRON_SECRET>
 * Секрет берётся из корневого .env проекта (см. загрузчик ниже) или из
 * окружения процесса (явно заданные переменные имеют приоритет).
 * Если CRON_SECRET пуст — заголовок НЕ отправляется вовсе (эндпоинт Next
 * в этом режиме открыт всем, совместимость с ручной кнопкой в админке).
 *
 * HTTP-интерфейс (порт 3020):
 *   GET  /status — состояние планировщика и история прогонов
 *   POST /run    — внеочередной прогон
 */

import { readFileSync } from 'node:fs'

// Bun читает .env из текущей папки (mini-services/feed-cron), а секрет лежит в
// корне проекта — грузим его вручную; уже установленные переменные не перезаписываем.
try {
  const envFile = readFileSync(new URL('../../.env', import.meta.url), 'utf8')
  for (const line of envFile.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m) continue
    const key = m[1]
    const value = m[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
    if (!(key in process.env)) process.env[key] = value
  }
} catch {
  // корневого .env может не быть — работаем без секрета (Next тоже без него)
}

const PORT = 3020
const MAIN_APP = 'http://localhost:3000'
const INTERVAL_MS = 60 * 60 * 1000 // час
const FIRST_RUN_DELAY_MS = 20 * 1000 // первый прогон через 20с после старта
// Пустой секрет → заголовок не отправляется (Next в таком режиме не требует авторизации)
const CRON_SECRET = (process.env.CRON_SECRET ?? '').trim()

type RunResult = {
  startedAt: string
  finishedAt?: string
  ok: boolean
  added?: number
  channels?: number
  error?: string
}

const runLog: RunResult[] = []
let running = false

async function run(reason: string): Promise<RunResult> {
  if (running) {
    return { startedAt: new Date().toISOString(), ok: false, error: 'прогон уже выполняется' }
  }
  running = true
  const rec: RunResult = { startedAt: new Date().toISOString(), ok: false }
  console.log(`[feed-cron] прогон (${reason}) → POST ${MAIN_APP}/api/parse`)
  try {
    const res = await fetch(`${MAIN_APP}/api/parse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Секрет отправляем только если он реально задан (иначе — без заголовка)
        ...(CRON_SECRET ? { Authorization: `Bearer ${CRON_SECRET}` } : {}),
      },
      body: JSON.stringify({ perChannel: 5 }),
      signal: AbortSignal.timeout(120_000),
    })
    const data = (await res.json().catch(() => ({}))) as {
      results?: { username: string; added: number; error?: string }[]
      error?: string
    }
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
    const results = data.results ?? []
    rec.added = results.reduce((sum, r) => sum + (r.added || 0), 0)
    rec.channels = results.length
    rec.ok = true
    console.log(
      `[feed-cron] готово: +${rec.added} постов в ${rec.channels ?? 0} каналах`,
    )
  } catch (e) {
    rec.error = String((e as Error)?.message ?? e)
    console.error('[feed-cron] ошибка прогона:', rec.error)
  } finally {
    rec.finishedAt = new Date().toISOString()
    runLog.unshift(rec)
    if (runLog.length > 30) runLog.pop()
    running = false
  }
  return rec
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/status') {
      return Response.json({
        ok: true,
        intervalMs: INTERVAL_MS,
        nextRunAt: new Date(Date.now() + INTERVAL_MS).toISOString(),
        running,
        auth: CRON_SECRET ? 'bearer' : 'none',
        runs: runLog.length,
        last: runLog[0] ?? null,
        history: runLog.slice(0, 10),
      })
    }
    if (url.pathname === '/run' && req.method === 'POST') {
      const rec = await run('manual')
      return Response.json({ ok: true, run: rec })
    }
    return new Response('feed-cron: GET /status, POST /run\n', { status: 404 })
  },
})

console.log(`[feed-cron] сервис поднят: http://localhost:${server.port}`)
console.log(`[feed-cron] первый прогон через ${FIRST_RUN_DELAY_MS / 1000}с, далее каждый час`)

setTimeout(() => void run('boot'), FIRST_RUN_DELAY_MS)
setInterval(() => void run('hourly'), INTERVAL_MS)
