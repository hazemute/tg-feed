import { NextResponse } from 'next/server'
import { APP_VERSION } from '@/lib/version'

export { APP_VERSION }

/**
 * Провайдер БД: локальная песочница работает на SQLite (DATABASE_URL=file:…),
 * прод — Postgres/Supabase. Синтаксис сырых запросов и некоторые фильтры
 * (mode:'insensitive') различаются — ветки по этому флагу.
 */
export const IS_SQLITE = (process.env.DATABASE_URL ?? '').startsWith('file:')

export function err(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

export function unauthorized() {
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
}

export function tooMany(retryAfterSec: number) {
  return NextResponse.json(
    { error: 'too many requests' },
    { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
  )
}

/** Парсинг JSON-массива из строкового поля (SQLite без массивов) */
export function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Нормализация username канала: @name, t.me/name, https://t.me/name/ → name (lowercase) */
export function normalizeChannelUsername(input: string): string {
  let u = input.trim()
  u = u.replace(/^https?:\/\//i, '')
  u = u.replace(/^t\.me\//i, '')
  u = u.replace(/^@/, '')
  u = u.split('/')[0].trim()
  // Telegram-имена регистронезависимы; в БД храним только lowercase
  // (иначе все lowercase-выборки приложения мимо — баг «Канал не найден»)
  return u.toLowerCase()
}

/**
 * Строгая проверка username публичного канала перед использованием в URL.
 * Разрешены только буквы/цифры/подчёркивание (Telegram-правила), 4–64 символа.
 * Защита от SSRF: ничего кроме [A-Za-z0-9_] не попадёт в https://t.me/s/<username>.
 */
export function isValidChannelUsername(username: string): boolean {
  return /^[A-Za-z0-9_]{4,64}$/.test(username)
}

/** Безопасный парсинг JSON-тела запроса (без исключений) */
/** Максимальный размер JSON-тела (байт) — защита от memory-абуза */
const MAX_JSON_BYTES = 1_000_000

export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    const text = await request.text()
    if (text.length > MAX_JSON_BYTES) return {} as T
    return JSON.parse(text) as T
  } catch {
    return {} as T
  }
}
