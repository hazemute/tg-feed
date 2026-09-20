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

/* ====================== ETAG / 304 (v5.35, персистентность v5.49) ====================== */

/**
 * Прозрачный ETag-кэш GET-запросов: обёртка помнит последний ответ и его
 * ETag на каждый путь, шлёт If-None-Match и на 304 подставляет сохранённое
 * тело — НИ ОДИН вызывающий код не меняется. Поллинг ленты (раз в 45с) и
 * повторы перестают качать один и тот же JSON — минус десятки МБ трафика
 * на пользователя в сутки.
 *
 * ПЕРСИСТЕНТНОСТЬ (v5.49 — «миллисекундная загрузка»): кэш ПЕРЕЖИВАЕТ
 * перезапуск миниаппа — записи хранятся в localStorage. При следующем
 * заходе первый же запрос уходит с If-None-Match прошлой сессии: данные
 * НЕ изменились → пустой 304 (~100 байт), экран рисуется из локальной
 * копии мгновенно; изменились → полный 200 и обновление кэша. Сервер
 * нагружается только валидацией, крупные данные ходят по сети один раз,
 * пока не изменятся.
 */
type EtagEntry = { etag: string; body: unknown }
const ETAG_CACHE = new Map<string, EtagEntry>()
const ETAG_MAX = 40

/** Границы персистентного слоя: мелкие ответы, конечное число, TTL сутки */
const ETAG_LS_KEY = 'tgfeed_etag_v1'
const ETAG_PERSIST_MAX = 30 // записей
const ETAG_PERSIST_MAX_BYTES = 80_000 // одна запись крупнее — не храним (страницы ленты)
const ETAG_PERSIST_TOTAL_BYTES = 800_000 // общий бюджет ~0.8МБ из ~5МБ localStorage
const ETAG_PERSIST_TTL_MS = 24 * 3_600_000

function etagRemember(path: string, etag: string, body: unknown): void {
  if (ETAG_CACHE.size >= ETAG_MAX) {
    const first = ETAG_CACHE.keys().next().value
    if (first !== undefined) ETAG_CACHE.delete(first)
  }
  ETAG_CACHE.set(path, { etag, body })
  scheduleEtagPersist()
}

let etagPersistTimer: ReturnType<typeof setTimeout> | null = null

/** Отложенная запись кэша в localStorage (не чаще раза в 1с, одним куском) */
function scheduleEtagPersist(): void {
  if (typeof window === 'undefined' || etagPersistTimer) return
  etagPersistTimer = setTimeout(() => {
    etagPersistTimer = null
    try {
      const now = Date.now()
      const out: Record<string, { etag: string; body: unknown; at: number }> = {}
      let size = 0
      let count = 0
      // свежие записи в конце Map — сохраняем с хвоста, пока не упрёмся в лимиты
      for (const [path, entry] of [...ETAG_CACHE].reverse()) {
        if (count >= ETAG_PERSIST_MAX) break
        const rec = { etag: entry.etag, body: entry.body, at: now }
        const json = JSON.stringify(rec)
        if (json.length > ETAG_PERSIST_MAX_BYTES) continue
        if (size + json.length > ETAG_PERSIST_TOTAL_BYTES) break
        out[path] = rec
        size += json.length
        count++
      }
      localStorage.setItem(ETAG_LS_KEY, JSON.stringify(out))
    } catch {
      // приватный режим/переполнение — кэш просто не переживёт сессию
    }
  }, 1_000)
}

/** Загрузить ETag-кэш прошлой сессии в память (один раз при старте модуля) */
function loadPersistedEtags(): void {
  if (typeof window === 'undefined') return
  try {
    const raw = localStorage.getItem(ETAG_LS_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as Record<string, { etag: string; body: unknown; at: number }>
    const now = Date.now()
    for (const [path, rec] of Object.entries(parsed)) {
      if (!rec || typeof rec.etag !== 'string') continue
      if (now - rec.at > ETAG_PERSIST_TTL_MS) continue // сутки — стухший кэш не валидируем
      if (ETAG_CACHE.size >= ETAG_MAX) break
      ETAG_CACHE.set(path, { etag: rec.etag, body: rec.body })
    }
  } catch {
    try {
      localStorage.removeItem(ETAG_LS_KEY)
    } catch {
      /* не критично */
    }
  }
}
loadPersistedEtags()

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
    try {
      localStorage.removeItem(ETAG_LS_KEY)
    } catch {
      /* не критично */
    }
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
