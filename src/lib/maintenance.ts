import { db } from '@/lib/db'
import { redis } from '@/lib/redis'
import { pruneAll } from '@/lib/retention'

/**
 * Режим технических работ — УСТОЙЧИВЫЙ К ПЕРЕЗАПУСКАМ И ВЫМЫВАНИЮ REDIS.
 *
 * ИСТОЧНИК ИСТИНЫ — PostgreSQL (SystemSetting.key='maintenance').
 * Redis (sys:maintenance) и память процесса — только рантайм-зеркала:
 *   - ключ Redis может быть вымыт (эвикция/флаш/перезапуск Upstash) или
 *     вообще отсутствовать локально (token не задан) — флаг от этого
 *     БОЛЬШЕ НЕ СЛЕТАЕТ: при пустом Redis значение читается из БД,
 *     а Redis самолечится (запись 'on' + синхронизация белого списка);
 *   - фоновый heartbeat (раз в 30с) сводит Redis с БД, чтобы Edge-
 *     middleware (у которого доступа к PostgreSQL нет) всегда видел флаг.
 *
 * Кто может зайти при включённых техработах:
 *  1) админы — Telegram ID из ADMIN_TG_IDS (через запятую, "123456789"/"tg_...");
 *  2) пользователи с галкой «допуск» (User.bypassMaintenance) — UID'ы
 *     продублированы в Redis-множестве sys:maint_pass для быстрой проверки
 *     в Edge; БД — источник истины, множество восстанавливается из неё.
 *
 * Деградация: и Redis, и БД недоступны → флаг считается выключенным
 * (доступность приложения важнее строгости блокировки).
 */

export const MAINT_KEY = 'sys:maintenance'
export const MAINT_PASS_SET = 'sys:maint_pass'
export const MAINT_SETTING_KEY = 'maintenance'
/** Зеркало забаненных пользователей (Edge не видит Postgres — см. шапку) */
export const BANS_SET = 'sys:banned'

const MEM_TTL_MS = 15_000
/** Явное 'off' из Redis можно кэшировать дольше — включение подхватится ≤60с */
const MEM_TTL_OFF_MS = 60_000
const DB_MIRROR_TTL_MS = 60_000
const HEARTBEAT_MS = 30_000
/** Эконом-режим heartbeat при выключенном флаге: раз в 10 минут */
const IDLE_SYNC_MS = 10 * 60_000
let lastIdleSyncAt = 0

let memFlag: { v: boolean; exp: number } | null = null
let dbMirrorCache: { v: boolean; exp: number } | null = null

// ------------------------- Прямое чтение зеркала БД -------------------------

async function dbMirrorRead(): Promise<boolean> {
  try {
    const row = await db.systemSetting.findUnique({ where: { key: MAINT_SETTING_KEY } })
    return row?.value === '1'
  } catch {
    return false
  }
}

/** Значение зеркала БД с коротким кэшем (экономим PostgreSQL при частых вызовах) */
async function dbMirrorCached(): Promise<boolean> {
  if (dbMirrorCache && dbMirrorCache.exp > Date.now()) return dbMirrorCache.v
  const v = await dbMirrorRead()
  dbMirrorCache = { v, exp: Date.now() + DB_MIRROR_TTL_MS }
  return v
}

/** Свежее значение из БД (панель показывает расхождение рантайма и зеркала) */
export async function maintenanceDbMirror(): Promise<boolean> {
  return dbMirrorRead()
}

// ------------------------------ Флаг техработ ------------------------------

/**
 * Значение ключа в Redis: true/false — явное значение,
 * null — ключа нет (вымыт/перезапуск) или Redis недоступен.
 */
async function redisFlagValue(): Promise<boolean | null> {
  if (!redis) return null
  try {
    const raw = await redis.get<string | number>(MAINT_KEY)
    // Upstash может отдать и строку, и число (REST-десериализация)
    if (raw === 'on' || raw === '1' || raw === 1) return true
    if (raw === 'off' || raw === '0' || raw === 0) return false
    return null
  } catch {
    return null
  }
}

/** Флаг техработ. Явное значение Redis → иначе долговечное зеркало в БД. */
export async function isMaintenanceOn(): Promise<boolean> {
  ensureHeartbeat()
  if (memFlag && memFlag.exp > Date.now()) return memFlag.v

  const explicit = await redisFlagValue()
  if (explicit !== null) {
    // 'on' проверяем часто (быстрая реакция), явное 'off' — редко (экономия команд)
    memFlag = { v: explicit, exp: Date.now() + (explicit ? MEM_TTL_MS : MEM_TTL_OFF_MS) }
    return explicit
  }

  // Redis пуст/недоступен — техработы НЕ слетают: читаем БД
  const v = await dbMirrorCached()
  memFlag = { v, exp: Date.now() + MEM_TTL_MS }
  if (v) void healRedisFromDb()
  return v
}

