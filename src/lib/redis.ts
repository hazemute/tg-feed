import { Redis } from '@upstash/redis'

/**
 * Redis-слой (Upstash REST): L2-кэш поверх PostgreSQL для горячих чтений,
 * глобальные счётчики версий для инвалидации, health-check.
 *
 * Архитектура кэша (cache-aside, две ступени):
 *   L1 — память процесса (секунды, нулевая цена, защищает от повторных
 *        запросов в рамках инстанса);
 *   L2 — Upstash Redis (общий для всех инстансов/функций Vercel).
 *
 * Правила безопасности:
 *  - Redis НЕ доступен → все операции тихо деградируют (мимо кэша),
 *    приложение продолжает работать на одной БД;
 *  - в кэше только JSON-безопасные данные (DTO, списки id);
 *  - персонализация (лайки/закладки/подписки) НЕ кэшируется — глобальная
 *    часть кэшируется с нейтральными флагами, флаги пользователя
 *    накладываются после (см. /api/trending, /api/channels, /api/search).
 */

const url = process.env.UPSTASH_REDIS_REST_URL?.trim() ?? ''
const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim() ?? ''

/** Единый клиент (null — Redis не настроен, все вызовы no-op) */
export const redis: Redis | null = url && token ? new Redis({ url, token }) : null

export function redisEnabled(): boolean {
  return redis !== null
}

/** Жёсткий таймаут на команду — REST-задержка не должна бить по p99 API */
const CMD_TIMEOUT_MS = 1200

async function withTimeout<T>(op: Promise<T>, fallback: T): Promise<T> {
  try {
    return await Promise.race([
      op,
      new Promise<T>((resolve) => setTimeout(() => resolve(fallback), CMD_TIMEOUT_MS)),
    ])
  } catch {
    return fallback
  }
}

// ------------------------- Базовые операции -------------------------

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!redis) return null
  return withTimeout(redis.get<T>(key) as Promise<T>, null as T)
}

export async function cacheSet(key: string, value: unknown, ttlSec: number): Promise<void> {
  if (!redis) return
  await withTimeout(redis.set(key, value, { ex: ttlSec }), undefined as never)
}

export async function cacheDel(...keys: string[]): Promise<void> {
  if (!redis || keys.length === 0) return
  await withTimeout(redis.del(...keys), undefined as never)
}

/** Счётчик с окном (rate limit в middleware): возвращает текущее значение */
export async function cacheIncr(key: string): Promise<number> {
  if (!redis) return 0
  return withTimeout(redis.incr(key), 0)
}

export async function cacheExpire(key: string, ttlSec: number): Promise<void> {
  if (!redis) return
  await withTimeout(redis.expire(key, ttlSec), undefined as never)
}

// ------------------------- cache-aside с L1 -------------------------

type L1Entry = { v: unknown; exp: number }
const l1 = new Map<string, L1Entry>()
const L1_MAX_ENTRIES = 300

function l1Get<T>(key: string): T | null {
  const e = l1.get(key)
  if (!e) return null
  if (e.exp <= Date.now()) {
    l1.delete(key)
    return null
  }
  return e.v as T
}

function l1Set(key: string, v: unknown, ttlMs: number): void {
  if (l1.size >= L1_MAX_ENTRIES) {
    // простая чистка: удаляем первые протухшие, иначе — самые старые
    const now = Date.now()
    let removed = 0
    for (const [k, e] of l1) {
      if (e.exp <= now) {
        l1.delete(k)
        removed++
        if (removed >= L1_MAX_ENTRIES / 10) break
      }
    }
    if (l1.size >= L1_MAX_ENTRIES) {
      const first = l1.keys().next().value
      if (first !== undefined) l1.delete(first)
    }
  }
  l1.set(key, { v, exp: Date.now() + ttlMs })
}

/**
 * Cache-aside: L1 память → L2 Redis → fetcher.
 * Требование: значение fetcher должно быть JSON-сериализуемым.
 */
