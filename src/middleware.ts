import { NextResponse, type NextRequest } from 'next/server'
import { Redis } from '@upstash/redis'

/**
 * Глобальный rate limiter (уровень 1) на Upstash Redis — единый лимит
 * на все инстансы/функции. In-memory лимиты в guard.ts остаются вторым
 * слоем (defense in depth) и работают, когда Redis недоступен.
 *
 * Лимитируются только чувствительные к абузу эндпоинты (auth, avatar,
 * parse, search, admin-login) — чтобы не тратить команды Redis на
 * кэшируемые горячие пути (feed/trending/categories).
 *
 * Окно фиксированное (60с), ключ: rl:{endpoint}:{ip}:{bucket}.
 * Redis недоступен → запрос пропускается (деградация, не отказ).
 */

const url = process.env.UPSTASH_REDIS_REST_URL?.trim() ?? ''
const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim() ?? ''
const redis = url && token ? new Redis({ url, token }) : null

const WINDOW_SEC = 60

// путь → лимит запросов в минуту с одного IP
const LIMITS: Array<{ prefix: string; limit: number }> = [
  { prefix: '/api/auth', limit: 20 },
  { prefix: '/api/panel/login', limit: 10 },
  { prefix: '/api/parse', limit: 20 },
  { prefix: '/api/avatar', limit: 90 },
  { prefix: '/api/search', limit: 60 },
  { prefix: '/api/hashtag', limit: 60 },
]

export const config = {
  matcher: [
    '/api/auth/:path*',
    '/api/panel/login',
    '/api/parse',
    '/api/parse/:path*',
    '/api/avatar/:path*',
    '/api/search',
    '/api/hashtag/:path*',
  ],
}

export async function middleware(request: NextRequest) {
  // CORS preflight не считаем
  if (request.method === 'OPTIONS' || !redis) return NextResponse.next()

  const path = request.nextUrl.pathname
  const rule = LIMITS.find((r) => path === r.prefix || path.startsWith(`${r.prefix}/`))
  if (!rule) return NextResponse.next()

  const fwd = request.headers.get('x-forwarded-for')
  const ip = (fwd ? fwd.split(',')[0].trim() : request.headers.get('x-real-ip')) || 'local'
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
    // Redis недоступен — пропускаем (второй слой в guard.ts)
  }
  return NextResponse.next()
}
