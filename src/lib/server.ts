import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { APP_VERSION } from '@/lib/version'

export { APP_VERSION }

/**
 * v5.54: сравнение секретов в постоянном времени (webhook-секреты, админ-ключи).
 * Пустые/разной длины строки — сразу false (без утечки по длине ответа — длина
 * сравнивается как часть константы).
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length > 0 && ba.length === bb.length && timingSafeEqual(ba, bb)
}

/**
 * Провайдер БД: локальная песочница работает на SQLite (DATABASE_URL=file:…),
 * прод — Postgres/Supabase. Синтаксис сырых запросов и некоторые фильтры
 * (mode:'insensitive') различаются — ветки по этому флагу.
 */
export const IS_SQLITE = (process.env.DATABASE_URL ?? '').startsWith('file:')

/**
 * Регистронезависимый contains для поиска по панели (v6.3.1).
 * Прод (Postgres): mode:'insensitive' — иначе «Durov» не находится по «durov»,
 * и владелец не может выдать ничего юзеру («пользователь не найден»).
 * Песочница (SQLite): plain contains — LIKE в SQLite и так нечувствителен к
 * регистру ASCII, а mode:'insensitive' SQLite-коннектором не поддерживается.
 */
export function ciContains(value: string): { contains: string; mode?: 'insensitive' } {
  return IS_SQLITE ? { contains: value } : { contains: value, mode: 'insensitive' }
}

export function err(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

export function unauthorized() {
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
}

/**
 * Внешний origin запроса на серверной платформе (Vercel и т.п.).
 * request.url может быть внутренним (localhost/internal host) — берём
 * x-forwarded-host/proto, которые прокси проставляет надёжно.
 */
export function externalOrigin(request: Request): string {
  const host =
    request.headers.get('x-forwarded-host') ??
    request.headers.get('host') ??
    (() => {
      try {
        return new URL(request.url).host
      } catch {
        return ''
      }
    })()
  const proto =
    request.headers.get('x-forwarded-proto') ??
    (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https')
  return `${proto}://${host}`
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

/**
 * Кап размера JSON-тела по умолчанию (байт/символов ASCII) — защита от
 * memory-абуза: заявленный content-length проверяется ДО чтения тела.
 * Роуты с крупными телами (например /api/upload с base64-картинкой) передают
 * свой кап вторым аргументом: readJson(request, { maxBytes: 600_000 }).
 */
const READ_JSON_DEFAULT_MAX_BYTES = 64_000

export type ReadJsonOpts = { maxBytes?: number }

/**
 * Парсит JSON-тело; при любой ошибке/превышении капа возвращает {} (НЕ бросает:
 * часть вызовов вне try/catch, см. /api/translate/stream). Кап по content-length
 * отсекает крупное тело до чтения — дешёвый ранний отказ.
 */
export async function readJson<T = Record<string, unknown>>(
  request: Request,
  opts?: ReadJsonOpts,
): Promise<T> {
  const maxBytes = Math.max(1, Math.floor(opts?.maxBytes ?? READ_JSON_DEFAULT_MAX_BYTES))
  try {
    // Предварительный кап: заголовок отсутствует/кривой → Number('')=0, пропускаем
    const declared = Number(request.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > maxBytes) return {} as T
    const text = await request.text()
    if (text.length > maxBytes) return {} as T
    return JSON.parse(text) as T
  } catch {
    return {} as T
  }
}
