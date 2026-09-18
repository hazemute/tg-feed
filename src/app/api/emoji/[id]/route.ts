import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { resolveTelegramFileUrl } from '@/lib/tg-bot'
import { cacheAside } from '@/lib/redis'

export const dynamic = 'force-dynamic'

/**
 * GET /api/emoji/[id] — файл анимированного премиум-эмодзи Telegram.
 *
 * Пайплайн (см. src/components/feed/TelegramEmoji.tsx):
 *   парсер t.me/s извлекает custom_emoji_id из разметки постов → Bot API
 *   getCustomEmojiStickers кладёт file_id видео-стикера в таблицу CustomEmoji
 *   (кэш навсегда) → здесь file_id резолвится в CDN-URL.
 *
 * Кэширование CDN-ссылки (чтобы не дёргать ни БД, ни Bot API повторно):
 *   L0 память 10 мин → L1 Upstash Redis 40 мин (URL живёт ~1 час) →
 *   браузер кэширует 302 ещё 30 мин. Публичный эндпоинт: <img>/<video> не
 *   умеют Authorization — редирект кэшируется на клиенте.
 */
const URL_TTL_SEC = 40 * 60
const URL_MEM_TTL_MS = 10 * 60_000

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  if (!/^\d{5,20}$/.test(id)) return new Response('bad id', { status: 400 })

  const url = await cacheAside({
    key: `emoji:url:${id}`,
    ttlSec: URL_TTL_SEC,
    memoryTtlMs: URL_MEM_TTL_MS,
    fetcher: async () => {
      const row = await db.customEmoji
        .findUnique({ where: { id }, select: { fileId: true } })
        .catch(() => null)
      if (!row?.fileId) return null
      return resolveTelegramFileUrl(row.fileId)
    },
  })

  if (!url) return new Response('not found', { status: 404 })
  return NextResponse.redirect(url, {
    status: 302,
    headers: { 'Cache-Control': 'public, max-age=1800' },
  })
}
