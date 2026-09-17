import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { resolveTelegramFileUrl } from '@/lib/tg-bot'

export const dynamic = 'force-dynamic'

/**
 * GET /api/emoji/[id] — файл анимированного премиум-эмодзи Telegram.
 *
 * Парсер при разметке постов резолвит custom_emoji_id через Bot API
 * (getCustomEmojiStickers) и складывает file_id видео-стикера в CustomEmoji.
 * Здесь отдаём 302 на CDN Telegram (URL резолвится через L0-кэш tg-bot).
 * Публичный эндпоинт: <img>/<video> не умеют Authorization — браузер кэширует
 * редирект (max-age 30 мин), повторные показы не трогают ни БД, ни Bot API.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  if (!/^\d{5,20}$/.test(id)) return new Response('bad id', { status: 400 })

  const row = await db.customEmoji
    .findUnique({ where: { id }, select: { fileId: true, kind: true } })
    .catch(() => null)
  if (!row?.fileId) return new Response('not found', { status: 404 })

  const url = await resolveTelegramFileUrl(row.fileId)
  if (!url) return new Response('unresolved', { status: 502 })

  return NextResponse.redirect(url, {
    status: 302,
    headers: { 'Cache-Control': 'public, max-age=1800' },
  })
}
