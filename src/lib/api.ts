'use client'

/**
 * Единая обёртка над fetch: автоматически прикрепляет Bearer-сессию,
 * обрабатывает 401 (сброс токена + событие re-auth) и единообразит ошибки API.
 */

const TOKEN_KEY = 'tgfeed_session'

export function getSessionToken(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setSessionToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // приватный режим — сессия не переживёт перезагрузку, это не критично
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getSessionToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  }
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await fetch(path, {
    cache: 'no-store',
    ...init,
    headers,
    // Запрос не может висеть вечно: без таймаута упавший (зависший) запрос
    // оставлял спиннер «загрузки постов» навсегда — главный источник бага
    // «бесконечной загрузки». 20с хватает даже холодному дальнему Supabase.
    signal: init?.signal ?? AbortSignal.timeout(20_000),
  })

  if (res.status === 401) {
    // Сессия протухла/невалидна — сбрасываем и просим page.tsx пере-авторизоваться
    setSessionToken(null)
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('tgfeed:unauthorized'))
  }

  if (res.status === 503) {
    // Режим техработ: middleware режет API с {maintenance:true} — переводим весь app на экран техработ
    const m = (await res.json().catch(() => ({}))) as { maintenance?: unknown }
    if (m.maintenance === true && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('tgfeed:maintenance'))
    }
  }

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

/**
 * SSE-стрим POST-запроса (перевод/саммари «за секунду»): каждое событие сервера
 * отдаётся в onEvent(type, data) сразу по прибытии. EventSource не подходит —
 * он не умеет POST и не передаёт Authorization, поэтому свой мини-парсер.
 */
export async function apiStream(
  path: string,
  body: unknown,
  onEvent: (type: string, data: Record<string, unknown>) => void,
): Promise<void> {
  const token = getSessionToken()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await fetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    cache: 'no-store',
    // Стрим может длиться дольше обычного запроса (перевод длинного поста
    // до 4096 символов) — 60с с запасом, но не вечно
    signal: AbortSignal.timeout(60_000),
  })

  if (res.status === 401) {
    setSessionToken(null)
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('tgfeed:unauthorized'))
  }
  if (res.status === 503) {
    const m = (await res.json().catch(() => ({}))) as { maintenance?: unknown }
    if (m.maintenance === true && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('tgfeed:maintenance'))
    }
  }
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error || `HTTP ${res.status}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    // События разделены пустой строкой: "event: X\ndata: {...}\n\n"
    const parts = buf.split('\n\n')
    buf = parts.pop() ?? ''
    for (const part of parts) {
      let type = 'message'
      let data: Record<string, unknown> = {}
      for (const line of part.split('\n')) {
        if (line.startsWith('event:')) type = line.slice(6).trim()
        else if (line.startsWith('data:')) {
          try {
            data = JSON.parse(line.slice(5).trim()) as Record<string, unknown>
          } catch {
            // битый json — событие пропускаем
          }
        }
      }
      onEvent(type, data)
    }
  }
}
