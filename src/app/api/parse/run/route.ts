import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { runParser } from '@/lib/parse-engine'
import { notifyNewPosts } from '@/lib/tg-bot'
import { guardAuth } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * POST /api/parse/run { perChannel? } — ручной запуск парсера из UI
 * (кнопки в админ-зоне AdminTab / ProfileTab).
 *
 * Защита: только авторизованный пользователь (Bearer-сессия); подмена userId
 * невозможна — идентификатор берётся из токена. Лимит 3 запуска в 5 минут.
 * После парсинга новые посты рассылаются подписчикам через Bot API.
 */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 3, windowMs: 5 * 60_000, bucket: 'parse-run' })
  if (!g.ok) return g.res

  try {
    const body = (await request.json().catch(() => ({}))) as { perChannel?: unknown; username?: unknown }
    const user = await db.user.findUnique({ where: { id: g.uid }, select: { id: true } })
    if (!user) return err('user not found', 404)

    const perChannel = typeof body?.perChannel === 'number' ? body.perChannel : 5
    // Опциональный одиночный канал (кнопка «парсить канал» в админ-зоне);
    // валидность username проверяет runParser (SSRF-защита)
    const username =
      typeof body?.username === 'string' && body.username.trim()
        ? body.username.trim().slice(0, 128)
        : undefined
    const result = await runParser(perChannel, username)

    let notified = { sent: 0, failed: 0, recipients: 0 }
    try {
      notified = await notifyNewPosts(result.newPosts)
    } catch (e) {
      console.error('[parse/run] notify failed', e)
    }

    return NextResponse.json({ ...result, notified })
  } catch (e) {
    console.error('[parse/run]', e)
    return err('parse failed', 500)
  }
}
