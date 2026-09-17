import { NextResponse, type NextRequest } from 'next/server'
import { Redis } from '@upstash/redis'
import { bearerToken, verifySessionEdge } from '@/lib/session-edge'

/**
 * Слой Edge-middleware:
 *
 * 1) Глобальный анти-флуд (in-memory, слой 0): окно 60с, 300 req/мин с IP
 *    на ВСЕ /api/* — ноль команд Redis, ловит дудос-флуд до любых расходов.
 *    Redis-лимиты чувствительных эндпоинтов остаются слоем 1 (единый лимит
 *    на все инстансы), guard.ts — слоем 2 (per-user, в каждом роуте).
 *
 * 2) Режим техработ: при включённом флаге (Redis sys:maintenance, локальный
 *    кэш 15с) все /api/* отвечают 503 {maintenance:true}, КРОМЕ:
 *    /api/auth (клиент узнаёт статус), /api/panel/* (админка),
 *    /api/health (мониторы). Проходят мимо: админы из ADMIN_TG_IDS и
 *    UID из белого списка sys:maint_pass (проверка JWT в Edge + SISMEMBER).
 *    HTML-страницы не блокируются — клиент показывает экран техработ.
 *
 * Redis недоступен → лимиты пропускаются, флаг техработ считается off.
 */

const url = process.env.UPSTASH_REDIS_REST_URL?.trim() ?? ''
const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim() ?? ''
const redis = url && token ? new Redis({ url, token }) : null

const WINDOW_SEC = 60

// путь → лимит запросов в минуту с одного IP (Redis, единый на инстансы)
const LIMITS: Array<{ prefix: string; limit: number }> = [
  { prefix: '/api/auth', limit: 20 },
  { prefix: '/api/panel/login', limit: 10 },
  { prefix: '/api/parse', limit: 20 },
  { prefix: '/api/avatar', limit: 90 },
  { prefix: '/api/search', limit: 60 },
  { prefix: '/api/hashtag', limit: 60 },
]

// ----------------- Слой 0: in-memory анти-флуд (без Redis) -----------------

const FLOOD_LIMIT = 300 // req/мин с одного IP на инстанс
const FLOOD_BLOCK_MS = 60_000 // повторное окно после срабатывания

type FloodEntry = { count: number; windowStart: number; blockedUntil: number }
const flood = new Map<string, FloodEntry>()

function floodAllowed(ip: string): boolean {
  const now = Date.now()
  const e = flood.get(ip)
  if (!e) {
    flood.set(ip, { count: 1, windowStart: now, blockedUntil: 0 })
    return true
  }
  if (e.blockedUntil > now) return false
  if (now - e.windowStart >= WINDOW_SEC * 1000) {
    e.count = 0
    e.windowStart = now
  }
  e.count += 1
  if (e.count > FLOOD_LIMIT) {
    e.blockedUntil = now + FLOOD_BLOCK_MS
    return false
  }
  // чистка карты от одноразовых IP (каждые ~4096 запросов)
  if (flood.size > 5000 && e.count % 4096 === 0) {
    for (const [k, v] of flood) {
      if (v.blockedUntil < now && now - v.windowStart > WINDOW_SEC * 2000) flood.delete(k)
    }
  }
  return true
}

function clientIp(request: NextRequest): string {
  const fwd = request.headers.get('x-forwarded-for')
  return (fwd ? fwd.split(',')[0].trim() : request.headers.get('x-real-ip')) || 'local'
}

// ----------------- Техработы: флаг с локальным кэшем -----------------

const MAINT_KEY = 'sys:maintenance'
const MAINT_PASS_SET = 'sys:maint_pass'
let maintCache: { v: boolean; exp: number } | null = null
const MAINT_MEM_TTL_MS = 15_000

async function maintenanceOn(): Promise<boolean> {
  if (!redis) return false
  if (maintCache && maintCache.exp > Date.now()) return maintCache.v
  let v = false
  try {
    // Upstash REST может отдать и строку, и число — учитываем оба варианта
    const raw = await redis.get<string | number>(MAINT_KEY)
    v = raw === 'on' || raw === '1' || raw === 1
  } catch {
    v = false
  }
  maintCache = { v, exp: Date.now() + MAINT_MEM_TTL_MS }
  return v
}

function adminUids(): string[] {
  return (process.env.ADMIN_TG_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith('tg_') ? s : `tg_${s}`))
}

/** Пути, которые работают даже при техработах */
function maintenanceExempt(path: string): boolean {
  return (
    path.startsWith('/api/auth') ||
    path.startsWith('/api/panel') ||
    path.startsWith('/api/health') ||
    path.startsWith('/admin')
  )
}

export const config = {
  matcher: ['/api/:path*'],
}

export async function middleware(request: NextRequest) {
  if (request.method === 'OPTIONS') return NextResponse.next()

  const path = request.nextUrl.pathname
  const ip = clientIp(request)

  // --- Слой 0: анти-флуд на все /api/* (только не админ-панель из локальной сети) ---
  if (!maintenanceExempt(path) && !floodAllowed(ip)) {
    return NextResponse.json(
      { error: 'too many requests' },
      { status: 429, headers: { 'Retry-After': String(WINDOW_SEC) } },
    )
  }

  // --- Слой 1: Redis-лимиты чувствительных эндпоинтов (единый на инстансы) ---
  const rule = LIMITS.find((r) => path === r.prefix || path.startsWith(`${r.prefix}/`))
  if (redis && rule) {
    const bucket = Math.floor(Date.now() / 1000 / WINDOW_SEC)
    const key = `rl:${rule.prefix}:${ip}:${bucket}`
    try {
      const hits = await redis.incr(key)
      if (hits === 1) await redis.expire(key, WINDOW_SEC + 5)
      if (hits > rule.limit) {
        return NextResponse.json(
          { error: 'too many requests' },
          { status: 429, headers: { 'Retry-After': String(WINDOW_SEC) } },
        )
      }
    } catch {
      // Redis недоступен — пропускаем (слои 0 и 2 продолжают работать)
    }
  }

  // --- Техработы: блокируем API для всех, кроме админов/допуска ---
  if (redis && !maintenanceExempt(path) && (await maintenanceOn())) {
    const session = await verifySessionEdge(bearerToken(request))
    let allowed = session !== null && adminUids().includes(session.uid)
    if (!allowed && session) {
      try {
        const r = await redis.sismember(MAINT_PASS_SET, session.uid)
        allowed = r === 1
      } catch {
        allowed = false
      }
    }
    if (!allowed) {
      return NextResponse.json(
        { error: 'maintenance', maintenance: true },
        { status: 503, headers: { 'Retry-After': '120' } },
      )
    }
  }

  return NextResponse.next()
}