export async function cacheAside<T>(opts: {
  key: string
  ttlSec: number
  /** TTL L1; по умолчанию min(ttlSec*1000, 5000) */
  memoryTtlMs?: number
  fetcher: () => Promise<T>
}): Promise<T> {
  const memTtl = opts.memoryTtlMs ?? Math.min(opts.ttlSec * 1000, 5000)

  const local = l1Get<T>(opts.key)
  if (local !== null) return local

  const remote = await cacheGet<T>(opts.key)
  if (remote !== null) {
    l1Set(opts.key, remote, memTtl)
    return remote
  }

  const fresh = await opts.fetcher()
  l1Set(opts.key, fresh, memTtl)
  await cacheSet(opts.key, fresh, opts.ttlSec)
  return fresh
}

// ---------------- Версии семейств (инвалидация, O(1)) ----------------

/**
 * Инвалидация через версии: ключ кэша содержит номер версии семейства.
 * bumpCache инкрементирует счётчик — старые ключи становятся недостижимыми
 * и истекают по TTL.
 *
 * ЭКОНОМИЯ КОМАНД (Upstash тарифицирует каждую команду):
 * версия кэшируется в памяти процесса на VERSION_TTL_MS — Redis-GET версии
 * делается не на каждый запрос, а раз в 30с на семейство. bump обновляет
 * локальную копию мгновенно (свой инстанс видит инвалидацию сразу,
 * соседние — максимум через 30с, что сопоставимо с самими TTL).
 */
export const CACHE_FAMILIES = ['feed', 'tr', 'ch', 'ct', 'sr'] as const
export type CacheFamily = (typeof CACHE_FAMILIES)[number]

const VERSION_TTL_MS = 30_000
const memVersions = new Map<CacheFamily, { v: number; exp: number }>()

async function familyVersionUncached(f: CacheFamily): Promise<number> {
  if (redis) {
    const v = await withTimeout(redis.get<number>(`ver:${f}`), null)
    if (typeof v === 'number') return v
  }
  return 0
}

export async function familyVersion(f: CacheFamily): Promise<number> {
  const cached = memVersions.get(f)
  if (cached && cached.exp > Date.now()) return cached.v
  const v = await familyVersionUncached(f)
  memVersions.set(f, { v, exp: Date.now() + VERSION_TTL_MS })
  return v
}

export async function bumpCache(families: CacheFamily[]): Promise<void> {
  for (const f of families) {
    if (redis) await withTimeout(redis.incr(`ver:${f}`), undefined as never)
    // локальная копия — сразу актуальная (без GET)
    const cur = memVersions.get(f)
    const v = cur && cur.exp > Date.now() ? cur.v + 1 : 0 // 0 = «неизвестно», перекэшируем из Redis при следующем чтении
    memVersions.set(f, { v, exp: Date.now() + VERSION_TTL_MS })
  }
}

/** Скомпонованный ключ семейства: `fd:v3:all` */
export async function famKey(f: CacheFamily, suffix: string): Promise<string> {
  const v = await familyVersion(f)
  return `${f}:v${v}:${suffix}`
}

// ------------------------- Health -------------------------

/** Результат health-проверки кэшируется в памяти — не чаще раза в 60с */
let healthCache: { v: 'upstash' | 'memory-only' | 'down'; exp: number } | null = null

/** Проверка Redis для /api/health (не бросает исключений, экономит команды) */
export async function redisHealth(): Promise<'upstash' | 'memory-only' | 'down'> {
  if (!redis) return 'memory-only'
  if (healthCache && healthCache.exp > Date.now()) return healthCache.v
  try {
    await redis.set('health:ping', Date.now(), { ex: 120 })
    healthCache = { v: 'upstash', exp: Date.now() + 60_000 }
    return 'upstash'
  } catch {
    healthCache = { v: 'down', exp: Date.now() + 60_000 }
    return 'down'
  }
}

/** Короткий sha1-хэш для ключей (скрытые каналы/интересы/запросы) */
export function shortHash(input: string): string {
  // лёгкий FNV-1a 32bit → hex (достаточно для ключей кэша, без крипто-целей)
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}
