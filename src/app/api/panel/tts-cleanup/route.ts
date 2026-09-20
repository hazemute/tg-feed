import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { guardAdmin } from '@/lib/guard'
import { logAdmin } from '@/lib/admin-log'
import { Client } from 'pg'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/panel/tts-cleanup — уборка legacy TTS-блобов (батчами).
 *
 * До v5.35 озвучка хранится base64-блобом в Post.ttsAudio (мегабайты на пост)
 * — это раздувает БД Supabase и egress. /api/tts больше НЕ выбирает ttsAudio,
 * поэтому столбец безопасно обнулить: аудио регенерируется по запросу.
 *
 * Эндпоинт работает даже когда Supabase перевёл БД в READ-ONLY (25006,
 * переполнение квоты 500MB): прямое соединение (мимо pgbouncer) + session-level
 * `SET default_transaction_read_only = off` — официальный путь из док Supabase
 * «Disabling read-only mode». Каждый UPDATE выполняется в своей autocommit-
 * транзакции, которая после SET стартует read-write.
 *
 * Батчи по 8 строк с бюджетом ~20с на вызов: эндпоинт идемпотентный —
 * вызывайте повторно, пока { done: true }. После чистки размер БД падает
 * только после VACUUM FULL (запускается вручную в SQL Editor).
 *
 * Доступ: x-admin-key.
 */
const BATCH = 8
const BUDGET_MS = 20_000

