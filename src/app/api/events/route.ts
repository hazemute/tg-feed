import { verifySession } from '@/lib/session'
import { appBus } from '@/lib/events'
import { guardIp } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * GET /api/events — SSE-поток живых обновлений (Server-Sent Events).
 *
 * События:
 *  - event: hello      — подтверждение подключения
 *  - event: posts:new  — парсер добавил новые посты { total, usernames }
 *  - `: hb` каждые 25с — keep-alive против таймаутов прокси
 *
 * Авторизация: Bearer-токен сессии (заголовок) либо ?token= (фолбэк для
 * окружений, где заголовки прокси вырезаются — EventSource не умеет заголовки,
 * наш клиент ходит через fetch-стрим, но фолбэк оставлен намеренно).
 * Лимит: 10 подключений/мин с одного IP.
 */
export async function GET(request: Request) {
  const ip = guardIp(request, { limit: 10, windowMs: 60_000, bucket: 'sse' })
  if (!ip.ok) return ip.res

  const url = new URL(request.url)
  const queryToken = url.searchParams.get('token')
  const session = verifySession(queryToken) ?? verifySession(request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null)
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // ЕДИНСТВЕННЫЙ флаг жизненного цикла + идемпотентный cleanup.
      // Раньше: cleanup ранним return'ом выходил при closed=true (флаг ставился
      // неудачным enqueue при обрыве клиента) — clearInterval и off() НЕ
      // выполнялись, и на общей шине appBus накапливались мёртвые слушатели
      // (2 на каждое reconnect-соединение) + вечные 25-секундные интервалы.
      // МаксListeners(200) забивался, память текла. Теперь cleanup всегда
      // отрабатывает ровно один раз, из любой точки.
      let cleaned = false
      let heartbeat: ReturnType<typeof setInterval> | undefined

      const cleanup = () => {
        if (cleaned) return
        cleaned = true
        if (heartbeat) clearInterval(heartbeat)
        appBus().off('posts:new', onPostsNew)
        appBus().off('notif:new', onNotifNew)
        try {
          controller.close()
        } catch {
          // поток уже закрыт клиентом
        }
      }

      const send = (event: string, data: unknown) => {
        if (cleaned) return
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {
          cleanup()
        }
      }

      const onPostsNew = (payload: unknown) => send('posts:new', payload)
      // notif:new — толчок бейджу колокольчика; событие адресное:
      // пушим только тому SSE-клиенту, чей userId совпал с получателем
      const onNotifNew = (payload: { userId: string }) => {
        if (payload.userId === session.uid) send('notif:new', { ok: true })
      }

      heartbeat = setInterval(() => {
        if (cleaned) return
        try {
          controller.enqueue(encoder.encode(': hb\n\n'))
        } catch {
          cleanup()
        }
      }, 25_000)

      appBus().on('posts:new', onPostsNew)
      appBus().on('notif:new', onNotifNew)

      send('hello', { ok: true, time: Date.now() })

      request.signal.addEventListener('abort', cleanup)
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
