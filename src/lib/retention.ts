import { db } from '@/lib/db'
import { redis } from '@/lib/redis'

/**
 * РЕТЕНШЕН ЛОГ-ТАБЛИЦ — «чтобы БД никогда больше не разрослась»
 * (урок v5.35: 779MB TTS-блобов уложили free-квоту и заморозили прод).
 *
 * Принципы:
 * - ПОЛЬЗОВАТЕЛЬСКИЕ данные (Post, Comment, Like, Channel, User…) не трогаем;
 * - подрезаются только журналы/счётчики, которым старость не нужна;
 * - идемпотентно и дёшево: десятки строк в день, удаляем по возрасту;
 * - вызывается из daily-cron /api/parse/tick и фонового heartbeat-слота;
 *   двойной прогон исключают локальный троттлинг (19ч на инстанс) и
 *   межпроцессный Redis-лок (20ч, SET NX) — при недоступном Redis остаётся
 *   локальный троттлинг.
 */

const LOCK_KEY = 'sys:retention_lock'
const LOCK_TTL_MS = 20 * 3_600_000
const MIN_INTERVAL_MS = 19 * 3_600_000

let lastRunAt = 0
let running: Promise<Record<string, number>> | null = null

/** Имя шага → SQL. Запросы статичны, кроме дат-отсечок: они считаются в JS,
 *  чтобы один и тот же SQL работал и в Postgres, и в локальной SQLite
 *  (interval/to_char — Postgres-only, в SQLite дают syntax error). */
function cutIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}
function cutDay(days: number): string {
  return cutIso(days).slice(0, 10)
}
const JOBS: { name: string; sql: string }[] = [
  { name: 'PostView', sql: `delete from "PostView" where "createdAt" < '${cutIso(180)}'` },
  { name: 'LoginAttempt', sql: `delete from "LoginAttempt" where "createdAt" < '${cutIso(30)}'` },
  { name: 'AdminLog', sql: `delete from "AdminLog" where "createdAt" < '${cutIso(90)}'` },
  { name: 'AiSearchLog', sql: `delete from "AiSearchLog" where "createdAt" < '${cutIso(30)}'` },
  { name: 'TranslationLog', sql: `delete from "TranslationLog" where "createdAt" < '${cutIso(30)}'` },
  { name: 'HashtagClick', sql: `delete from "HashtagClick" where "createdAt" < '${cutIso(90)}'` },
  { name: 'CampaignClick', sql: `delete from "CampaignClick" where "lastBilledAt" < '${cutIso(90)}'` },
  { name: 'CampaignStat', sql: `delete from "CampaignStat" where day < '${cutDay(180)}'` },
  { name: 'AdStat', sql: `delete from "AdStat" where day < '${cutDay(180)}'` },
  { name: 'Notification.read', sql: `delete from "Notification" where "readAt" is not null and "createdAt" < '${cutIso(30)}'` },
  { name: 'Notification.stale', sql: `delete from "Notification" where "createdAt" < '${cutIso(365)}'` },
]

async function acquireLock(): Promise<boolean> {
  if (!redis) return true // Redis недоступен — локальный троттлинг уже отсёк дубли
  try {
    const ok = (await redis.set(LOCK_KEY, String(Date.now()), { nx: true, px: LOCK_TTL_MS })) !== null
    return ok
  } catch {
    return true // деградация: без лока, локальный троттлинг страхует
  }
}

/**
 * Прогнать ретеншен. Возвращает карту «шаг → удалено строк» (-1 = ошибка шага),
 * либо {skipped:'throttle'|'lock'|'running'}.
 */
export async function pruneAll(): Promise<Record<string, number>> {
  if (running) return { skipped__running: 1 }
  if (Date.now() - lastRunAt < MIN_INTERVAL_MS) return { skipped__throttle: 1 }

  running = (async () => {
    if (!(await acquireLock())) return { skipped__lock: 1 }
    const res: Record<string, number> = {}
    for (const job of JOBS) {
      try {
        res[job.name] = await db.$executeRawUnsafe(job.sql)
      } catch (e) {
        console.error('[retention]', job.name, e instanceof Error ? e.message.slice(0, 160) : e)
        res[job.name] = -1
      }
    }
    lastRunAt = Date.now()
    const total = Object.values(res).reduce((a, b) => a + Math.max(0, b), 0)
    if (total > 0) console.log('[retention] pruned', JSON.stringify(res))
    return res
  })()

  try {
    return await running
  } finally {
    running = null
  }
}
