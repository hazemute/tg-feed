/**
 * feed-cron — ПОСТОЯННОЕ (24/7) отслеживание новых постов Tg Swipe.
 *
 * Дёргает лёгкий тик основного API:
 *   POST /api/parse/tick
 * Тик внутри приложения обрабатывает маленькую ротационную партию каналов
 * (~6 + 2 «горячих» с приоритетом свежих), обновляет посты/просмотры/реакции,
 * доливает медиа постам без картинок.
 *
 * АДАПТИВНЫЙ РИТМ С ЗАСЫПАНИЕМ: пока в ленте появляются новые посты — тик
 * каждые 60с; если круг за кругом «пусто» — интервал плавно растёт (90 → 150 →
 * → 240 → 420 → 600с) и движок «дремлет», экономя запросы к t.me и БД.
 * Любой новый пост возвращает ритм к быстрому. Реакции/просмотры при этом
 * всё равно обновляются: полный круг по каналам при простое ≈ 1–2 часа.
 *
 * ПРЕДПРОГРЕВ ЛЕНТЫ (v5.91, раньше назывался «озвучкой» — TTS убран ещё в v5.35):
 * после тика с НОВЫМИ постами (или раз в 12 «пустых» тиков) движок просит
 * приложение подготовить переводы/саммари/модерацию (/api/warm) — кэш в общей
 * БД тёплый, пользователи прода читают мгновенно. Раньше warm дёргался на
 * КАЖДОМ тике — на Vercel Fluid каждый запуск функции с ИИ-работой стоит
 * память-секунды, это разжигало лимит «Fluid Provisioned Memory».
 *
 * Авторизация: Authorization: Bearer <CRON_SECRET> из корневого .env.
 *
 * HTTP-интерфейс (порт 3020):
 *   GET  /status — состояние, ритм и история тиков
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
const FIRST_TICK_DELAY_MS = 15 * 1000
const CRON_SECRET = (process.env.CRON_SECRET ?? '').trim()

/** Ритм с засыпанием: индекс — число подряд «пустых» тиков (сек до следующего).
 *  v5.88: дремота углублена (до 10 мин) — каждый тик на Vercel Fluid это
 *  память-секунды; при простое ленты частые тики ничего не дают. */
const RHYTHM_SEC = [60, 90, 150, 240, 420, 600]
let rhythmIdx = 0 // 0 — быстрый режим
let timer: ReturnType<typeof setTimeout> | null = null
let tickCounter = 0 // для редкого прогрева в дремоте

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
let lastAdded = 0

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
      // тик с карточками каналов может длиться до ~110с (медленный t.me + Bot API):
      // раньше 120с не хватало и тик помечался ошибкой «timed out», хотя работа шла
      signal: AbortSignal.timeout(180_000),
    })
    const data = (await res.json()) as Record<string, unknown>
    lastAdded = typeof data.added === 'number' ? data.added : 0
    const result: TickResult = {
      at,
      ok: res.ok,
      batch: typeof data.batch === 'number' ? data.batch : undefined,
      added: lastAdded,
      enriched: typeof data.enriched === 'number' ? data.enriched : undefined,
      ms: typeof data.ms === 'number' ? data.ms : undefined,
      error: res.ok ? undefined : String(data.error ?? res.status),
    }
    tickLog.unshift(result)
    tickLog.length = Math.min(tickLog.length, 30)
    if (result.added) {
      console.log(`[tick] +${result.added} постов (партия ${result.batch}, ${result.ms}мс, следующий тик через ${RHYTHM_SEC[rhythmIdx]}с)`)
    }
    return result
  } catch (e) {
    lastAdded = 0
    const result: TickResult = { at, ok: false, error: String((e as Error)?.message ?? e) }
    tickLog.unshift(result)
    tickLog.length = Math.min(tickLog.length, 30)
    return result
  } finally {
    ticking = false
  }
}

async function prewarmWarm(): Promise<void> {
  try {
    const res = await fetch(`${MAIN_APP}/api/warm`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(CRON_SECRET ? { authorization: `Bearer ${CRON_SECRET}` } : {}),
      },
      body: '{}',
      signal: AbortSignal.timeout(90_000),
    })
    if (res.ok) {
      const data = (await res.json()) as { translated?: number; summarized?: number }
      const n = (data.translated ?? 0) + (data.summarized ?? 0)
      if (n) console.log(`[warm] +${n} (переводы+саммари)`)
    }
  } catch {
    // прогрев необязателен — пользовательская генерация сработает по запросу
  }
}

/**
 * Самопланирующийся цикл: после каждого тика выбираем следующий интервал.
 * Новые посты (или ошибка сети — возможно, она временная) держат быстрый ритм,
 * серия пустых тиков уводит движок в дремоту (до 10 минут).
 */
async function loop(): Promise<void> {
  await tick('interval')
  if (lastAdded > 0 || tickLog[0]?.ok === false) rhythmIdx = 0
  else rhythmIdx = Math.min(rhythmIdx + 1, RHYTHM_SEC.length - 1)
  const delaySec = RHYTHM_SEC[rhythmIdx]
  timer = setTimeout(() => void loop(), delaySec * 1000)
  // unref: таймер не держит процесс, если всё остальное умерло
  timer.unref?.()
  // v5.91: прогрев НЕ на каждом тике — только после новых постов или раз в 12
  // пустых тиков (в дремоте 600с это ≈ раз в 2 часа; каждый вызов warm =
  // serverless-функция с ИИ-работой = память-секунды на Vercel Fluid).
  // До v5.88 warm звался на каждом тике, v5.88–v5.90 — раз в 6.
  tickCounter++
  if (lastAdded > 0 || tickCounter % 12 === 0) void prewarmWarm()
}

// HTTP-интерфейс для наблюдения и ручного запуска
Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/status') {
      return Response.json({
        mode: 'adaptive-24-7',
        rhythmSec: RHYTHM_SEC,
        currentDelaySec: RHYTHM_SEC[rhythmIdx],
        idleStreak: rhythmIdx,
        mainApp: MAIN_APP,
        ticking,
        last: tickLog[0] ?? null,
        history: tickLog.slice(0, 10),
      })
    }
    if (url.pathname === '/run' && req.method === 'POST') {
      const r = await tick('manual')
      if (lastAdded > 0) rhythmIdx = 0 // ручной тик с новыми постами ускоряет ритм
      return Response.json(r)
    }
    if (url.pathname === '/health') return Response.json({ ok: true })
    return new Response('feed-cron: /status, POST /run, /health\n', { status: 404 })
  },
})

setTimeout(() => {
  void loop()
}, FIRST_TICK_DELAY_MS)

console.log(`[feed-cron] 24/7 адаптив: ритм ${RHYTHM_SEC.join('→')}с (засыпание при простое) → ${MAIN_APP}/api/parse/tick, порт ${PORT}`)
