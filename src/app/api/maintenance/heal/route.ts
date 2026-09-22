import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { checkSchema, MIGRATIONS } from '@/lib/ensure-schema'

export const dynamic = 'force-dynamic'

/**
 * ОДНОРАЗОВЫЙ диагностический прогон commerce-миграции (v5.98-commerce).
 *
 * Контекст: на проде 4 объекта (User.balanceStars, Sponsor, AdSlot, Blacklist)
 * стабильно «missing» — health-самолечение гоняет полный цикл каждый вызов,
 * но стейтменты падают, а runtime-логи Vercel недоступны. Эндпоинт выполняет
 * КАЖДЫЙ стейтмент миграции по отдельности и возвращает его ошибку — причина
 * становится видимой, идемпотентные стейтменты при этом накатываются.
 *
 * Защита: x-heal-key === TELEGRAM_BOT_TOKEN (общий секрет инстанса).
 * УДАЛИТЬ после диагностики.
 */
export async function POST(request: Request) {
  const key = (request.headers.get('x-heal-key') ?? '').trim()
  const expected = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? ''
  if (!expected || key !== expected) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const before = await checkSchema()
  const stmts = MIGRATIONS['v5.98-commerce'] ?? []
  const results: Array<{ sql: string; ok: boolean; err?: string }> = []
  let applied = 0
  for (const sql of stmts) {
    try {
      await db.$executeRawUnsafe(sql)
      applied++
      results.push({ sql: sql.slice(0, 90), ok: true })
    } catch (e) {
      results.push({ sql: sql.slice(0, 90), ok: false, err: (e as Error).message.slice(0, 300) })
    }
  }
  const after = await checkSchema()
  return NextResponse.json({ before, applied, results, after })
}
