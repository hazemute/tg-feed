import { NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { db } from '@/lib/db'
import { err, APP_VERSION } from '@/lib/server'
import { guardIp } from '@/lib/guard'
import { botEnabled } from '@/lib/tg-bot'

export const dynamic = 'force-dynamic'

/**
 * POST /api/panel/login { key }
 * Локальная админ-панель: проверка статического ключа ADMIN_KEY.
 * Ответ 200 { ok: true, version, bot, db } | 401 (неверный ключ)
 * | 501 (ADMIN_KEY не задан на сервере). Лимит 10 попыток/мин/IP.
 */
export async function POST(request: Request) {
  // Лимит строго по IP — до проверки ключа (защита от перебора)
  const ip = guardIp(request, { limit: 10, windowMs: 60_000, bucket: 'panel-login' })
  if (!ip.ok) return ip.res

  const configured = process.env.ADMIN_KEY?.trim() ?? ''
  if (!configured) {
    return NextResponse.json(
      { error: 'ADMIN_KEY is not configured' },
      { status: 501 },
    )
  }

  let key = ''
  try {
    const body = (await request.json()) as { key?: unknown }
    if (typeof body?.key === 'string') key = body.key.trim()
  } catch {
    // тело не JSON — key останется пустым
  }

  const a = Buffer.from(key)
  const b = Buffer.from(configured)
  const valid = a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b)
  if (!valid) return err('invalid key', 401)

  let dbOk = false
  try {
    await db.$queryRaw`SELECT 1`
    dbOk = true
  } catch {
    dbOk = false
  }

  return NextResponse.json({
    ok: true,
    version: APP_VERSION,
    bot: botEnabled(),
    db: dbOk,
  })
}
