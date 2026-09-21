import { NextResponse } from 'next/server'
import { guardAdmin } from '@/lib/guard'
import { directConnectionString, pgClientFromUrl } from '@/lib/pg-direct'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/panel/migrate — перенос данных со старого prod-БД (read-only,
 * диск full) на НОВЫЙ проект Supabase. Часть плана «А» восстановления после
 * исчерпания free-квоты: блобы уже вычищены (1043 поста), живых данных
 * десятки МБ — перенос идёт по PK-курсору батчами, идемпотентно
 * (ON CONFLICT DO NOTHING), повторные вызовы продолжают с lastPk.
 *
 * POST body: { target: "postgres://...", table: "Post", after?: "id" }
 * GET  ?op=counts — количество строк по всем таблицам источника.
 * POST { target, table: "__check" } — проверка связи с целевой БД.
 *
 * Порядок таблиц = FK-безопасный (родители раньше детей).
 * Доступ: x-admin-key.
 */
const TABLES: { name: string; pk: string }[] = [
  { name: 'User', pk: 'id' },
  { name: 'Category', pk: 'id' },
  { name: 'Channel', pk: 'id' },
  { name: 'Post', pk: 'id' },
  { name: 'Like', pk: 'id' },
  { name: 'PostView', pk: 'id' },
  { name: 'Subscription', pk: 'id' },
  { name: 'ChannelMute', pk: 'id' },
  { name: 'Bookmark', pk: 'id' },
  { name: 'Comment', pk: 'id' },
  { name: 'CommentLike', pk: 'id' },
  { name: 'Notification', pk: 'id' },
  { name: 'Upload', pk: 'id' },
  { name: 'AdvertiserAccount', pk: 'userId' },
  { name: 'Ad', pk: 'id' },
  { name: 'AdCampaign', pk: 'id' },
  { name: 'CampaignClick', pk: 'id' },
  { name: 'CampaignStat', pk: 'id' },
  { name: 'AdStat', pk: 'id' },
  { name: 'TranslationLog', pk: 'id' },
  { name: 'HashtagClick', pk: 'id' },
  { name: 'CustomEmoji', pk: 'id' },
  { name: 'PendingPayment', pk: 'id' },
  { name: 'AiSearchLog', pk: 'id' },
  { name: 'AdminLog', pk: 'id' },
  { name: 'LoginAttempt', pk: 'id' },
  { name: 'SupportThread', pk: 'id' },
  { name: 'SupportMessage', pk: 'id' },
  { name: 'SystemSetting', pk: 'key' },
  { name: 'BotEmoji', pk: 'slot' },
  { name: 'BotSetting', pk: 'key' },
]

const CHUNK = 300
const BUDGET_MS = 30_000

export async function GET(request: Request) {
  const g = guardAdmin(request, { limit: 240, windowMs: 60_000, bucket: 'panel-migrate' })
  if (!g.ok) return g.res

  const op = new URL(request.url).searchParams.get('op')
  const srcCs = directConnectionString()
  if (!srcCs) return NextResponse.json({ error: 'no DATABASE_URL/DIRECT_URL' }, { status: 500 })

  const client = pgClientFromUrl(srcCs)
  try {
    await client.connect()
    if (op === 'counts') {
      const counts: Record<string, number> = {}
      for (const t of TABLES) {
        try {
          const r = await client.query<{ n: string }>(`select count(*)::text as n from "${t.name}"`)
          counts[t.name] = Number(r.rows[0]?.n ?? 0)
        } catch {
          counts[t.name] = -1
        }
      }
      return NextResponse.json({ ok: true, counts })
    }
    return NextResponse.json({ ok: true, tables: TABLES.map((t) => t.name) })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message.slice(0, 300) : String(e) }, { status: 500 })
  } finally {
    await client.end().catch(() => {})
  }
}

export async function POST(request: Request) {
  const g = guardAdmin(request, { limit: 240, windowMs: 60_000, bucket: 'panel-migrate' })
  if (!g.ok) return g.res

  let body: { target?: string; table?: string; after?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 })
  }
  const target = body.target
  const table = body.table
  if (!target || !table) return NextResponse.json({ error: 'target and table required' }, { status: 400 })

  const srcCs = directConnectionString()
  if (!srcCs) return NextResponse.json({ error: 'no DATABASE_URL/DIRECT_URL' }, { status: 500 })

  // __check — только связь с целевой БД
  if (table === '__check') {
    const client = pgClientFromUrl(target)
    try {
      await client.connect()
      const v = await client.query<{ v: string }>('select version() as v')
      const db = await client.query<{ d: string }>('select current_database() as d')
      return NextResponse.json({ ok: true, db: db.rows[0]?.d, version: (v.rows[0]?.v ?? '').slice(0, 60) })
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message.slice(0, 300) : String(e) }, { status: 500 })
    } finally {
      await client.end().catch(() => {})
    }
  }

  const meta = TABLES.find((t) => t.name === table)
  if (!meta) return NextResponse.json({ error: `unknown table ${table}` }, { status: 400 })

  const src = pgClientFromUrl(srcCs)
  const dst = pgClientFromUrl(target)
  try {
    await src.connect()
    await dst.connect()
    const t0 = Date.now()
    let after = body.after ?? ''
    let copied = 0
    let last = after
    let fetched = 0

    for (;;) {
      const rows = await src.query(
        `select * from "${meta.name}" where "${meta.pk}" > $1 order by "${meta.pk}" limit ${CHUNK}`,
        [after],
      )
      fetched = rows.rows.length
      if (fetched === 0) break
      const cols = rows.fields.map((f) => f.name)
      const colList = cols.map((c) => `"${c}"`).join(',')
      // вставляем частями по 100 строк (лимит параметров 65535)
      for (let i = 0; i < fetched; i += 100) {
        const slice = rows.rows.slice(i, i + 100)
        const values: unknown[] = []
        const tuples = slice.map((row, ri) => {
          const ph = cols.map((c, ci) => {
            values.push(row[c])
            return `$${ri * cols.length + ci + 1}`
          })
          return `(${ph.join(',')})`
        })
        await dst.query(
          `insert into "${meta.name}" (${colList}) values ${tuples.join(',')} on conflict ("${meta.pk}") do nothing`,
          values,
        )
      }
      copied += fetched
      after = String(rows.rows[fetched - 1][meta.pk])
      last = after
      if (Date.now() - t0 > BUDGET_MS) break
    }

    const done = fetched < CHUNK
    return NextResponse.json({ ok: true, table, copied, last, done })
  } catch (e) {
    return NextResponse.json(
      { error: `migrate ${table} failed`, detail: e instanceof Error ? e.message.slice(0, 300) : String(e) },
      { status: 500 },
    )
  } finally {
    await src.end().catch(() => {})
    await dst.end().catch(() => {})
  }
}
