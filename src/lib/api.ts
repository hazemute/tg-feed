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

  const res = await fetch(path, { cache: 'no-store', ...init, headers })

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
