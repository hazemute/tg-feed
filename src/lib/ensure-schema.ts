import { db } from '@/lib/db'

/**
 * Идемпотентные миграции прода — единый источник для:
 *  - автоприменения при старте сервера (src/instrumentation.ts),
 *  - панели (POST /api/panel/system {action:'applyMigration'}),
 *  - самопроверки и самолечения /api/health.
 *
 * ТОЛЬКО фиксированные строки SQL — никакой внешней интерполяции.
 * Каждый шаг защищён IF NOT EXISTS, повторный запуск безопасен.
 *
 * ВАЖНО: локальные таблицы не создаются — песочница на Supabase-схеме
 * (prisma/schema.prisma → Postgres). Ветка file: оставлена только как
 * dev-fallback песочницы, пока в .env не вставлен DATABASE_URL Supabase.
 */

export const MIGRATIONS: Record<string, string[]> = {
  'v5.15': [
    `ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "aiFlag" text`,
    `ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "aiFlagAt" timestamptz`,
    `CREATE INDEX IF NOT EXISTS "Post_aiFlag_idx" ON "Post" ("aiFlag")`,
  ],
  'v5.17': [
    // v5.17: тарифы Snap Plus/Pro + ИИ-поиск + ИИ-ассистент + CTA + продвижение
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tier" text NOT NULL DEFAULT 'free'`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tierUntil" timestamptz`,
    `ALTER TABLE "Channel" ADD COLUMN IF NOT EXISTS "ctaLabel" text`,
    `ALTER TABLE "Channel" ADD COLUMN IF NOT EXISTS "ctaUrl" text`,
    `ALTER TABLE "Channel" ADD COLUMN IF NOT EXISTS "styleProfile" text`,
    `ALTER TABLE "Channel" ADD COLUMN IF NOT EXISTS "styleAt" timestamptz`,
    `ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "promotedAt" timestamptz`,
    `ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "hotScore" double precision NOT NULL DEFAULT 0`,
    `ALTER TABLE "PendingPayment" ADD COLUMN IF NOT EXISTS "purpose" text NOT NULL DEFAULT 'balance'`,
    `CREATE TABLE IF NOT EXISTS "AiSearchLog" ("id" text PRIMARY KEY, "userId" text NOT NULL, "query" text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE INDEX IF NOT EXISTS "AiSearchLog_userId_createdAt_idx" ON "AiSearchLog" ("userId", "createdAt" DESC)`,
  ],
  'v5.18': [
    // v5.18: аудит-журнал админ-панели (выдача подписок, баны, операции)
    `CREATE TABLE IF NOT EXISTS "AdminLog" ("id" text PRIMARY KEY, "action" text NOT NULL, "target" text NOT NULL, "meta" text, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE INDEX IF NOT EXISTS "AdminLog_createdAt_idx" ON "AdminLog" ("createdAt" DESC)`,
    `CREATE INDEX IF NOT EXISTS "AdminLog_action_createdAt_idx" ON "AdminLog" ("action", "createdAt" DESC)`,
  ],
}

const ALL: string[] = Object.values(MIGRATIONS).flat()

function isSqlite(): boolean {
  return (process.env.DATABASE_URL ?? '').startsWith('file:')
}

/** Критичные объекты схемы: [таблица, колонка] (колонка null → проверяется сама таблица) */
const CRITICAL: Array<[string, string | null]> = [
  ['User', 'tier'],
  ['User', 'tierUntil'],
  ['Channel', 'ctaLabel'],
  ['Channel', 'styleProfile'],
  ['Post', 'hotScore'],
  ['Post', 'promotedAt'],
  ['Post', 'aiFlag'],
  ['PendingPayment', 'purpose'],
  ['AiSearchLog', null],
  ['AdminLog', null],
]

export type SchemaState = { ok: boolean; missing: string[] }

/** Проверка критичных объектов схемы (Postgres; в SQLite-песочнице всегда ok) */
export async function checkSchema(): Promise<SchemaState> {
  if (isSqlite()) return { ok: true, missing: [] }
  try {
    type Row = { table_name: string; column_name: string }
    const rows = await db.$queryRawUnsafe<Row[]>(`
      SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND (
        c.table_name = 'AiSearchLog' OR c.table_name = 'AdminLog' OR
        (c.table_name = 'User' AND c.column_name IN ('tier','tierUntil')) OR
        (c.table_name = 'Channel' AND c.column_name IN ('ctaLabel','ctaUrl','styleProfile','styleAt')) OR
        (c.table_name = 'Post' AND c.column_name IN ('promotedAt','hotScore','aiFlag')) OR
        (c.table_name = 'PendingPayment' AND c.column_name = 'purpose')
      )`)
    const tables = new Set<string>()
    const cols = new Set<string>()
    for (const r of rows) {
      tables.add(r.table_name)
      cols.add(`${r.table_name}.${r.column_name}`)
    }
    const missing = CRITICAL.filter(([t, c]) => (c ? !cols.has(`${t}.${c}`) : !tables.has(t))).map(([t, c]) =>
      c ? `${t}.${c}` : t,
    )
    return { ok: missing.length === 0, missing }
  } catch (e) {
    console.error('[schema/check]', e)
    return { ok: false, missing: ['<check failed>'] }
  }
}

let ensuredOk = false
let lastEnsureAt = 0

/**
 * Применить все миграции (идемпотентно). Вызывается при старте сервера и
 * самолечением из /api/health. Возвращает состояние схемы после прогона.
 */
export async function ensureAppSchema(opts?: { force?: boolean }): Promise<{ ok: boolean; applied: number; missing: string[] }> {
  if (isSqlite()) return { ok: true, applied: 0, missing: [] }
  if (ensuredOk && !opts?.force) return { ok: true, applied: 0, missing: [] }
  // повторные вызовы не чаще раза в 30с — просто ре-проверяем
  if (!opts?.force && Date.now() - lastEnsureAt < 30_000) {
    const st = await checkSchema()
    return { ok: st.ok, applied: 0, missing: st.missing }
  }
  lastEnsureAt = Date.now()
  let applied = 0
  for (const sql of ALL) {
    try {
      await db.$executeRawUnsafe(sql)
      applied++
    } catch (e) {
      console.error('[ensure-schema]', (e as Error).message)
    }
  }
  const st = await checkSchema()
  ensuredOk = st.ok
  return { ok: st.ok, applied, missing: st.missing }
}

/** Именованная миграция из панели (v5.15 | v5.17 | v5.18). Возвращает число применённых шагов. */
export async function applyNamedMigration(version: string): Promise<number> {
  const stmts = MIGRATIONS[version]
  if (!stmts) throw new Error('unknown migration')
  let applied = 0
  for (const sql of stmts) {
    await db.$executeRawUnsafe(sql)
    applied++
  }
  ensuredOk = false // схема изменилась — кэш проверки сбрасываем
  return applied
}
