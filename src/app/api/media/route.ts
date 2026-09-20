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
  // Публичный эндпоинт — мягкий лимит на IP (медиа грузится пачками при скролле;
  // v5.58: 240→600/мин — за NAT оператора сидят десятки юзеров, каждая карточка
  // = аватар + фото + эмодзи через этот прокси)
  const ip = guardIp(request, { limit: 600, windowMs: 60_000, bucket: 'media' })
  if (!ip.ok) return ip.res

  const { searchParams } = new URL(request.url)
  const raw = searchParams.get('u')
  const asDownload = searchParams.get('dl') === '1'
  if (!raw || !isTrustedMediaUrl(raw)) {
    return new NextResponse('bad url', { status: 400 })
  }

  const range = request.headers.get('range') ?? undefined
  /*
   * v5.58 — СКОРОСТЬ («медиа не грузятся»): Telegram троттлит датацентровые
   * IP Vercel — холодный фетч файла висел 13-15с. Лечение слоями:
   *  1) Vercel-CDN-Cache-Control — офиц. хедер edge-кэша для динамических
   *     роутов (обычный s-maxage у force-dynamic Vercel срезает): файл из
   *     Telegram качается ОДИН раз в мире, дальше edge HIT ~30мс;
   *  2) таймаут соединения 15с → 9с + ОДИН тихий ретрай (медленный первый
   *     байт ≠ мёртвый файл, вторая попытка обычно мгновенна);
   *  3) парсер прогревает edge-кэш свежих медиа каждым тиком (parse-engine
   *     warmMedia) — юзеры почти не встречают холодный промах.
   *  Тело по-прежнему без лимита времени: видео/голосовые стримятся целиком,
   *  обрыв клиента отменяет докачку через request.signal.
   */
  const fetchUpstream = async (): Promise<Response> => {
    const connectAc = new AbortController()
    const connectTimer = setTimeout(() => connectAc.abort(), 9_000)
    try {
      return await fetch(raw, {
        headers: {
          // Telegram CDN отвечает и без браузерных заголовков, но валидный UA надёжнее
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          ...(range ? { Range: range } : {}),
        },
        signal: connectAc.signal,
      })
    } finally {
      clearTimeout(connectTimer)
    }
  }
  try {
    let upstream: Response
    try {
      upstream = await fetchUpstream()
    } catch {
      upstream = await fetchUpstream() // один тихий ретрай
    }

    if (!upstream.ok && upstream.status !== 206) {
      return new NextResponse('upstream error', { status: upstream.status === 404 ? 404 : 502 })
    }
    if (!upstream.body) return new NextResponse('empty', { status: 502 })

    // Клиент ушёл (закрыл вкладку/листнул дальше) — не качаем хвост у Telegram
    request.signal.addEventListener('abort', () => {
      upstream.body?.cancel().catch(() => {})
    })

    const headers = new Headers()
    const copy = (name: string) => {
      const v = upstream.headers.get(name)
      if (v) headers.set(name, v)
    }
    copy('content-type')
    copy('content-length')
    copy('content-range')
    headers.set('accept-ranges', 'bytes')
    // Скачивание: content-disposition — файл сохранится вместо показа
    if (asDownload) {
      const ext = (raw.split('.').pop() ?? 'jpg').split('?')[0].slice(0, 5).replace(/[^a-z0-9]/gi, '')
      headers.set('Content-Disposition', `attachment; filename="tgswipe-media.${ext || 'jpg'}"`)
    }
    // Кэш: браузер — 7 дней, CDN Vercel — 30 дней (медиа Telegram неизменяемо
    // по URL: file_id фиксирован, перезаписей нет) — повторные скроллы и
    // возвращения в приложение отдают картинки мгновенно из кэша.
    // v5.58: Vercel-CDN-Cache-Control — edge-кэш ДИНАМИЧЕСКОГО роута (проверено
    // замером: обычный s-maxage удалялся, x-vercel-cache: MISS на каждый запрос,
    // холодные 14с повторялись вечно). 206/Range на edge не кэшируем.
    headers.set(
      'Cache-Control',
      'public, max-age=604800, s-maxage=2592000, stale-while-revalidate=2592000, immutable',
    )
    if (upstream.status === 200 && !range) {
      headers.set('Vercel-CDN-Cache-Control', 'public, s-maxage=2592000, stale-while-revalidate=2592000')
    }

    return new NextResponse(upstream.body, { status: upstream.status, headers })
  } catch (e) {
    console.error('[media] proxy failed', (e as Error)?.message)
    return new NextResponse('proxy failed', { status: 502 })
  }
}
