import { NextResponse } from 'next/server'
import { isTrustedMediaUrl } from '@/lib/media'
import { guardIp } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * GET /api/media?u=<https-url> — прокси медиа Telegram.
 *
 * Зачем: прямые ссылки cdn*.telesco.pe не открываются у части пользователей
 * (блокировка CDN Telegram на уровне провайдеров, в т.ч. РФ). Сервер
 * забирает файл сам и отдаёт клиенту. Ответ кэшируется CDN'ом Vercel
 * (s-maxage) — повторные запросы не доходят до функции.
 *
 * Безопасность: только https и только доверенные хосты Telegram
 * (telesco.pe / telegram.org) — SSRF и open-proxy исключены.
 * Range-запросы пробрасываются (перемотка видео/аудио работает).
 */
export async function GET(request: Request) {
  // Публичный эндпоинт — мягкий лимит на IP (медиа грузится пачками при скролле)
  const ip = guardIp(request, { limit: 240, windowMs: 60_000, bucket: 'media' })
  if (!ip.ok) return ip.res

  const { searchParams } = new URL(request.url)
  const raw = searchParams.get('u')
  if (!raw || !isTrustedMediaUrl(raw)) {
    return new NextResponse('bad url', { status: 400 })
  }

  const range = request.headers.get('range') ?? undefined
  try {
    const upstream = await fetch(raw, {
      headers: {
        // Telegram CDN отвечает и без браузерных заголовков, но валидный UA надёжнее
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        ...(range ? { Range: range } : {}),
      },
      signal: AbortSignal.timeout(25_000),
    })

    if (!upstream.ok && upstream.status !== 206) {
      return new NextResponse('upstream error', { status: upstream.status === 404 ? 404 : 502 })
    }
    if (!upstream.body) return new NextResponse('empty', { status: 502 })

    const headers = new Headers()
    const copy = (name: string) => {
      const v = upstream.headers.get(name)
      if (v) headers.set(name, v)
    }
    copy('content-type')
    copy('content-length')
    copy('content-range')
    headers.set('accept-ranges', 'bytes')
    // Кэш: браузер — сутки, CDN Vercel — 7 дней (медиа Telegram неизменяемо по URL)
    headers.set(
      'Cache-Control',
      'public, max-age=86400, s-maxage=604800, stale-while-revalidate=2592000',
    )

    return new NextResponse(upstream.body, { status: upstream.status, headers })
  } catch (e) {
    console.error('[media] proxy failed', (e as Error)?.message)
    return new NextResponse('proxy failed', { status: 502 })
  }
}