/** Включить/выкл. техработы: СНАЧАЛА БД (не слетает), затем Redis-зеркало */
export async function setMaintenance(on: boolean): Promise<void> {
  ensureHeartbeat()
  memFlag = { v: on, exp: Date.now() + MEM_TTL_MS }
  dbMirrorCache = { v: on, exp: Date.now() + DB_MIRROR_TTL_MS }
  try {
    await db.systemSetting.upsert({
      where: { key: MAINT_SETTING_KEY },
      update: { value: on ? '1' : '0' },
      create: { key: MAINT_SETTING_KEY, value: on ? '1' : '0' },
    })
  } catch {
    /* БД недоступна — Redis ниже всё равно применит; heartbeat сведёт позже */
  }
  if (redis) {
    try {
      // 'on'/'off' — нечисловые строки: REST-клиент гарантированно вернёт строку
      await redis.set(MAINT_KEY, on ? 'on' : 'off')
    } catch {
      /* Redis недоступен — восстановится heartbeat'ом/самолечением */
    }
  }
}

/**
 * Самолечение: вернуть флаг 'on' в Redis (после вымывания/перезапуска) и
 * синхронизировать белый список — чтобы Edge-middleware снова видел режим.
 */
async function healRedisFromDb(): Promise<void> {
  if (!redis) return
  try {
    await redis.set(MAINT_KEY, 'on')
  } catch {
    /* heartbeat повторит */
  }
  await syncAllowSetFromDb()
}

// ------------------------- Белый список допуска -------------------------

/**
 * Синхронизация Redis-множества допуска с БД (User.bypassMaintenance —
 * источник истины). Вызывается heartbeat'ом и самолечением.
 */
async function syncAllowSetFromDb(): Promise<void> {
  if (!redis) return
  try {
    const users = await db.user.findMany({
      where: { bypassMaintenance: true },
      select: { id: true },
    })
    const target = users.map((u) => u.id)
    const current = await redis.smembers<string[]>(MAINT_PASS_SET)
    const cur = new Set(Array.isArray(current) ? current : [])
    const add = target.filter((id) => !cur.has(id))
    const rem = [...cur].filter((id) => !target.includes(id))
    if (add.length) {
      try {
        // сигнатура Upstash: sadd(key, member, ...members) — первый элемент позиционный
        await redis.sadd(MAINT_PASS_SET, add[0], ...add.slice(1))
      } catch {
        /* повтор на следующем тике */
      }
    }
    if (rem.length) {
      try {
        await redis.srem(MAINT_PASS_SET, rem[0], ...rem.slice(1))
      } catch {
        /* повтор на следующем тике */
      }
    }
  } catch {
    /* тихо — повтор на следующем тике heartbeat'а */
  }
}

/**
 * UIDs, допущенные мимо техработ. БД — источник истины (список не слетает
 * вместе с Redis), члены Redis-множества добавляются поверх (совместимость).
 */
export async function maintenanceAllowList(): Promise<string[]> {
  const ids = new Set<string>()
  try {
    const users = await db.user.findMany({
      where: { bypassMaintenance: true },
      select: { id: true },
    })
    for (const u of users) ids.add(u.id)
  } catch {
    /* БД недоступна — попробуем Redis ниже */
  }
  if (redis) {
    try {
      const members = await redis.smembers<string[]>(MAINT_PASS_SET)
      for (const m of Array.isArray(members) ? members : []) ids.add(m)
    } catch {
      /* только БД */
    }
  }
  return [...ids]
}

/**
 * Проверка допуска по UID. Сначала Redis (1 команда, SISMEMBER),
 * при промахе — БД (множество могло быть вымыто), с самолечением множества.
 */
export async function isMaintenanceAllowed(uid: string): Promise<boolean> {
  if (redis) {
    try {
      const r = await redis.sismember(MAINT_PASS_SET, uid)
      if (r === 1) return true
    } catch {
      /* падаем в БД */
    }
  }
  try {
    const u = await db.user.findUnique({
      where: { id: uid },
      select: { bypassMaintenance: true },
    })
    if (u?.bypassMaintenance) {
      if (redis) {
        try {
          await redis.sadd(MAINT_PASS_SET, uid)
        } catch {
          /* повтор на следующем тике */
        }
      }
      return true
    }
    return false
  } catch {
    return false
  }
}

/** Добавить/убрать UID из допуска. БД — источник истины, Redis — рантайм. */
export async function setMaintenanceAllowed(uid: string, allowed: boolean): Promise<void> {
  try {
    await db.user.update({ where: { id: uid }, data: { bypassMaintenance: allowed } })
  } catch {
    /* пользователя ещё нет в БД — создаётся при первом входе; обновим позже */
  }
  if (redis) {
    try {
      if (allowed) await redis.sadd(MAINT_PASS_SET, uid)
      else await redis.srem(MAINT_PASS_SET, uid)
    } catch {
      /* восстановится heartbeat'ом из БД */
    }
  }
}

