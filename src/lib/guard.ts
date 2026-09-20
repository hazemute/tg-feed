import crypto from 'node:crypto'
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { unauthorized, tooMany, IS_SQLITE } from '@/lib/server'

/**
 * Единая точка входа авторизации + rate limiting для API-роутов.
 * Идентификатор пользователя берётся ТОЛЬКО из подписанной сессии (Bearer),
 * значения из query/body игнорируются — подмена личности невозможна.
 */

export type Authed = { ok: true; uid: string; guest: boolean }
export type Rejected = { ok: false; res: NextResponse }
export type GuardResult = Authed | Rejected

type RL = { limit: number; windowMs: number; bucket?: string }

/**
 * Сессия обязательна. Rate limit — на пользователя (по умолчанию 60/мин).
 * Пример: const g = guardAuth(request); if (!g.ok) return g.res;
 */
export function guardAuth(request: Request, rl: RL = { limit: 60, windowMs: 60_000 }): GuardResult {
  const session = getSession(request)
  if (!session) return { ok: false, res: unauthorized() }

  const limited = rateLimit(`u:${session.uid}:${rl.bucket ?? 'default'}`, rl.limit, rl.windowMs)
  if (!limited.ok) return { ok: false, res: tooMany(limited.retryAfterSec) }

  return { ok: true, uid: session.uid, guest: session.guest }
}

/**
 * Сессия необязательна (публичные данные). Если сессия есть — вернём uid
 * для персонализации; rate limit считается по пользователю либо по IP.
 */
export function guardPublic(
  request: Request,
  rl?: RL,
): { ok: true; uid: string | null; guest: boolean } | Rejected {
  const session = getSession(request)
  const key = session ? `u:${session.uid}` : `ip:${clientIp(request)}`
  const limited = rateLimit(`${key}:${rl?.bucket ?? 'public'}`, rl?.limit ?? 120, rl?.windowMs ?? 60_000)
  if (!limited.ok) return { ok: false, res: tooMany(limited.retryAfterSec) }
  return { ok: true, uid: session?.uid ?? null, guest: session?.guest ?? true }
}

/** Анонимный доступ (auth, cron-парсер): rate limit строго по IP */
export function guardIp(request: Request, rl: RL): { ok: true } | Rejected {
  const limited = rateLimit(`ip:${clientIp(request)}:${rl.bucket ?? 'anon'}`, rl.limit, rl.windowMs)
  if (!limited.ok) return { ok: false, res: tooMany(limited.retryAfterSec) }
  return { ok: true }
}

/**
 * Локальная админ-панель (/admin): доступ по статическому ключу ADMIN_KEY.
 * Ключ принимается заголовком x-admin-key ИЛИ Authorization: Bearer <key>.
 * Сравнение в постоянном времени; rate limit по IP.
 * Если ADMIN_KEY не задан — панель закрыта (501), режим «открыто всем» запрещён.
 */
export function guardAdmin(request: Request, rl: RL = { limit: 120, windowMs: 60_000 }): GuardResult {
  const configured = process.env.ADMIN_KEY?.trim() ?? ''
  if (!configured) {
    return {
      ok: false,
      res: NextResponse.json(
        { error: 'ADMIN_KEY is not configured' },
        { status: 501 },
      ),
    }
  }

  const headerKey = (request.headers.get('x-admin-key') ?? '').trim()
  const auth = request.headers.get('authorization') ?? ''
  const bearerKey = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : ''
  // v5.54: ?key= — ТОЛЬКО для EventSource/SSE (/api/panel/events): он не умеет
  // кастомные заголовки. Раньше ключ принимался query-параметром на ВСЕХ
  // панельных роутах и утекал в access-логи/Referer/историю браузера.
  let queryKey = ''
  try {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/panel/events')) {
      queryKey = (url.searchParams.get('key') ?? '').trim()
    }
  } catch {
    // невалидный url — игнорируем
  }
  const provided = headerKey || bearerKey || queryKey

  const a = Buffer.from(provided)
  const b = Buffer.from(configured)
  const valid = a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b)
  if (!valid) return { ok: false, res: unauthorized() }

  const limited = rateLimit(`ip:${clientIp(request)}:${rl.bucket ?? 'admin'}`, rl.limit, rl.windowMs)
  if (!limited.ok) return { ok: false, res: tooMany(limited.retryAfterSec) }

  return { ok: true, uid: 'admin', guest: false }
}

/** Проверка CRON-секрета в постоянном времени */
export function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim()
  if (!secret) {
    // v5.54: в проде секрет ОБЯЗАТЕЛЕН — иначе /api/parse/tick, /api/warm
    // (жгут OpenRouter) и /api/events/emit открыты всем. Песочница (SQLite)
    // и dev — остаются открытыми для локальной разработки.
    if (IS_SQLITE || process.env.NODE_ENV !== 'production') return true
    console.error('[guard] CRON_SECRET не задан в production — cron-роуты закрыты (fail-closed)')
    return false
  }
  const auth = request.headers.get('authorization') ?? ''
  const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : ''
  const header = (request.headers.get('x-cron-secret') ?? '').trim()
  const provided = bearer.length ? bearer : header
  const a = Buffer.from(provided)
  const b = Buffer.from(secret)
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b)
}
