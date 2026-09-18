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
 *   getCustomEmojiStickers кладёт file_id анимации в таблицу CustomEmoji
 *   (кэш навсегда) → здесь file_id резолвится в CDN-URL.
 *
 * Два типа анимации:
 *   • video (webm)    → 302 прямо на CDN Telegram — <video> кэширует редирект.
 *   • lottie (.tgs)   → 302 на НАШ /api/media?u=… (gzip-JSON): прямые ссылки
 *     cdn*.telesco.pe у части пользователей заблокированы провайдерами, поэтому
 *     байты идут через прокси (кэш CDN Vercel 7 дней), а распаковывает gzip
 *     сам браузер (DecompressionStream) — сервер не гоняет JSON-тело.
 *
 * Кэширование CDN-ссылки (чтобы не дёргать ни БД, ни Bot API повторно):
 *   L0 память 10 мин → L1 Upstash Redis 40 мин (URL живёт ~1 час) →
 *   браузер кэширует 302 ещё 30 мин. Публичный эндпоинт: <img>/<video> не
 *   умеют Authorization — редирект кэшируется на клиенте.
 */
const URL_TTL_SEC = 40 * 60
const URL_MEM_TTL_MS = 10 * 60_000

export async function GET(
  request: Request,
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
        .findUnique({ where: { id }, select: { kind: true, fileId: true } })
        .catch(() => null)
      if (!row?.fileId) return null
      const cdn = await resolveTelegramFileUrl(row.fileId)
      if (!cdn) return null
      // Lottie: байты должны идти через наш медиа-прокси (недоступный напрямую
      // CDN + распаковка gzip на клиенте). URL прокси стабилен → кэшируется.
      if (row.kind === 'lottie') return `/api/media?u=${encodeURIComponent(cdn)}`
      return cdn
    },
  })

  if (!url) return new Response('not found', { status: 404 })

  // Относительный URL (прокси) → абсолютный для Response.redirect
  const target = url.startsWith('/') ? new URL(url, request.url).toString() : url
  return NextResponse.redirect(target, {
    status: 302,
    headers: { 'Cache-Control': 'public, max-age=1800' },
  })
}
