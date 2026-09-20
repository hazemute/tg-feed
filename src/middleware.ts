import { NextResponse, type NextRequest } from 'next/server'
import { Redis } from '@upstash/redis'
import { bearerToken, verifySessionEdge } from '@/lib/session-edge'

/**
 * Слой Edge-middleware:
 *
 * 0) АНТИСКАН (слой −1): дешёвый RegExp-тест pathname на зонды сканеров
 *    (wp-admin, .php, .git, .env, phpunit, actuator, бэкапы…) → мгновенный
 *    404 без тел. Проверка ДО анти-флуда: мусор не тратит лимиты и не
 *    засоряет flood-Map. 404, а не 403 — не раскрываем существование WAF.
 *
 * 0.5) SECURITY-ЗАГОЛОВКИ на все ответы (harden()): nosniff, Referrer-Policy,
 *    Permissions-Policy, X-DNS-Prefetch-Control. На HTML (не /api) ещё
 *    CSP frame-ancestors с allowlist Telegram (НЕ X-Frame-Options — мини-апп
 *    всегда грузится в iframe web.telegram.org / t.me, его фрейминг ломать
 *    нельзя). HSTS на /api не дублируем (ставит платформа), для HTML тоже
 *    не дублируем — next.config.ts уже ставит глобальный max-age=63072000.
 *
 * 1) Глобальный анти-флуд (in-memory, слой 0): окно 60с, 300 req/мин с IP
 *    на ВСЕ /api/* — ноль команд Redis, ловит дудос-флуд до любых расходов.
 *    POST/PUT/DELETE считаются за 2 запроса (апишные мутации дороже GET —
 *    запись в БД/Redis), GET/HEAD за 1.
 *    Redis-лимиты чувствительных эндпоинтов остаются слоем 1 (единый лимит
 *    на все инстансы), guard.ts — слоем 2 (per-user, в каждом роуте).
 *
 * 2) Режим техработ: при включённом флаге (Redis sys:maintenance, локальный
 *    кэш 15с) все /api/* отвечают 503 {maintenance:true}, КРОМЕ:
 *    /api/auth (клиент узнаёт статус), /api/panel/* (админка),
 *    /api/health (мониторы), /api/bot|payments/webhook (внешние системы)
 *    и публичных медиа-GET /api/avatar|media|emoji — <img> не умеет
 *    Authorization, аватарки/фото не должны отваливаться у допущенных.
 *    Проходят мимо: админы из ADMIN_TG_IDS и UID из белого списка
 *    sys:maint_pass (проверка JWT в Edge + SISMEMBER).
 *    HTML-страницы не блокируются — клиент показывает экран техработ.
 *
 * 3) ДО РЕЛИЗА (v5.42): пока владелец не нажал «Выпустить» в админке
 *    (Redis sys:released='off'), API закрыт так же, но отвечает 503
 *    {prerelease:true} — клиент показывает экран «Приложение ещё
 *    разрабатывается», а НЕ техработы (приказ владельца: техработы включать
 *    нельзя, мы ещё не выпустились).
 *
 * УСТОЙЧИВОСТЬ: у Edge нет доступа к PostgreSQL, поэтому Node-рантайм
 * сам держит зеркало тёплым — lib/maintenance.ts самолечит ключ sys:maintenance
 * из БД при первом же чтении и сверяет Redis с БД heartbeat'ом раз в 30с
 * (флаг и белый список не слетают после флаша/эвикции/перезапуска Redis).
 *
 * Redis недоступен → лимиты пропускаются, флаг техработ считается off.
 */

const url = process.env.UPSTASH_REDIS_REST_URL?.trim() ?? ''
const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim() ?? ''
const redis = url && token ? new Redis({ url, token }) : null

const WINDOW_SEC = 60

