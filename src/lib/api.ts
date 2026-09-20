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

/* ====================== ETAG / 304 (v5.35) ====================== */

/**
 * Прозрачный ETag-кэш GET-запросов: обёртка помнит последний ответ и его
 * ETag на каждый путь, шлёт If-None-Match и на 304 подставляет сохранённое
 * тело — НИ ОДИН вызывающий код не меняется. Поллинг ленты (раз в 45с) и
 * повторы перестают качать один и тот же JSON — минус десятки МБ трафика
 * на пользователя в сутки.
 */
type EtagEntry = { etag: string; body: unknown }
const ETAG_CACHE = new Map<string, EtagEntry>()
const ETAG_MAX = 20

function etagRemember(path: string, etag: string, body: unknown): void {
  if (ETAG_CACHE.size >= ETAG_MAX) {
    const first = ETAG_CACHE.keys().next().value
    if (first !== undefined) ETAG_CACHE.delete(first)
  }
  ETAG_CACHE.set(path, { etag, body })
}

function isEtaggable(init?: RequestInit): boolean {
  const method = (init?.method ?? 'GET').toUpperCase()
  if (method !== 'GET') return false
  // У запросов с кастомным body/сигналом отмены не рискуем: ETag нужен
  // только фоновым GET (поллинг, apiCached-префетчи)
  return !init?.body
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getSessionToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  }
  if (token) headers.Authorization = `Bearer ${token}`

  const etaggable = isEtaggable(init)
  const known = etaggable ? ETAG_CACHE.get(path) : undefined
  if (known) headers['If-None-Match'] = known.etag

  const res = await fetch(path, {
    cache: 'no-store',
    ...init,
    headers,
    // Запрос не может висеть вечно: без таймаута упавший (зависший) запрос
    // оставлял спиннер «загрузки постов» навсегда — главный источник бага
    // «бесконечной загрузки». 20с хватает даже холодному дальнему Supabase.
    signal: init?.signal ?? AbortSignal.timeout(20_000),
  })

  // 304 Not Modified — тело не изменилось: отдаём сохранённый ответ как есть
  if (res.status === 304 && known) return known.body as T

  if (res.status === 401) {
    // Сессия протухла/невалидна — сбрасываем и просим page.tsx пере-авторизоваться
    setSessionToken(null)
    // Кэш мог быть набран под старой сессией — мгновенно забываем всё
    MEMO_CACHE.clear()
    INFLIGHT.clear()
    ETAG_CACHE.clear()
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('tgfeed:unauthorized'))
  }

  if (!res.ok) {
    // Тело читаем ОДИН раз (повторный res.json() бросает «body used already»
    // и терял поле error — тост показывал безликое «HTTP 503»)
    const data = (await res.json().catch(() => ({}))) as {
      error?: string
      maintenance?: unknown
      prerelease?: unknown
    }
    // Режим техработ: middleware режет API с {maintenance:true} — весь app на экран техработ
    if (data.maintenance === true && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('tgfeed:maintenance'))
    }
    // До релиза: экран «Приложение ещё разрабатывается» (НЕ техработы, приказ владельца)
    if (data.prerelease === true && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('tgfeed:prerelease'))
    }
    throw new Error(data.error || `HTTP ${res.status}`)
  }

  const body = (await res.json()) as T
  const etag = etaggable ? res.headers.get('etag') : null
  if (etag) etagRemember(path, etag, body)
  return body
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
    const data = (await res.json().catch(() => ({}))) as {
      error?: string
      maintenance?: unknown
      prerelease?: unknown
    }
    if (data.maintenance === true && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('tgfeed:maintenance'))
    }
    if (data.prerelease === true && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('tgfeed:prerelease'))
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
