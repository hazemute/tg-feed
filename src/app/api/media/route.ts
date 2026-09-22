import { NextResponse } from 'next/server'
import { isTrustedMediaUrl } from '@/lib/media'
import { healMediaUrl, warmHealedMedia } from '@/lib/media-heal'
import { guardIp } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * GET /api/media?u=<https-url> — прокси медиа Telegram.
 *
 * Зачем: прямые ссылки cdn*.telesco.pe не открываются у части пользователей
 * (блокировка CDN Telegram на уровне провайдеров, в т.ч. РФ). Сервер
 * забирает файл сам и отдаёт клиенту. Ответ кэшируется CDN'ом Vercel
 * (Vercel-CDN-Cache-Control) — повторные запросы не доходят до функции.
 *
 * Безопасность: только https и только доверенные хосты Telegram
 * (telesco.pe / telegram.org) — SSRF и open-proxy исключены.
 *
 * v5.59 — САМОЛЕЧЕНИЕ: telesco-ссылки эфемерны (Telegram ротирует токены;
 * замер прода: 100% трендовых медиа 404). При мёртвом апстриме находим
 * владельца URL в БД, перезагружаем свежий embed t.me, обновляем БД и
 * отдаём свежие байты в этом же ответе (lib/media-heal.ts).
 *
 * v5.59 — СКОРОСТЬ: Telegram троттлит КАЖДОЕ соединение с датацентровых IP
 * (замер прода после хила: 37КБ = 15с, видео 261КБ не качалось и за 25с,
 * т.е. ~2-10КБ/с на соединение). Лечение — МУЛЬТИСОЕДИНЕНИЯ: файл качается
 * 3-8 параллельными Range-запросами (как aria2) → ×3-8 к скорости, затем
 * лежит в L0-кэше процесса и edge-кэше Vercel 30 дней.
 */

/**
 * Кэш ОШИБОК прокси (v5.71) — иначе одна протухшая telesco-ссылка «консервирует»
 * битое медиа на дни: браузер ≤60с, edge ≤300с — окно небольшое, самолечение
 * (heal) и ротация ссылок парсером успевают обновить URL.
 */
const MEDIA_ERR_CC = 'public, max-age=30, s-maxage=60, stale-while-revalidate=0'
const MEDIA_ERR_HEADERS: Record<string, string> = {
  'Cache-Control': MEDIA_ERR_CC,
  'Vercel-CDN-Cache-Control': 'public, s-maxage=60, stale-while-revalidate=0',
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** Порог параллельной докачки: файлы меньше качаются одним соединением */
const PARALLEL_MIN_BYTES = 96 * 1024

/* ------------------------------------------------------------------ */
/* v5.80 — РЕЖИМ fid: раздача медиа по file_id (channel_post бота).     */
/* Бот получает вечный file_id из поста канала; клиенту отдаём          */
/* /api/media?fid=... — здесь резолвим через Bot API getFile в file_path */
/* (живёт ≥1ч, кэш 40 мин) и качаем байты с api.telegram.org. Токен     */
/* бота наружу не утекает — клиент видит только наш прокси.             */
/* ------------------------------------------------------------------ */

const FID_CACHE_TTL_MS = 40 * 60_000
const fidPaths = new Map<string, { url: string; exp: number; type: string }>()
const FID_TYPE_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  pdf: 'application/pdf', zip: 'application/zip',
}

async function resolveFileIdUrl(fidRaw: string): Promise<{ url: string; type: string } | null> {
  const fid = fidRaw.trim()
  if (!fid || fid.length > 400 || /[\s\r\n]/.test(fid)) return null // file_id — однoстрочный base64url
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  if (!token) return null
  const hit = fidPaths.get(fid)
  if (hit && hit.exp > Date.now()) return { url: hit.url, type: hit.type }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getFile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fid }),
      signal: AbortSignal.timeout(8000),
    })
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean
      result?: { file_path?: string }
    } | null
    const path = data?.ok ? data.result?.file_path : null
    if (!path) return null
    const ext = (path.split('.').pop() ?? '').toLowerCase().slice(0, 5)
    const entry = {
      url: `https://api.telegram.org/file/bot${token}/${path}`,
      type: FID_TYPE_BY_EXT[ext] ?? 'application/octet-stream',
      exp: Date.now() + FID_CACHE_TTL_MS,
    }
    // LRU-гигиена: карта маленькая, но ограничим на всякий случай
    if (fidPaths.size > 2000) fidPaths.clear()
    fidPaths.set(fid, entry)
    return { url: entry.url, type: entry.type }
  } catch {
    return null
  }
}
/** Целевой размер одного диапазона (больше диапазонов — быстрее, но дороже) */
const RANGE_TARGET_BYTES = 768 * 1024
const RANGE_MIN_CONNECTIONS = 3
const RANGE_MAX_CONNECTIONS = 8
const RANGE_TIMEOUT_MS = 25_000