// путь → лимит запросов в минуту с одного IP (Redis, единый на инстансы)
// ВАЖНО: более специфичные префиксы — ВЫШЕ (первое совпадение выигрывает)
const LIMITS: Array<{ prefix: string; limit: number }> = [
  { prefix: '/api/auth/link', limit: 60 }, // опрос статуса входа раз в 2.5с
  { prefix: '/api/auth', limit: 20 },
  { prefix: '/api/panel/login', limit: 10 },
  { prefix: '/api/parse', limit: 20 },
  { prefix: '/api/avatar', limit: 90 },
  { prefix: '/api/emoji', limit: 120 },
  { prefix: '/api/search', limit: 60 },
  { prefix: '/api/hashtag', limit: 60 },
  { prefix: '/api/translate', limit: 20 },
  { prefix: '/api/mychannel', limit: 40 },
  { prefix: '/api/campaigns', limit: 40 },
  // Комментарии: публичный GET (120/мин на юзера в guard'е — памяти недостаточно
  // против распределённого спама с ботнета). Redis трогается только после
  // локального порога (36/мин с IP) — обычные пользователи его не видят.
  { prefix: '/api/comments', limit: 60 },
]

/**
 * ЭКОНОМИЯ КОМАНД: локальный предфильтр Redis-лимитов. Пока IP не израсходовал
 * SOFT_FACTOR от лимита НА ЭТОМ ИНСТАНСЕ, Redis не трогаем вообще — типичный
 * пользователь никогда не дойдёт до Redis даже на аватарках (самый массовый путь).
 * После порога — авторитетный Redis-INCR (единый на все инстансы), флуд
 * до этого отсекает слой 0. Цена: при N инстансах до порога пропускаем до
 * N×SOFT_FACTOR — для защитного лимита это несущественно.
 */
const SOFT_FACTOR = 0.6

type SoftEntry = { count: number; windowStart: number }
const soft = new Map<string, SoftEntry>()

function softCountAndIncr(key: string): number {
  const now = Date.now()
  const e = soft.get(key)
  if (!e || now - e.windowStart >= WINDOW_SEC * 1000) {
    soft.set(key, { count: 1, windowStart: now })
    return 0 // предыдущих хитов в этом окне не было
  }
  const prev = e.count
  e.count += 1
  // амортизированная чистка одноразовых IP
  if (soft.size > 3000 && e.count % 2048 === 0) {
    for (const [k, v] of soft) {
      if (now - v.windowStart > WINDOW_SEC * 2000) soft.delete(k)
    }
  }
  return prev
}

// ----------------- Слой 0: in-memory анти-флуд (без Redis) -----------------

const FLOOD_LIMIT = 300 // req/мин с одного IP на инстанс
const FLOOD_BLOCK_MS = 60_000 // повторное окно после срабатывания

type FloodEntry = { count: number; windowStart: number; blockedUntil: number }
const flood = new Map<string, FloodEntry>()

/**
 * weight: GET/HEAD = 1, POST/PUT/DELETE = 2 — мутации дороже (БД/Redis-запись),
 * чтобы апишные POST-атаки упирались в лимит вдвое быстрее. Окно/блок те же.
 */
function floodAllowed(ip: string, weight = 1): boolean {
  const now = Date.now()
  const e = flood.get(ip)
  if (!e) {
    flood.set(ip, { count: weight, windowStart: now, blockedUntil: 0 })
    return true
  }
  if (e.blockedUntil > now) return false
  if (now - e.windowStart >= WINDOW_SEC * 1000) {
    e.count = 0
    e.windowStart = now
  }
  e.count += weight
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
const BANS_SET = 'sys:banned'
const RELEASED_KEY = 'sys:released'
let maintCache: { v: boolean; exp: number } | null = null
const MAINT_MEM_TTL_MS = 15_000
/** Явное 'off' кэшируем дольше: штатный режим = минимум GET-ов на Upstash */
const MAINT_MEM_TTL_OFF_MS = 60_000

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
  maintCache = { v, exp: Date.now() + (v ? MAINT_MEM_TTL_MS : MAINT_MEM_TTL_OFF_MS) }
  return v
}

/**
 * Флаг релиза (v5.42): 'off' = идёт разработка, владелец ещё не нажал «Выпустить».
 * Ключа нет / Redis недоступен → считаем выпущенным (fail-open, как у техработ:
 * доступность важнее строгости — БД-зеркало самолечится в Redis ≤10 мин).
 * Явное 'off' кэшируем коротко — нажатие «Выпустить» подхватится быстро.
 */
