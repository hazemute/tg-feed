import { Redis } from '@upstash/redis'

/**
 * Redis-слой (Upstash REST): L2-кэш поверх PostgreSQL для горячих чтений,
 * глобальные счётчики версий для инвалидации, health-check.
 *
 * Архитектура кэша (cache-aside, три ступени, МАКСИМАЛЬНАЯ ЭКОНОМИЯ КОМАНД —
 * Upstash тарифицирует каждую команду):
 *   L0 — память процесса, fresh-окно (2–15с): ноль команд;
 *   L1 — та же память в stale-режиме до истечения TTL L2-ключа: ответ
 *        мгновенный, фоновая ревалидация single-flight (один GET на всех);
 *   L2 — Upstash Redis (общий для всех инстансов/функций Vercel): ~1 GET
 *        на ttlSec ключа + 1 GET версии семейства раз в 60с.
 *
 * Правила безопасности:
 *  - Redis НЕ доступен → все операции тихо деградируют (мимо кэша),
 *    приложение продолжает работать на одной БД;
 *  - в кэше только JSON-безопасные данные (DTO, списки id);
 *  - персонализация (лайки/закладки/подписки) НЕ кэшируется — глобальная
 *    часть кэшируется с нейтральными флагами, флаги пользователя
 *    накладываются после (см. /api/trending, /api/channels, /api/search).
 *
 * Защита от лавины: кросс-инстансный лок (lock:*, SET NX PX 10с) — тяжёлый
 * fetcher при полном промахе выполняет один инстанс; при падении fetcher'а
 * отдаётся stale-слепок (stale:*, TTL ≥ 1ч) вместо 500-й. Прогрев ключей
 * без участия пользователей — feed-warm.ts (парсер/CRON).
 */

// v5.51: поддержка имён переменных Vercel-интеграции Upstash (REDIS_KV_REST_API_*)
// — если проект подключён через Marketplace, код работает без ручных env.
const url = (process.env.UPSTASH_REDIS_REST_URL ?? process.env.REDIS_KV_REST_API_URL ?? '').trim()
const token = (process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.REDIS_KV_REST_API_TOKEN ?? '').trim()

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

/**
 * ЭКОНОМИКА КОМАНД (v2):
 *  - fresh-окно (memoryTtlMs) — мгновенный ответ из памяти, ноль команд;
 *  - после fresh до hardExp (ровно столько, сколько живёт L2-ключ) — отдаём
 *    локальную копию и один раз запускаем ФОНОВУЮ ревалидацию (single-flight:
 *    сколько бы запросов ни пришло, Redis получит один GET);
 *  - полный промах — синхронный путь, тоже single-flight: burst N запросов
 *    после холодного старта делает ровно один GET и один SET вместо N пар.
 *
 * Итог: Redis трогается ~раз в ttlSec на ключ (минимально возможная частота
 * при cache-aside) плюс один GET версии семейства раз в VERSION_TTL_MS.
 */

type L1Entry = { v: unknown; freshExp: number; hardExp: number }
const l1 = new Map<string, L1Entry>()
const L1_MAX_ENTRIES = 300

/** одновременные промахи/ревалидации одного ключа дедуплицируются */
const inflight = new Map<string, Promise<unknown>>()

type CacheAsideOpts<T> = {
  key: string
  ttlSec: number
  memoryTtlMs?: number
  fetcher: () => Promise<T>
}