/** Диагностика: read_only + размер БД (через Prisma, чтение при read-only работает) */
const diagnostics = async (): Promise<Record<string, unknown>> => {
  try {
    const ro = await db.$queryRaw<{ read_only: string }[]>`SHOW transaction_read_only`
    const size = await db.$queryRaw<{ size: bigint | number }[]>`SELECT pg_database_size(current_database()) AS size`
    const dbname = await db.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`
    return { read_only: ro[0]?.read_only, db_size_mb: Math.round(Number(size[0]?.size ?? 0) / 1048576), db_name: dbname[0]?.db }
  } catch (e) {
    return { diag_error: e instanceof Error ? e.message.slice(0, 120) : String(e) }
  }
}

/**
 * Прямой (не pooler) URL Supabase: session-level SET переживает только внутри
 * одного физического соединения — через pgbouncer в transaction mode каждый
 * запрос может уехать на другой серверный коннект.
 */
function directConnectionString(): string | null {
  const direct = process.env.DIRECT_URL
  if (direct) return direct
  const raw = process.env.DATABASE_URL
  if (!raw) return null
  // aws-0-xx.pooler.supabase.com:6543 -> aws-0-xx.supabase.com:5432
  return raw.replace('-pooler.', '.').replace(':6543', ':5432')
}

/** Чистка через raw pg: session SET + autocommit-батчи (без Prisma-обвязки) */
async function runRawCleanup(): Promise<{ cleared: number; done: boolean; direct: boolean; ro_before?: string }> {
  const cs = directConnectionString()
  if (!cs) throw new Error('no DATABASE_URL/DIRECT_URL')
  // Парсим URL вручную: sslmode из connectionString перекрывает ssl-объект
  // и ломает соединение («self-signed certificate in certificate chain»).
  const u = new URL(cs)
  const client = new Client({
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, '') || 'postgres',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
    statement_timeout: 25_000,
  })
  await client.connect()
  try {
    const roBefore = await client.query<{ transaction_read_only: string }>('SHOW transaction_read_only')
    // Session-level SET в autocommit: влияет на ВСЕ следующие транзакции сессии.
    await client.query('SET default_transaction_read_only = off')
    const t0 = Date.now()
    let cleared = 0
    let last = 0
    for (;;) {
      const r = await client.query(
        `update "Post" set "ttsAudio" = null, "ttsAt" = null
         where "id" in (select "id" from "Post" where "ttsAudio" is not null limit $1)`,
        [BATCH],
      )
      last = r.rowCount ?? 0
      cleared += last
      if (last === 0 || Date.now() - t0 > BUDGET_MS) break
    }
    return { cleared, done: last < BATCH, direct: true, ro_before: roBefore.rows[0]?.transaction_read_only }
  } finally {
    await client.end().catch(() => {})
  }
}

export async function POST(request: Request) {
  const g = guardAdmin(request, { limit: 30, windowMs: 60_000, bucket: 'panel-tts-cleanup' })
  if (!g.ok) return g.res

  // Доп. операции восстановления после переполнения квоты (доки Supabase
  // «Disabling read-only mode»): alter-ro — постоянный выход из read-only для
  // новых сессий; vacuum — физическое сжатие файла БД (иначе размер в квоте
  // не падает и read-only вернётся); sizes — топ таблиц по размеру.
  const op = new URL(request.url).searchParams.get('op')

  if (op === 'alter-ro' || op === 'vacuum' || op === 'sizes' || op === 'disk') {
    const cs = directConnectionString()
    if (!cs) return NextResponse.json({ error: 'no DATABASE_URL/DIRECT_URL' }, { status: 500 })
    const u = new URL(cs)
    const client = new Client({
      host: u.hostname,
      port: Number(u.port || 5432),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, '') || 'postgres',
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 10_000,
      statement_timeout: op === 'vacuum' || op === 'disk' ? 55_000 : 25_000,
    })
    try {
      await client.connect()
      await client.query('SET default_transaction_read_only = off')
      if (op === 'disk') {
        // CHECKPOINT переименовывает/удаляет отработанные WAL-сегменты — на
        // забитом диске это часто единственный способ освободить место под
        // VACUUM FULL (которому нужна копия таблицы).
        const walBefore = await client
          .query<{ bytes: string }>('select coalesce(sum(size),0)::text as bytes from pg_ls_waldir()')
          .catch(() => ({ rows: [{ bytes: '-1' }] }))
        const filesBefore = await client
          .query<{ n: string }>('select count(*)::text as n from pg_ls_waldir()')
          .catch(() => ({ rows: [{ n: '-1' }] }))
        await client.query('checkpoint')
        const walAfter = await client
          .query<{ bytes: string }>('select coalesce(sum(size),0)::text as bytes from pg_ls_waldir()')
          .catch(() => ({ rows: [{ bytes: '-1' }] }))
        const filesAfter = await client
          .query<{ n: string }>('select count(*)::text as n from pg_ls_waldir()')
          .catch(() => ({ rows: [{ n: '-1' }] }))
        return NextResponse.json({
          ok: true,
          op,
          wal_before_mb: Math.round(Number(walBefore.rows[0]?.bytes ?? 0) / 1048576),
          wal_files_before: filesBefore.rows[0]?.n,
          wal_after_mb: Math.round(Number(walAfter.rows[0]?.bytes ?? 0) / 1048576),
          wal_files_after: filesAfter.rows[0]?.n,
          ...(await diagnostics()),
        })
      }
      if (op === 'alter-ro') {
        const dbname = await client.query<{ db: string }>('SELECT current_database() AS db')
        const name = dbname.rows[0]?.db ?? 'postgres'
        await client.query(`alter database "${name}" set default_transaction_read_only = off`)
        return NextResponse.json({ ok: true, op, altered_db: name, ...(await diagnostics()) })
      }
      if (op === 'vacuum') {
        // Чекпойнт перед full-вакуумом: освобождает WAL под копию таблицы.
        await client.query('checkpoint').catch(() => {})
        const r = await client.query('vacuum (full, analyze) "Post"')
        return NextResponse.json({ ok: true, op, command: r.command, ...(await diagnostics()) })
      }
      const sizes = await client.query<{ tbl: string; size: string }>(
        `select relname as tbl, pg_size_pretty(pg_total_relation_size(relid)) as size,
                pg_total_relation_size(relid) as bytes
         from pg_catalog.pg_statio_user_tables
         order by pg_total_relation_size(relid) desc limit 10`,
      )
      return NextResponse.json({ ok: true, op, tables: sizes.rows, ...(await diagnostics()) })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return NextResponse.json({ error: `op ${op} failed`, detail: msg.slice(0, 400), ...(await diagnostics()) }, { status: 500 })
    } finally {
      await client.end().catch(() => {})
    }
  }

  try {
    const res = await runRawCleanup()
    await logAdmin('tts-cleanup', 'posts.ttsAudio', { cleared: res.cleared, done: res.done })
    return NextResponse.json({ ok: true, ...res, ...(await diagnostics()) })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[panel/tts-cleanup]', msg)
    return NextResponse.json(
      { error: 'cleanup failed', detail: msg.slice(0, 400), ...(await diagnostics()) },
      { status: 500 },
    )
  }
}