/**
 * БАН (v5.11, приказ владельца): User.bannedAt + зеркало sys:banned для
 * Edge-middleware (403 banned на всех /api/*, кроме auth/panel/health/webhooks).
 */
export async function setBanned(uid: string, banned: boolean, reason?: string): Promise<void> {
  try {
    await db.user.update({
      where: { id: uid },
      data: banned ? { bannedAt: new Date(), banReason: reason ?? null } : { bannedAt: null, banReason: null },
    })
  } catch {
    /* пользователя нет в БД — мьютим только зеркало */
  }
  if (redis) {
    try {
      if (banned) await redis.sadd(BANS_SET, uid)
      else await redis.srem(BANS_SET, uid)
    } catch {
      /* восстановится heartbeat'ом из БД */
    }
  }
}

// ------------------------------ Heartbeat ------------------------------

let heartbeatStarted = false

/**
 * Фоновая сверка Redis с БД раз в 30с: Edge-middleware не имеет доступа к
 * PostgreSQL, поэтому Node-рантайм сам держит зеркало тёплым — флаг и белый
 * список восстанавливаются в Redis даже после флаша/эвикции/перезапуска.
 */
function ensureHeartbeat(): void {
  if (heartbeatStarted) return
  heartbeatStarted = true
  if (typeof setInterval !== 'function') return
  const timer = setInterval(() => {
    void heartbeatTick()
  }, HEARTBEAT_MS)
  // не держим процесс живым из-за таймера (скрипты/CLI завершаются штатно)
  ;(timer as unknown as { unref?: () => void }).unref?.()
}

async function heartbeatTick(): Promise<void> {
  // Ретеншен лог-таблиц (свой троттлинг 19ч + Redis-лок) — и в эконом-режиме
  void pruneAll().catch(() => {})
  if (!redis) return // локально без Upstash зеркала нет — БД и так источник
  try {
    const on = await dbMirrorCached()
    if (!on) {
      // ЭКОНОМИЯ КОМАНД: флаг выключен (штатный режим) — раньше heartbeat
      // делал 1-4 команды Redis каждые 30с на каждый инстанс (до сотен тысяч
      // команд/день на Upstash). Теперь раз в 10 минут: восстанавливаем
      // явный 'off' (после флаша ключа Edge ходил бы в БД на каждый запрос)
      // и синхронизируем зеркало банов для Edge.
      if (Date.now() - lastIdleSyncAt < IDLE_SYNC_MS) return
      lastIdleSyncAt = Date.now()
      try {
        await redis.set(MAINT_KEY, 'off')
      } catch {
        /* повтор на следующем цикле */
      }
      await syncBansFromDb()
      return
    }
    const redisOn = await redisFlagValue()
    if (redisOn !== on) {
      try {
        await redis.set(MAINT_KEY, on ? 'on' : 'off')
        memFlag = { v: on, exp: Date.now() + MEM_TTL_MS }
      } catch {
        /* повтор на следующем тике */
      }
    }
    await syncAllowSetFromDb()
    await syncBansFromDb()
  } catch {
    /* тихо */
  }
}

// ------------------------------ Баны ------------------------------

/**
 * Зеркало банов БД → Redis (тот же паттерн, что whitelist техработ):
 * Edge-middleware проверяет SMEMBERS sys:banned с локальным кэшем 60с.
 */
async function syncBansFromDb(): Promise<void> {
  if (!redis) return
  try {
    const users = await db.user.findMany({
      where: { bannedAt: { not: null } },
      select: { id: true },
    })
    const target = users.map((u) => u.id)
    const current = await redis.smembers<string[]>(BANS_SET)
    const cur = new Set(Array.isArray(current) ? current : [])
    const add = target.filter((id) => !cur.has(id))
    const rem = [...cur].filter((id) => !target.includes(id))
    if (add.length) {
      try {
        await redis.sadd(BANS_SET, add[0], ...add.slice(1))
      } catch {
        /* повтор на следующем тике */
      }
    }
    if (rem.length) {
      try {
        await redis.srem(BANS_SET, rem[0], ...rem.slice(1))
      } catch {
        /* повтор на следующем тике */
      }
    }
  } catch {
    /* тихо — повтор на следующем тике heartbeat'а */
  }
}

// ------------------------------ Админы ------------------------------

/**
 * UIDs админов из ADMIN_TG_IDS (env). Пример: ADMIN_TG_IDS=123456789,987654321
 * Форма в сессии: tg_<id>. Пустая переменная → админов нет (только белый список).
 */
export function adminUids(): string[] {
  return (process.env.ADMIN_TG_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith('tg_') ? s : `tg_${s}`))
}
