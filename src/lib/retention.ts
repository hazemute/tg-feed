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

/** Имя шага → SQL. Все запросы статичны (без параметров), выполняются как есть. */
const JOBS: { name: string; sql: string }[] = [
  { name: 'PostView', sql: `delete from "PostView" where "createdAt" < now() - interval '180 days'` },
  { name: 'LoginAttempt', sql: `delete from "LoginAttempt" where "createdAt" < now() - interval '30 days'` },
  { name: 'AdminLog', sql: `delete from "AdminLog" where "createdAt" < now() - interval '90 days'` },
  { name: 'AiSearchLog', sql: `delete from "AiSearchLog" where "createdAt" < now() - interval '30 days'` },
  { name: 'TranslationLog', sql: `delete from "TranslationLog" where "createdAt" < now() - interval '30 days'` },
  { name: 'HashtagClick', sql: `delete from "HashtagClick" where "createdAt" < now() - interval '90 days'` },
  { name: 'CampaignClick', sql: `delete from "CampaignClick" where "lastBilledAt" < now() - interval '90 days'` },
  { name: 'CampaignStat', sql: `delete from "CampaignStat" where day < to_char(now() - interval '180 days', 'YYYY-MM-DD')` },
  { name: 'AdStat', sql: `delete from "AdStat" where day < to_char(now() - interval '180 days', 'YYYY-MM-DD')` },
  { name: 'Notification.read', sql: `delete from "Notification" where "readAt" is not null and "createdAt" < now() - interval '30 days'` },
  { name: 'Notification.stale', sql: `delete from "Notification" where "createdAt" < now() - interval '365 days'` },
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