let releasedCache: { v: boolean; exp: number } | null = null

async function releasedOn(): Promise<boolean> {
  if (!redis) return true
  if (releasedCache && releasedCache.exp > Date.now()) return releasedCache.v
  let v = true
  try {
    const raw = await redis.get<string | number>(RELEASED_KEY)
    if (raw === 'off' || raw === '0' || raw === 0) v = false
    // 'on' или ключ вымыт — открыто (самолечение из БД не блокируем)
  } catch {
    v = true
  }
  releasedCache = { v, exp: Date.now() + (v ? MAINT_MEM_TTL_OFF_MS : MAINT_MEM_TTL_MS) }
  return v
}

/**
 * ЭКОНОМИЯ КОМАНД: белый список кэшируется SMEMBERS-ом раз в 30с — во время
 * техработ каждый запрос больше не делает SISMEMBER. Задержка отзыва допуска
 * ≤ 30с (для защитного режима это несущественно).
 */
let passCache: { set: Set<string>; exp: number } | null = null
const PASS_MEM_TTL_MS = 30_000

/** Зеркало банов (SMEMBERS sys:banned раз в 60с — экономия команд) */
let bansCache: { set: Set<string>; exp: number } | null = null
const BANS_MEM_TTL_MS = 60_000

async function isBannedEdge(uid: string): Promise<boolean> {
  if (!redis) return false
  const now = Date.now()
  if (!bansCache || bansCache.exp <= now) {
    try {
      const members = await redis.smembers<string[]>(BANS_SET)
      bansCache = {
        set: new Set(Array.isArray(members) ? members : []),
        exp: now + BANS_MEM_TTL_MS,
      }
    } catch {
      return false // Redis недоступен — не блокируем (БД-зеркало восстановится)
    }
  }
  return bansCache.set.has(uid)
}

async function maintenanceAllowed(uid: string): Promise<boolean> {
  if (!redis) return false
  const now = Date.now()
  if (!passCache || passCache.exp <= now) {
    try {
      const members = await redis.smembers<string[]>(MAINT_PASS_SET)
      passCache = {
        set: new Set(Array.isArray(members) ? members : []),
        exp: now + PASS_MEM_TTL_MS,
      }
    } catch {
      return false // Redis недоступен при техработах — не пропускаем
    }
  }
  return passCache.set.has(uid)
}

function adminUids(): string[] {
  return (process.env.ADMIN_TG_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith('tg_') ? s : `tg_${s}`))
}

/** Пути, которые не трогаем анти-флудом (внешние системы и мониторинг) */
function floodExempt(path: string): boolean {
  return (
    path.startsWith('/api/auth') ||
    path.startsWith('/api/panel') ||
    path.startsWith('/api/health') ||
    path.startsWith('/admin') ||
    // вебхуки — внешние системы: вход через бота и оплата не должны ломаться
    path.startsWith('/api/bot/webhook') ||
    path.startsWith('/api/payments/webhook')
  )
}

/**
 * Пути, которые работают даже при техработах.
 *
 * + ПУБЛИЧНЫЕ МЕДИА-GET (avatar/media/emoji): <img>/<video> не умеют
 * Authorization — иначе у допущенных пользователей при техработах отваливались
 * ВСЕ аватарки и фото постов (503 на каждый запрос картинок, владелец видел
 * серые инициалы вместо аватара и «вечный» shimmer вместо фото). Контент этих
 * эндпоинтов — публичные картинки Telegram (те же t.me), тексты постов
 * остаются закрыты; у каждого роута свой лимит (guardIp).
 */
function maintenanceExempt(path: string): boolean {
  return (
    floodExempt(path) ||
    path.startsWith('/api/avatar') ||
    path.startsWith('/api/media') ||
    path.startsWith('/api/emoji') ||
    // Stories-картинка поста: её скачивает Telegram-клиент при публикации
    // сторис (п.4 запроса владельца) — тоже публичное медиа-GET
    path.startsWith('/api/story') ||
    // чатовые картинки поддержки/предложки (<img> без Bearer)
    path.startsWith('/api/upload')
  )
}

