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
      let closed = false

      const send = (event: string, data: unknown) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {
          closed = true
        }
      }

      send('hello', { ok: true, time: Date.now() })

      const onPostsNew = (payload: unknown) => send('posts:new', payload)
      appBus().on('posts:new', onPostsNew)

      const heartbeat = setInterval(() => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(': hb\n\n'))
        } catch {
          closed = true
        }
      }, 25_000)

      const cleanup = () => {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        appBus().off('posts:new', onPostsNew)
        try {
          controller.close()
        } catch {
          // поток уже закрыт клиентом
        }
      }
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
