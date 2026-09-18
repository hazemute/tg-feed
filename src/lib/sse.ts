/**
 * Мини-хелпер Server-Sent Events для стриминговых роутов (перевод/саммари).
 *
 * Протокол: именованные события `event: <type>` + `data: <json>`.
 * Клиент читает поток через fetch+ReadableStream (EventSource не умеет POST
 * и не передаёт Authorization — поэтому свой мини-парсер в api.ts).
 */

export type SseSend = (event: string, data: unknown) => void

/** Создать SSE-поток: колбэк send() кодирует и пишёт событие в поток */
export function sseStream(build: (send: SseSend) => Promise<void>): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const send: SseSend = (event, data) => {
        if (closed) return
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          )
        } catch {
          closed = true // клиент отключился — дальше просто досматриваем логику
        }
      }
      try {
        await build(send)
      } finally {
        closed = true
        try {
          controller.close()
        } catch {
          // уже закрыт
        }
      }
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