// ----------------- Слой −1: анти-скан (зонды сканеров/ботов) -----------------

/**
 * Один компиля RegExp на модуль, один .test(pathname) на запрос — копеечно.
 * Список — классические зонды (WordPress/PHP-стек, VCS/секреты, Java/CGI-консоли,
 * бэкапы и дампы БД). Легитимных путей приложения с такими подстроками нет
 * (проверено по src/app/**). /.well-known/security.txt сознательно НЕ блокируем.
 * Расширения .zip/.sql/.bak — в public/ таких файлов нет, а статика Next
 * живёт в /_next/static (исключена из matcher'а).
 */
const SCANNER_PROBE = new RegExp(
  [
    // WordPress / PHP-стек
    'wp-admin', 'wp-login', 'wp-content', 'wp-includes', 'phpmyadmin', '\\.php$', 'xmlrpc',
    // VCS, секреты, конфиги
    '/\\.git', '/\\.env$', '/\\.aws', 'vendor/phpunit', 'config\\.json$',
    // Java/CGI-консоли и админки сервисов
    '/cgi-bin/', '\\.aspx$', '\\.jsp$', '\\.cgi$', '/actuator', 'jmx-console', '/solr',
    'admin/config\\.php',
    // бэкапы и дампы
    '/backup', '\\.sql$', '\\.bak$', '\\.zip$',
  ].join('|'),
  'i',
)

// ----------------- Security-заголовки на ВСЕ ответы -----------------

/** База: на каждый ответ middleware (и 4xx, и next()) */
const BASE_SECURITY_HEADERS: Array<[string, string]> = [
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  ['Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()'],
  ['X-DNS-Prefetch-Control', 'off'],
]

/**
 * Только для не-/api (HTML/статика): фреймить нас разрешено СТРОГО доменам
 * Telegram — страница мини-аппа всегда живёт в их iframe. X-Frame-Options
 * принципиально НЕ ставим (DENY/SAMEORIGIN сломал бы мини-апп), CSP
 * frame-ancestors достаточно и гибче. HSTS не дублируем: next.config.ts
 * уже ставит Strict-Transport-Security глобально (max-age=63072000).
 */
const HTML_SECURITY_HEADERS: Array<[string, string]> = [
  [
    'Content-Security-Policy',
    "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org https://telegram.org https://*.t.me",
  ],
]

function harden(res: NextResponse, html: boolean): NextResponse {
  for (const [k, v] of BASE_SECURITY_HEADERS) res.headers.set(k, v)
  if (html) for (const [k, v] of HTML_SECURITY_HEADERS) res.headers.set(k, v)
  return res
}