/* ------------------------------------------------------------------ */
/* v5.60 — СЖАТИЕ КАРТИНОК НА ЛЕТУ (sharp, lazy): w/q из query.         */
/* WebP вместо исходного JPEG = ×3-5 меньше байт — главное ускорение    */
/* на медленных каналах. Ресайз только ВНИЗ (withoutEnlargement),       */
/* только для image/*, только без Range. Результат — в L0/edge.         */
/* ------------------------------------------------------------------ */
async function resizeImageWebp(raw: Buffer, width: number, quality: number): Promise<{ buf: Buffer; type: string } | null> {
  try {
    const mod = (await import('sharp').catch(() => null)) as
      | { default: (b: Buffer) => any }
      | null
    if (!mod) return null
    const out = (await mod.default(raw)
      .rotate() // уважаем EXIF-ориентацию до ресайза
      .resize({ width, withoutEnlargement: true })
      .webp({ quality })
      .toBuffer()) as Buffer
    if (!out || out.length === 0 || out.length >= raw.length) return null // сжатие не состоялось — отдаём оригинал
    return { buf: out, type: 'image/webp' }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* L0-кэш байтов медиа: url → буфер (30 мин, кап 64МБ)                 */
/* Мгновенные 200/206 (перемотка видео) после первой докачки.          */
/* ------------------------------------------------------------------ */
type MediaBufEntry = { buf: Buffer; type: string; exp: number }
const mediaBufs = new Map<string, MediaBufEntry>()
const MEDIA_BUF_TTL_MS = 30 * 60_000
const MEDIA_BUF_MAX_BYTES = 64 * 1024 * 1024
let mediaBufBytes = 0

function mediaBufGet(key: string): MediaBufEntry | null {
  const hit = mediaBufs.get(key)
  if (hit && hit.exp > Date.now()) return hit
  if (hit) {
    mediaBufs.delete(key)
    mediaBufBytes -= hit.buf.length
  }
  return null
}

function mediaBufSet(key: string, buf: Buffer, type: string): void {
  const prev = mediaBufs.get(key)
  if (prev) {
    mediaBufBytes -= prev.buf.length
    mediaBufs.delete(key)
  }
  while (mediaBufBytes + buf.length > MEDIA_BUF_MAX_BYTES && mediaBufs.size > 0) {
    const first = mediaBufs.keys().next().value
    if (first === undefined) break
    const old = mediaBufs.get(first)
    mediaBufBytes -= old?.buf.length ?? 0
    mediaBufs.delete(first)
  }
  if (buf.length <= MEDIA_BUF_MAX_BYTES / 2) {
    mediaBufs.set(key, { buf, type, exp: Date.now() + MEDIA_BUF_TTL_MS })
    mediaBufBytes += buf.length
  }
}

/** Один Range-GET с тихим ретраем на свежем соединении */
async function fetchRange(url: string, start: number, end: number): Promise<Buffer | null> {
  const range = `bytes=${start}-${end}`
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': BROWSER_UA, Range: range },
        signal: AbortSignal.timeout(RANGE_TIMEOUT_MS),
      })
      if (res.ok || res.status === 206) {
        const buf = Buffer.from(await res.arrayBuffer())
        return buf
      }
      await res.body?.cancel().catch(() => {})
      return null // 4xx/5xx — ретрай соединением не лечит
    } catch {
      /* таймаут/обрыв — вторая попытка на новом соединении */
    }
  }
  return null
}

/**
 * Параллельная докачка файла диапазонами. null — если HEAD не дал размер
 * или хоть один диапазон не скачался (тогда вызывающий уходит в поток).
 */
