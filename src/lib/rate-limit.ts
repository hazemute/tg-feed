/**
 * In-memory rate limiter (скользящее окно) — без внешних зависимостей.
 * Достаточно для MVP: один инстанс Next.js, лимиты на IP и на пользователя.
 */

/** windowMs хранится В БАКЕТЕ: у каждого ключа своё окно (2.5с…5мин),
 *  и чистка не должна резать чужие окна по windowMs текущего запроса —
 *  раньше чистка, вызванная коротким окном (например pace 2.5с), стирала
 *  историю длинных окон (parse-run 5мин) и ослабляла их капы. */
type Bucket = { hits: number[]; windowMs: number }

const buckets = new Map<string, Bucket>()

/** Периодическая чистка протухших бакетов, чтобы память не текла */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000
let lastCleanup = Date.now()

/*
 * Task 8-b (пик 70к): кап на число бакетов + учащённая чистка под давлением.
 * Прежде чистка была только по времени (раз в 5 минут): розыгрыш приносит
 * десятки тысяч уникальных ключей за минуты, и hits-массивы успевали
 * разрастись (до limit таймстампов на пользователя). Теперь:
 *  - при размере > SWEEP_PRESSURE чистка запускается раз в 30с (а не 5 мин);
 *  - при переполнении сверх BUCKETS_MAX после чистки — FIFO-тримминг
 *    (новые пользователи вытесняют старые записи; лимиты по-прежнему
 *    консервативны: вытеснение лишь сбрасывает счётчик, не повышает лимит).
 */
const BUCKETS_MAX = 100_000
const SWEEP_PRESSURE = 20_000
const SWEEP_PRESSURE_INTERVAL_MS = 30_000

function sweepBuckets(now: number): void {
  for (const [key, bucket] of buckets) {
    const fresh = bucket.hits.filter((t) => now - t < bucket.windowMs)
    if (fresh.length === 0) buckets.delete(key)
    else bucket.hits = fresh
  }
}

function maybeCleanup(): void {
  const now = Date.now()
  const pressure = buckets.size > SWEEP_PRESSURE
  if (now - lastCleanup < (pressure ? SWEEP_PRESSURE_INTERVAL_MS : CLEANUP_INTERVAL_MS)) return
  lastCleanup = now
  sweepBuckets(now)
  // FIFO-тримминг при переполнении: память важнее точности счётчика
  while (buckets.size > BUCKETS_MAX) {
    const first = buckets.keys().next().value
    if (first === undefined) break
    buckets.delete(first)
  }
}

export type RateLimitResult = { ok: boolean; retryAfterSec: number; remaining: number }

/**
 * Проверить лимит. Ключ — произвольная строка (например `ip:1.2.3.4` или
 * `user:tg_123:like`). Возвращает ok=false и retryAfterSec при превышении.
 */
export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now()
  maybeCleanup()

  const bucket = buckets.get(key) ?? { hits: [], windowMs }
  bucket.windowMs = windowMs // окно может легитимно меняться вызовом — обновляем
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs)

  if (bucket.hits.length >= limit) {
    buckets.set(key, bucket)
    const oldest = bucket.hits[0] ?? now
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000)),
      remaining: 0,
    }
  }

  bucket.hits.push(now)
  buckets.set(key, bucket)
  return { ok: true, retryAfterSec: 0, remaining: limit - bucket.hits.length }
}

/** IP клиента из стандартных заголовков прокси (.gateway ставит x-forwarded-for) */
export function clientIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return request.headers.get('x-real-ip') ?? 'local'
}