export const config = {
  // 1) весь /api/* — старая логика (флуд/бан/техработы);
  // 2) всё остальное, КРОМЕ служебной статики Next и тяжёлой картинки
  //    welcome (негативный lookahead — официальный синтаксис matcher'а):
  //    ловим сканер-зонды и расставляем security-заголовки на страницах.
  matcher: [
    '/api/:path*',
    '/((?!_next/static|_next/image|favicon.ico|tgswipe-welcome.png).*)',
  ],
}

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname
  const isApi = path === '/api' || path.startsWith('/api/')

  // CORS-preflight не считаем ничем — но заголовки всё равно ставим
  if (request.method === 'OPTIONS') return harden(NextResponse.next(), !isApi)

  // --- Слой −1: сканер-зонды → мгновенный 404 (ДО флуд-счётчиков:
  //     мусор не тратит лимиты и не попадает в flood-Map) ---
  if (SCANNER_PROBE.test(path)) {
    return harden(new NextResponse(null, { status: 404 }), !isApi)
  }

  // --- Не-/api (страницы, public-статика): только заголовки, дальше не идём —
  //     флуд/бан/техработы остаются логикой API ---
  if (!isApi) {
    return harden(NextResponse.next(), true)
  }

  const ip = clientIp(request)

  // --- Слой 0: анти-флуд на все /api/* (только не админ-панель из локальной сети).
  //     POST/PUT/DELETE — вес 2 (мутации дороже), GET/HEAD — 1. ---
  const floodWeight =
    request.method === 'POST' || request.method === 'PUT' || request.method === 'DELETE' ? 2 : 1
  if (!floodExempt(path) && !floodAllowed(ip, floodWeight)) {
    return harden(
      NextResponse.json(
        { error: 'too many requests' },
        { status: 429, headers: { 'Retry-After': String(WINDOW_SEC) } },
      ),
      false,
    )
  }

  // --- Слой 1: Redis-лимиты чувствительных эндпоинтов (единый на инстансы) ---
  // Локальный предфильтр: до SOFT_FACTOR лимита Redis не тратится.
  const rule = LIMITS.find((r) => path === r.prefix || path.startsWith(`${r.prefix}/`))
  if (redis && rule) {
    const bucket = Math.floor(Date.now() / 1000 / WINDOW_SEC)
    const softKey = `${rule.prefix}:${ip}:${bucket}`
    const softLimit = Math.floor(rule.limit * SOFT_FACTOR)
    const prevHits = softCountAndIncr(softKey)
    if (prevHits >= softLimit) {
      // порог локального счётчика пройден — дальше проверяем в Redis (авторитетно)
      try {
        const key = `rl:${rule.prefix}:${ip}:${bucket}`
        const hits = await redis.incr(key)
        if (hits === 1) await redis.expire(key, WINDOW_SEC + 5)
        if (hits > rule.limit) {
          return harden(
            NextResponse.json(
              { error: 'too many requests' },
              { status: 429, headers: { 'Retry-After': String(WINDOW_SEC) } },
            ),
            false,
          )
        }
      } catch {
        // Redis недоступен — пропускаем (слои 0 и 2 продолжают работать)
      }
    }
  }

  // --- Бан (v5.11): забаненный получает 403 на всём API, кроме статуса/админки/мониторов.
  //      /api/auth оставлен свободным — клиент должен узнать о бане и показать экран. ---
  if (
    redis &&
    !path.startsWith('/api/auth') &&
    !path.startsWith('/api/panel') &&
    !path.startsWith('/api/health') &&
    !path.startsWith('/api/bot/webhook') &&
    !path.startsWith('/api/payments/webhook')
  ) {
    const bearer = bearerToken(request)
    if (bearer) {
      try {
        const session = await verifySessionEdge(bearer)
        if (session && (await isBannedEdge(session.uid))) {
          return harden(
            NextResponse.json({ error: 'banned', banned: true }, { status: 403 }),
            false,
          )
        }
      } catch {
        // сессия невалидна — дальше штатные проверки роутов
      }
    }
  }

  // --- Техработы: блокируем API для всех, кроме админов/допуска ---
  if (redis && !maintenanceExempt(path) && (await maintenanceOn())) {
    const session = await verifySessionEdge(bearerToken(request))
    let allowed = session !== null && adminUids().includes(session.uid)
    if (!allowed && session) {
      allowed = await maintenanceAllowed(session.uid)
    }
    if (!allowed) {
      return harden(
        NextResponse.json(
          { error: 'maintenance', maintenance: true },
          { status: 503, headers: { 'Retry-After': '120' } },
        ),
        false,
      )
    }
  }

  // --- До релиза (v5.42): владелец ещё не нажал «Выпустить» → API закрыт для
  //     всех, кроме админов и допуска. Клиент показывает экран «Приложение ещё
  //     разрабатывается — оповестим, когда будет релиз» (НЕ техработы).
  //     /api/auth остаётся свободным — клиент должен узнавать статус. ---
  if (redis && !maintenanceExempt(path) && !(await releasedOn())) {
    const session = await verifySessionEdge(bearerToken(request))
    let allowed = session !== null && adminUids().includes(session.uid)
    if (!allowed && session) {
      allowed = await maintenanceAllowed(session.uid)
    }
    if (!allowed) {
      return harden(
        NextResponse.json(
          { error: 'prerelease', prerelease: true },
          { status: 503, headers: { 'Retry-After': '120' } },
        ),
        false,
      )
    }
  }

  return harden(NextResponse.next(), false)
}
