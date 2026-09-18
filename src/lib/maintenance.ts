import { db } from '@/lib/db'
import { redis } from '@/lib/redis'

/**
 * Режим технических работ.
 *
 * Кто может зайти в миниапп при включённых техработах:
 *  1) админы — Telegram ID из переменной окружения ADMIN_TG_IDS
 *     (через запятую; допускаются формы "123456789" и "tg_123456789");
 *  2) пользователи с галкой «допуск» (User.bypassMaintenance) — их UID
 *     продублирован в Redis-множестве sys:maint_pass для быстрой проверки
 *     в Edge-middleware (в Edge нет доступа к PostgreSQL).
 *
 * Хранение флага: Redis sys:maintenance ('1'/'0') — рантайм-источник,
 * таблица SystemSetting — долговечное зеркало (восстановление после
 * сброса Redis, отображение в панели).
 *
 * Деградация: Redis недоступен → флаг считается выключенным (приложение
 * остаётся доступным — доступность важнее строгости блокировки).
 */

export const MAINT_KEY = 'sys:maintenance'
export const MAINT_PASS_SET = 'sys:maint_pass'
export const MAINT_SETTING_KEY = 'maintenance'

const MEM_TTL_MS = 15_000
let memFlag: { v: boolean; exp: number } | null = null

/** Флаг техработ (кэш в памяти процесса на 15с — экономим команды Redis) */
export async function isMaintenanceOn(): Promise<boolean> {
  if (memFlag && memFlag.exp > Date.now()) return memFlag.v
  let v = false
  if (redis) {
    try {
      const raw = await redis.get<string | number>(MAINT_KEY)
      // Upstash может отдать и строку, и число (REST-десериализация) — учитываем оба варианта
      v = raw === 'on' || raw === '1' || raw === 1
    } catch {
      v = false
    }
  }
  memFlag = { v, exp: Date.now() + MEM_TTL_MS }
  return v
}

/** Включить/выключить техработы (Redis + зеркало в БД, локальный кэш сразу) */
export async function setMaintenance(on: boolean): Promise<void> {
  memFlag = { v: on, exp: Date.now() + MEM_TTL_MS }
  if (redis) {
    try {
      // 'on'/'off' — нечисловые строки: REST-клиент гарантированно вернёт строку
      await redis.set(MAINT_KEY, on ? 'on' : 'off')
    } catch {
      /* Redis недоступен — флаг применится, когда восстановится */
    }
  }
  try {
    await db.systemSetting.upsert({
      where: { key: MAINT_SETTING_KEY },
      update: { value: on ? '1' : '0' },
      create: { key: MAINT_SETTING_KEY, value: on ? '1' : '0' },
    })
  } catch {
    /* зеркало не критично */
  }
}

/** Значение из долговечного зеркала (для панели: что было до сбоя Redis) */
export async function maintenanceDbMirror(): Promise<boolean> {
  try {
    const row = await db.systemSetting.findUnique({ where: { key: MAINT_SETTING_KEY } })
    return row?.value === '1'
  } catch {
    return false
  }
}

// ------------------------- Белый список допуска -------------------------

/** UIDs, допущенные мимо техработ (из Redis-множества; для панели) */
export async function maintenanceAllowList(): Promise<string[]> {
  if (!redis) return []
  try {
    const members = await redis.smembers<string[]>(MAINT_PASS_SET)
    return Array.isArray(members) ? members : []
  } catch {
    return []
  }
}

/** Проверка допуска по UID (SISMEMBER, 1 команда; вызывается только при включённых техработах) */
export async function isMaintenanceAllowed(uid: string): Promise<boolean> {
  if (!redis) return false
  try {
    const r = await redis.sismember(MAINT_PASS_SET, uid)
    return r === 1
  } catch {
    return false
  }
}

/** Добавить/убрать UID из допуска. DB — источник истины, Redis — рантайм. */
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
      /* восстановим через панель */
    }
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