async function fetchParallel(
  url: string,
): Promise<{ buf: Buffer; type: string } | null> {
  try {
    const head = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA, Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(6_000),
    })
    // telesco отдаёт 206 с Content-Range: bytes 0-0/<total>
    const total = Number(head.headers.get('content-range')?.split('/')[1] ?? NaN)
    const type = head.headers.get('content-type') ?? 'application/octet-stream'
    await head.body?.cancel().catch(() => {})
    if (!Number.isFinite(total) || total <= 0) return null
    if (total < PARALLEL_MIN_BYTES) return null // мелочь — одним соединением

    const connections = Math.min(
      RANGE_MAX_CONNECTIONS,
      Math.max(RANGE_MIN_CONNECTIONS, Math.ceil(total / RANGE_TARGET_BYTES)),
    )
    const chunk = Math.ceil(total / connections)
    const ranges: Array<{ start: number; end: number }> = []
    for (let i = 0; i < connections; i++) {
      const start = i * chunk
      const end = Math.min(total - 1, start + chunk - 1)
      if (start > end) break
      ranges.push({ start, end })
    }

    const parts = await Promise.all(ranges.map((r) => fetchRange(url, r.start, r.end)))
    if (parts.some((p) => p === null)) return null
    const buf = Buffer.concat(parts as Buffer[])
    if (buf.length !== total) return null
    return { buf, type }
  } catch {
    return null
  }
}