function l1Store(key: string, v: unknown, memTtlMs: number, hardTtlMs: number): void {
  const now = Date.now()
  if (l1.size >= L1_MAX_ENTRIES) {
    // чистка: сначала протухшие по hardExp, иначе — самые старые записи
    let removed = 0
    for (const [k, e] of l1) {
      if (e.hardExp <= now) {
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
  l1.set(key, { v, freshExp: now + memTtlMs, hardExp: now + hardTtlMs })
}

// ---------------- Защита от лавины (cache stampede) ----------------

/*
 * УСТОЙЧИВОСТЬ ПОД НАГРУЗКОЙ: полный промах (L1 + Redis пусто) — самая
 * опасная точка кэша: N одновременных запросов из M инстансов запускают
 * N×M тяжёлых fetcher'ов (SQL по дальнему Supabase) и кладут пул.
 * Два барьера (сверху уже стоит in-process single-flight):
 *  1) КРОСС-ИНСТАНСНЫЙ ЛОК: SET NX PX — тяжёлый fetcher выполняет
 *     ровно один инстанс, остальные ждут готовое значение (до ~0.9с),
 *     затем фетчат сами (доступность важнее строгости);
 *  2) STALE-ФОЛБЭК: при падении fetcher'а (перегрузка пула, таймаут БД)
 *     отдаём устаревший слепок (stale:{key}, TTL ≥ 1ч) вместо 500-й —
 *     пользователь видит ленту, а не ошибку.
 * ЭКОНОМИКА КОМАНД: лок/stale трогаются ТОЛЬКО на пути полного промаха
 * (редкий случай); горячий путь (fresh/stale L1, попадание в Redis)
 * по-прежнему 0–1 команда.
 */

const LOCK_TTL_MS = 10_000
const LOCK_WAIT_ROUNDS = 4
const LOCK_WAIT_MS = 220

const lockKeyOf = (key: string) => `lock:${key}`
const staleKeyOf = (key: string) => `stale:${key}`

/** Попытка взять кросс-инстансный лок; true — взяли (или Redis недоступен — фетчим) */
async function acquireLock(key: string): Promise<boolean> {
  if (!redis) return true
  try {
    const r = await withTimeout(
      redis.set(lockKeyOf(key), '1', { nx: true, px: LOCK_TTL_MS }),
      null as unknown as 'OK',
    )
    return r === 'OK' || r === '1'
  } catch {
    return true // fail-open: без лока хуже — полагаемся на single-flight в памяти
  }
}

async function releaseLock(key: string): Promise<void> {
  if (!redis) return
  try {
    await withTimeout(redis.del(lockKeyOf(key)), undefined as never)
  } catch {
    /* лок истечёт по PX */
  }
}

/** fetcher → память + Redis + stale-бэкап */
async function fetchAndStore<T>(
  opts: CacheAsideOpts<T>,
  memTtlMs: number,
  hardTtlMs: number,
): Promise<T> {
  const fresh = await opts.fetcher()
  l1Store(opts.key, fresh, memTtlMs, hardTtlMs)
  await cacheSet(opts.key, fresh, opts.ttlSec) // 1 SET (только при промахе)
  // stale-бэкап переживёт несколько неудачных ревалидаций подряд
  await cacheSet(staleKeyOf(opts.key), fresh, Math.max(opts.ttlSec * 6, 3_600))
  return fresh
}

/** При ошибке fetcher'а — устаревший слепок вместо 500-й; null — отдавать ошибку */
async function staleFallback<T>(key: string, memTtlMs: number, hardTtlMs: number): Promise<T | null> {
  const stale = await cacheGet<T>(staleKeyOf(key))
  if (stale !== null) {
    l1Store(key, stale, memTtlMs, hardTtlMs)
    return stale
  }
  return null
}

/** Общий путь «Redis GET → при промахе fetcher → Redis SET», с дедупликацией */
function loadThrough<T>(opts: CacheAsideOpts<T>, memTtlMs: number, hardTtlMs: number): Promise<T> {
  const existing = inflight.get(opts.key)
  if (existing) return existing as Promise<T>

  const p = (async (): Promise<T> => {
    const remote = await cacheGet<T>(opts.key) // 1 GET
    if (remote !== null) {
      l1Store(opts.key, remote, memTtlMs, hardTtlMs)
      return remote
    }

    // Полный промах: сначала пробуем лок (фетчит один инстанс)
    if (await acquireLock(opts.key)) {
      try {
        return await fetchAndStore(opts, memTtlMs, hardTtlMs)
      } catch (e) {
        const stale = await staleFallback<T>(opts.key, memTtlMs, hardTtlMs)
        if (stale !== null) return stale
        throw e
      } finally {
        void releaseLock(opts.key)
      }
    }

    // Лок занят — другой инстанс уже фетчит: ждём готовое значение
    for (let i = 0; i < LOCK_WAIT_ROUNDS; i++) {
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS))
      const v = await cacheGet<T>(opts.key)
      if (v !== null) {
        l1Store(opts.key, v, memTtlMs, hardTtlMs)
        return v
      }
    }
    // Не дождались (медленный fetcher, вымытый лок) — фетчим сами
    try {
      return await fetchAndStore(opts, memTtlMs, hardTtlMs)
    } catch (e) {
      const stale = await staleFallback<T>(opts.key, memTtlMs, hardTtlMs)
      if (stale !== null) return stale
      throw e
    }
  })()

  inflight.set(
    opts.key,
    p.catch(() => null), // фон-ревалидации не должны копить unhandled rejections
  )
  void p
    .catch(() => undefined)
    .finally(() => {
      if (inflight.get(opts.key)) inflight.delete(opts.key)
    })
  return p
}

/**
 * Cache-aside: L1 память (fresh → stale) → L2 Redis → fetcher.
 * Требование: значение fetcher должно быть JSON-сериализуемым.
 */
export async function cacheAside<T>(opts: CacheAsideOpts<T>): Promise<T> {
  const memTtl = opts.memoryTtlMs ?? Math.min(opts.ttlSec * 1000, 5000)
  // hard-окно совпадает с жизнью L2-ключа: пока локальная копия жива,
  // Redis-значение заведомо ещё существует (ревалидация найдёт его одним GET)
  const hardTtl = Math.max(opts.ttlSec * 1000, memTtl)

  const e = l1.get(opts.key)
  const now = Date.now()
  if (e && e.hardExp > now) {
    if (e.freshExp > now) return e.v as T
    // stale, но в пределах hardExp: одна фоновая ревалидация, ответ из памяти
    void loadThrough(opts, memTtl, hardTtl).catch(() => undefined)
    return e.v as T
  }

  return loadThrough(opts, memTtl, hardTtl)
}

// ---------------- Версии семейств (инвалидация, O(1)) ----------------

/**
 * Инвалидация через версии: ключ кэша содержит номер версии семейства.
 * bumpCache инкрементирует счётчик — старые ключи становятся недостижимыми
 * и истекают по TTL.
 *
 * ЭКОНОМИЯ КОМАНД (Upstash тарифицирует каждую команду):
 * версия кэшируется в памяти процесса на VERSION_TTL_MS — Redis-GET версии
 * делается не на каждый запрос, а раз в 60с на семейство (сами TTL данных
 * 25–120с — задержка инвалидации соседних инстансов им сопоставима).
 * bump обновляет локальную копию мгновенно (свой инстанс видит инвалидацию
 * сразу) и пайплайнит все INCR в один REST-запрос.
 */
export const CACHE_FAMILIES = ['feed', 'tr', 'ch', 'ct', 'sr', 'qt'] as const
export type CacheFamily = (typeof CACHE_FAMILIES)[number]

const VERSION_TTL_MS = 60_000
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
  // все INCR одним pipeline-запросом (один RTT вместо N)
  if (redis && families.length > 0) {
    const pipe = redis.pipeline()
    for (const f of families) pipe.incr(`ver:${f}`)
    try {
      await withTimeout(pipe.exec(), undefined as never)
    } catch {
      /* соседние инстансы обновятся по TTL ключей — не критично */
    }
  }
  // локальная копия — сразу актуальная (без GET)
  for (const f of families) {
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

/** Результат health-проверки кэшируется в памяти — не чаще раза в 5 минут */
let healthCache: { v: 'upstash' | 'memory-only' | 'down'; exp: number } | null = null
const HEALTH_MEM_TTL_MS = 300_000

/** Проверка Redis для /api/health (не бросает исключений, экономит команды) */
export async function redisHealth(): Promise<'upstash' | 'memory-only' | 'down'> {
  if (!redis) return 'memory-only'
  if (healthCache && healthCache.exp > Date.now()) return healthCache.v
  try {
    await redis.set('health:ping', Date.now(), { ex: 600 })
    healthCache = { v: 'upstash', exp: Date.now() + HEALTH_MEM_TTL_MS }
    return 'upstash'
  } catch {
    healthCache = { v: 'down', exp: Date.now() + HEALTH_MEM_TTL_MS }
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
