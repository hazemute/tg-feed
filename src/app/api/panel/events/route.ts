import { adminBus, type AdminEventMap } from '@/lib/events'
import { guardAdmin } from '@/lib/guard'

export const dynamic = 'force-dynamic'

const ADMIN_EVENT_NAMES = ['parse:start', 'parse:progress', 'parse:done'] as const

/**
 * GET /api/panel/events — SSE-поток живых событий админ-панели.
 *
 * События:
 *  - event: hello           — подтверждение подключения
 *  - event: status          — heartbeat каждые 20с { ts, bot }
 *  - event: parse:start     — парсер начал прогон { total }
 *  - event: parse:progress  — обработан канал { current, total, username, title, added, error? }
 *  - event: parse:done      — прогон завершён { newPosts, ms }
 *  - `: hb`                 — keep-alive против таймаутов прокси
 *
 * Авторизация: x-admin-key / Bearer / ?key= (фолбэк для EventSource, который
 * не умеет кастомные заголовки). Лимит: 10 подключений/мин с одного IP.
 */
export async function GET(request: Request) {
  const g = guardAdmin(request, { limit: 10, windowMs: 60_000, bucket: 'panel-sse' })
  if (!g.ok) return g.res

  const botConfigured = Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim())
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      let closed = false

      const send = (event: string, data?: unknown) => {
        if (closed) return
        try {
          controller.enqueue(
            encoder.encode(
              data === undefined ? `event: ${event}\n\n` : `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
            ),
          )
        } catch {
          closed = true
        }
      }

      const listeners = ADMIN_EVENT_NAMES.map((name) => {
        const fn = (payload: AdminEventMap[typeof name]) => send(name, payload)
        adminBus().on(name, fn)
        return { name, fn }
      })

      // hello + первый статус сразу
      send('hello', { ts: Date.now() })
      send('status', { ts: Date.now(), bot: botConfigured })

      const statusTimer = setInterval(() => {
        send('status', { ts: Date.now(), bot: botConfigured })
        send('hb')
      }, 20_000)

      const close = () => {
        if (closed) return
        closed = true
        clearInterval(statusTimer)
        for (const { name, fn } of listeners) adminBus().off(name, fn)
        try {
          controller.close()
        } catch {
          // уже закрыт
        }
      }

      request.signal.addEventListener('abort', close)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
