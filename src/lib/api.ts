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
    // Кэш мог быть набран под старой сессией — мгновенно забываем всё
    MEMO_CACHE.clear()
    INFLIGHT.clear()
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('tgfeed:unauthorized'))
  }

  if (!res.ok) {
    // Тело читаем ОДИН раз (повторный res.json() бросает «body used already»
    // и терял поле error — тост показывал безликое «HTTP 503»)
    const data = (await res.json().catch(() => ({}))) as { error?: string; maintenance?: unknown }
    // Режим техработ: middleware режет API с {maintenance:true} — весь app на экран техработ
    if (data.maintenance === true && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('tgfeed:maintenance'))
    }
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

/* ====================== МГНОВЕННЫЕ ВКЛАДКИ (v5.34) ====================== */

/**
 * Клиентский кэш GET-ответов в памяти вкладки + дедупликация одновременных
 * запросов. Переключение вкладок («Поиск», «Тренды»…) отдаёт данные из кэша
 * БЕЗ сетевого раунд-трипа — экраны рисуются мгновенно; префетч на простое
 * (page.tsx) греет кэш заранее, к моменту первого тапа данные уже здесь.
 * Кэш живёт только в памяти сессии — приватность не страдает, 401 всё стирает.
 */
type CacheEntry = { data: unknown; at: number }
const MEMO_CACHE = new Map<string, CacheEntry>()
const INFLIGHT = new Map<string, Promise<unknown>>()
const MEMO_MAX = 60

export function apiCached<T>(path: string, ttlMs = 60_000): Promise<T> {
  const hit = MEMO_CACHE.get(path)
  if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.data as T)
  const running = INFLIGHT.get(path)
  if (running) return running as Promise<T>
  const p = api<T>(path)
    .then((data) => {
      if (MEMO_CACHE.size >= MEMO_MAX) {
        const first = MEMO_CACHE.keys().next().value
        if (first !== undefined) MEMO_CACHE.delete(first)
      }
      MEMO_CACHE.set(path, { data, at: Date.now() })
      return data
    })
    .finally(() => {
      INFLIGHT.delete(path)
    })
  INFLIGHT.set(path, p)
  return p
}

/** Сбросить кэш (например, после мутации, меняющей каталог/тренды) */
export function invalidateApiCache(prefix?: string): void {
  if (!prefix) {
    MEMO_CACHE.clear()
    return
  }
  for (const key of MEMO_CACHE.keys()) {
    if (key.startsWith(prefix)) MEMO_CACHE.delete(key)
  }
}

/**
 * Тихий префетч списка GET-путей в простое браузера: грее apiCached-кэш,
 * не мешая ленте (requestIdleCallback, фолбэк — setTimeout 1200мс).
 */
export function prefetchIdle(paths: string[], ttlMs = 60_000): void {
  if (typeof window === 'undefined' || paths.length === 0) return
  const run = () => {
    for (const p of paths) void apiCached(p, ttlMs).catch(() => {})
  }
  const ric = (window as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
    .requestIdleCallback
  if (typeof ric === 'function') ric(run, { timeout: 3_000 })
  else window.setTimeout(run, 1_200)
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
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; maintenance?: unknown }
    if (data.maintenance === true && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('tgfeed:maintenance'))
    }
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
