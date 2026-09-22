import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { cacheAside } from '@/lib/redis'

export const dynamic = 'force-dynamic'

/**
 * GET /api/emoji/[id] — файл анимированного премиум-эмодзи Telegram.
 *
 * Пайплайн (см. src/components/feed/TelegramEmoji.tsx):
 *   парсер t.me/s извлекает custom_emoji_id из разметки постов → Bot API
 *   getCustomEmojiStickers кладёт file_id анимации в таблицу CustomEmoji
 *   (кэш навсегда) → здесь отдаём 302 на НАШ /api/media?fid=<file_id>.
 *
 * v5.95 — ФИКС УТЕЧКИ ТОКЕНА: раньше ответ резолвился в
 * api.telegram.org/file/bot<TOKEN>/… и уходил клиенту в Location (виден в
 * DevTools/кэшах/логах). Теперь клиент получает только наш прокси:
 * /api/media?fid=… сам делает getFile и качает байты сервер-сайд
 * (механика v5.80 для медиа постов — reused). Оба вида анимации:
 *   • video (webm) → /api/media?fid → video/webm (по расширению file_path)
 *   • lottie (.tgs) → /api/media?fid → application/octet-stream,
 *     gzip распаковывает браузер (DecompressionStream)
 *
 * Кэширование: L0 память 10 мин → Redis 40 мин (маркер «прокси существует»);
 * браузер кэширует 302 ещё 30 мин. Публичный эндпоинт: <img>/<video> не
 * умеют Authorization.
 */
const URL_TTL_SEC = 40 * 60
const URL_MEM_TTL_MS = 10 * 60_000

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  if (!/^\d{5,20}$/.test(id)) return new Response('bad id', { status: 400 })

  const target = await cacheAside({
    // v2: старый ключ держал токен-URL (теперь всегда наш fid-прокси);
    // старые записи умрут по TTL — читаем только из нового неймспейса
    key: `emoji:url:v2:${id}`,
    ttlSec: URL_TTL_SEC,
    memoryTtlMs: URL_MEM_TTL_MS,
    fetcher: async () => {
      const row = await db.customEmoji
        .findUnique({ where: { id }, select: { fileId: true } })
        .catch(() => null)
      // v5.95: ТОЛЬКО наш прокси (fid) — токен бота наружу не утекает
      if (!row?.fileId) return null
      return `/api/media?fid=${encodeURIComponent(row.fileId)}`
    },
  })

  if (!target) return new Response('not found', { status: 404 })

  const absolute = new URL(target, request.url).toString()
  return NextResponse.redirect(absolute, {
    status: 302,
    headers: { 'Cache-Control': 'public, max-age=1800' },
  })
}