export async function GET(request: Request) {
  // Публичный эндпоинт — мягкий лимит на IP (медиа грузится пачками при скролле;
  // v5.58: 240→600/мин — за NAT оператора сидят десятки юзеров, каждая карточка
  // = аватар + фото + эмодзи через этот прокси)
  const ip = guardIp(request, { limit: 600, windowMs: 60_000, bucket: 'media' })
  if (!ip.ok) return ip.res

  const { searchParams } = new URL(request.url)
  let raw = searchParams.get('u')
  const asDownload = searchParams.get('dl') === '1'
  /* v5.60: параметры сжатия — w в [64..2048], q в [30..90]; без w — оригинал.
     ВАЖНО: clamp применяем только когда w реально передан (иначе фолбэк в 64
     сжимал бы «оригинал» до иконки — реальный баг первого запуска). */
  const wRaw = Number(searchParams.get('w')) || 0
  const wantW = wRaw > 0 ? Math.max(64, Math.min(2048, wRaw)) : 0
  const wantQ = Math.max(30, Math.min(90, Number(searchParams.get('q')) || 70))
  const resizeKey = wantW ? `w${wantW}q${wantQ}` : ''
  /* v5.80: режим fid — медиа поста канала по file_id (см. блок выше).
     Резолвим file_path заранее: дальше файл идёт по обычному конвейеру
     (L0 → параллельная докачка → стрим), как будто это обычный URL. */
  if (!raw && searchParams.get('fid')) {
    const resolved = await resolveFileIdUrl(searchParams.get('fid') ?? '')
    if (!resolved) {
      return new NextResponse('file not found', { status: 404, headers: MEDIA_ERR_HEADERS })
    }
    raw = resolved.url
  }
  if (!raw || !isTrustedMediaUrl(raw)) {
    return new NextResponse('bad url', {
      status: 400,
      headers: { 'Cache-Control': 'no-store', 'CDN-Cache-Control': 'no-store' },
    })
  }

  const range = request.headers.get('range') ?? undefined
  /* Целевой URL: после хила меняется на свежий (для докачки/логов/disposition) */
  let targetUrl = raw

  const fetchUpstream = async (target: string): Promise<Response> => {
    const connectAc = new AbortController()
    const connectTimer = setTimeout(() => connectAc.abort(), 9_000)
    try {
      return await fetch(target, {
        headers: {
          'User-Agent': BROWSER_UA,
          ...(range ? { Range: range } : {}),
        },
        signal: connectAc.signal,
      })
    } finally {
      clearTimeout(connectTimer)
    }
  }

  /** Успешный ответ байтами/стримом с долгим кэшем (v5.58) */
  const serveBuffer = (buf: Buffer, type: string, source: string): NextResponse => {
    const headers = new Headers()
    headers.set('content-type', type)
    headers.set('accept-ranges', 'bytes')
    if (asDownload) {
      const ext = (source.split('.').pop() ?? 'jpg').split('?')[0].slice(0, 5).replace(/[^a-z0-9]/gi, '')
      headers.set('Content-Disposition', `attachment; filename="tgswipe-media.${ext || 'jpg'}"`)
    }
    headers.set(
      'Cache-Control',
      'public, max-age=604800, s-maxage=2592000, stale-while-revalidate=2592000, immutable',
    )
    headers.set('Vercel-CDN-Cache-Control', 'public, s-maxage=2592000, stale-while-revalidate=2592000')
    return new NextResponse(new Uint8Array(buf), { status: 200, headers })
  }

  /** 206 из L0-буфера: перемотка видео без ожидания Telegram */
  const serveRangeFromBuffer = (entry: MediaBufEntry, range: string, source: string): NextResponse => {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range)
    let start = m?.[1] ? Number(m[1]) : 0
    let end = m?.[2] ? Number(m[2]) : entry.buf.length - 1
    if (!m || start >= entry.buf.length || (m[2] && end < start)) {
      return new NextResponse('range not satisfiable', {
        status: 416,
        headers: { 'content-range': `bytes */${entry.buf.length}` },
      })
    }
    start = Math.max(0, start)
    end = Math.min(entry.buf.length - 1, end)
    const slice = entry.buf.subarray(start, end + 1)
    const headers = new Headers()
    headers.set('content-type', entry.type)
    headers.set('accept-ranges', 'bytes')
    headers.set('content-range', `bytes ${start}-${end}/${entry.buf.length}`)
    headers.set('content-length', String(slice.length))
    headers.set('Cache-Control', 'public, max-age=604800')
    if (asDownload) {
      const ext = (source.split('.').pop() ?? 'jpg').split('?')[0].slice(0, 5).replace(/[^a-z0-9]/gi, '')
      headers.set('Content-Disposition', `attachment; filename="tgswipe-media.${ext || 'jpg'}"`)
    }
    return new NextResponse(new Uint8Array(slice), { status: 206, headers })
  }

  /** Обычный стрим (фолбэк и мелкие файлы) с долгим кэшем */
  const serveUpstream = async (upstream: Response, source: string): Promise<NextResponse> => {
    if (!upstream.ok && upstream.status !== 206) {
      // Ошибка апстрима (404/403/410 от Telegram = ротация токена) — КОРОТКИЙ
      // кэш (см. MEDIA_ERR_HEADERS): healed-URL мог появиться только что
      return new NextResponse('upstream error', {
        status: upstream.status === 404 ? 404 : 502,
        headers: MEDIA_ERR_HEADERS,
      })
    }
    if (!upstream.body) return new NextResponse('empty', { status: 502, headers: MEDIA_ERR_HEADERS })

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
    if (asDownload) {
      const ext = (source.split('.').pop() ?? 'jpg').split('?')[0].slice(0, 5).replace(/[^a-z0-9]/gi, '')
      headers.set('Content-Disposition', `attachment; filename="tgswipe-media.${ext || 'jpg'}"`)
    }
    headers.set(
      'Cache-Control',
      'public, max-age=604800, s-maxage=2592000, stale-while-revalidate=2592000, immutable',
    )
    if (upstream.status === 200 && !range) {
      headers.set('Vercel-CDN-Cache-Control', 'public, s-maxage=2592000, stale-while-revalidate=2592000')
    }
    return new NextResponse(upstream.body, { status: upstream.status, headers })
  }

  /**
   * v5.60 — отдача ПОЛНОСТЬЮ скачанного файла: при запросе w= сжимаем через
   * sharp в WebP (только вниз, только статичные картинки), кладём в L0 под
   * ключом с w/q и отдаём; иначе — оригинал как раньше (тоже в L0).
   */
  const serveResizedOrRaw = async (
    part: { buf: Buffer; type: string },
    source: string,
    fallbackType?: string,
  ): Promise<NextResponse> => {
    const type = part.type.startsWith('application/') ? (fallbackType ?? part.type) : part.type
    const resizable =
      resizeKey &&
      !asDownload &&
      /^image\/(jpe?g|png|webp|avif)/i.test(part.type) &&
      !/^image\/gif/i.test(part.type)
    if (resizable) {
      const resized = await resizeImageWebp(part.buf, wantW, wantQ)
      if (resized) {
        mediaBufSet(`${resizeKey}|${raw}`, resized.buf, resized.type)
        return serveBuffer(resized.buf, resized.type, source)
      }
    }
    mediaBufSet(raw, part.buf, part.type)
    return serveBuffer(part.buf, type, source)
  }

  try {
    // L0: буфер уже в процессе — 200/206 мгновенно (ключ включает сжатие)
    const cached = mediaBufGet(resizeKey ? `${resizeKey}|${raw}` : raw)
    if (cached) {
      return range ? serveRangeFromBuffer(cached, range, raw) : serveBuffer(cached.buf, cached.type, raw)
    }

    let upstream: Response | null = null
    try {
      upstream = await fetchUpstream(raw)
    } catch {
      upstream = await fetchUpstream(raw) // один тихий ретрай
    }

    // Мёртвый URL → лечение (один раз на файл, дальше edge-кэш 30 дней).
    // v5.71: + 410 Gone — Telegram отдаёт его на отозванных токенах.
    if (upstream.status === 404 || upstream.status === 403 || upstream.status === 410) {
      try {
        upstream.body?.cancel().catch(() => {})
      } catch {
        /* не критично */
      }
      const healed = await healMediaUrl(raw)
      if (healed?.url) {
        warmHealedMedia(healed.url) // прогрев edge для следующих запросов
        try {
          const fresh = await fetchUpstream(healed.url)
          if (fresh.ok || fresh.status === 206) {
            console.log(`[media] healed ${raw.slice(0, 80)} → ${healed.url.slice(0, 80)} (${healed.updated})`)
            // свежие байты — через ту же обработку, что и исходные
            upstream = fresh
            targetUrl = healed.url
          }
        } catch {
          /* свежий URL тоже не отдался — отдадим исходную ошибку ниже */
        }
      }
    }

    /*
     * v5.59 — МУЛЬТИСОЕДИНЕНИЯ: Telegram троттлит каждый коннект (~2-10КБ/с,
     * видео 261КБ не скачивалось и за 25с). Большие файлы качаем 3-8
     * параллельными Range-запросами и кладём в L0 — скорость ×3-8, повторные
     * загрузки и перемотка мгновенны. Range-запросы клиента НЕ мультируем
     * (браузер стримит метаданные видео), но отдаём из L0, если буфер есть.
     */
    if (!range) {
      const len = Number(upstream.headers.get('content-length') ?? NaN)
      const worthParallel = Number.isFinite(len) && len >= PARALLEL_MIN_BYTES
      if (worthParallel) {
        try {
          upstream.body?.cancel().catch(() => {})
        } catch {
          /* не критично */
        }
        const stitched = await fetchParallel(targetUrl)
        if (stitched) {
          return await serveResizedOrRaw(stitched, targetUrl)
        }
        // не сшлось — заново одним соединением (стрим)
        try {
          upstream = await fetchUpstream(targetUrl)
        } catch {
          return new NextResponse('proxy failed', { status: 502, headers: MEDIA_ERR_HEADERS })
        }
      } else if (upstream.status === 200 && len > 0 && len < PARALLEL_MIN_BYTES) {
        // Мелкий файл: забираем целиком в L0 — повторные запросы мгновенны
        try {
          const buf = Buffer.from(await upstream.arrayBuffer())
          const type = upstream.headers.get('content-type') ?? 'application/octet-stream'
          return await serveResizedOrRaw({ buf, type }, targetUrl)
        } catch {
          /* клиент ушёл — стрим уже не восстановить, отдадим ошибку */
          return new NextResponse('upstream error', { status: 502, headers: MEDIA_ERR_HEADERS })
        }
      }
    }

    return await serveUpstream(upstream, targetUrl)
  } catch (e) {
    console.error('[media] proxy failed', (e as Error)?.message)
    return new NextResponse('proxy failed', {
      status: 502,
      headers: { ...MEDIA_ERR_HEADERS, 'CDN-Cache-Control': 'no-store' },
    })
  }
}
