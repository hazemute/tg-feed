import { ImageResponse } from 'next/og'
import type { ReactNode } from 'react'
import { db } from '@/lib/db'
import { guardPublic } from '@/lib/guard'
import { isTrustedMediaUrl } from '@/lib/media'
import { resolveTelegramFileUrl } from '@/lib/tg-bot'
import { blocksOf, type Block, type Span } from '@/lib/markdown'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/story?id=<postId> — картинка поста для Telegram Stories v2.
 *
 * Запрос владельца («сделай историю намного красивее»):
 *  - РЕАЛЬНАЯ аватарка канала (Storage/tgfile → data URI), не инициалы;
 *  - markdown текста: жирный/курсив/зачёркнутый/подчёркнутый, `код`,
 *    цитаты, списки, ссылки (цветом) — как в приложении;
 *  - МЕДИА ПОСТА в истории: фото (и постер видео) — большой скруглённый блок;
 *  - виджет подписки: widget_link ведёт на канал владельца t.me/SnapTeamDev
 *    (Telegram рисует под сторис кликабельную плашку «Подписаться»),
 *    в самой картинке внизу — плашка «Подписаться на SnapTeam».
 *
 * Формат 9:16 (1080×1920). Публичный GET (Telegram-клиент не умеет
 * Authorization) + exemption от техработ; картинка неизменяема для поста —
 * агрессивный Cache-Control. Внешних шрифтов нет (satori): всё на дефолтном
 * Noto Sans, картинки встраиваются base64 data URI.
 */

const ID_RE = /^[a-zA-Z0-9_-]{5,40}$/

/** Ссылка на канал владельца для виджета подписки (запрос владельца) */
const WIDGET_CHANNEL_URL = 'https://t.me/SnapTeamDev'

/* ------------------------------------------------------------------ */
/* Загрузка картинок (аватар / медиа) в data URI для satori            */
/* ------------------------------------------------------------------ */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const STORAGE_HOST = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').hostname || null
  } catch {
    return null
  }
})()

/** Доверенный https-URL картинки: Telegram-CDN или наш Supabase Storage */
function isTrustedImageUrl(raw: string): boolean {
  if (!raw.startsWith('https://')) return false
  if (isTrustedMediaUrl(raw)) return true
  if (!STORAGE_HOST) return false
  try {
    return new URL(raw).hostname === STORAGE_HOST
  } catch {
    return false
  }
}

/** https/tgfile → base64 data URI (satori не умеет ни внешние ссылки, ни tgfile) */
async function toDataUri(raw: string | null | undefined, timeoutMs = 8_000): Promise<string | null> {
  if (!raw) return null
  try {
    let target = raw
    if (target.startsWith('tgfile:')) {
      const resolved = await resolveTelegramFileUrl(target.slice('tgfile:'.length))
      if (!resolved) return null
      target = resolved
    }
    if (!isTrustedImageUrl(target)) return null
    const res = await fetch(target, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const type = (res.headers.get('content-type') ?? '').split(';')[0]
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(type)) return null
    const buf = Buffer.from(await res.arrayBuffer())
    // satori/резайзер не тянет огромные вложения — пропускаем слишком тяжёлые
    if (buf.byteLength < 512 || buf.byteLength > 4_500_000) return null
    return `data:${type};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* Текст: markdown → JSX (блочно, с бюджетом по длине)                */
/* ------------------------------------------------------------------ */

/** Плоская длина спана (для честного бюджета символов) */
function spanLen(s: Span): number {
  switch (s.t) {
    case 'emoji':
      return 2
    case 'code':
      return s.v.length
    case 'link':
      return s.v.length
    case 'plain':
      return s.v.length
    default:
      return s.v.length
  }
}

/** Плоский текст спанов (для среза гигантского первого абзаца) */
function spansToPlain(spans: Span[]): string {
  return spans.map((s) => (s.t === 'emoji' ? '' : s.v)).join('')
}

function blockLen(b: Block): number {
  const sum = (spans: Span[]) => spans.reduce((acc, s) => acc + spanLen(s), 0)
  switch (b.type) {
    case 'p':
    case 'heading':
      return sum(b.spans)
    case 'quote':
      return sum(b.spans)
    case 'code':
      return b.v.length
    case 'list':
      return b.items.reduce((acc, it) => acc + sum(it) + 2, 0)
    case 'todo':
      return b.items.reduce((acc, it) => acc + sum(it.spans) + 3, 0)
    case 'table':
      return b.rows.reduce((acc, r) => acc + r.reduce((a, c) => a + sum(c) + 3, 0), 0)
    case 'hr':
      return 1
  }
}

/** Спаны → JSX (внутри жирного/ссылки могут быть свои спаны) */
function renderSpans(spans: Span[], keyBase: string): ReactNode[] {
  return spans.map((s, i) => {
    const key = `${keyBase}-${i}`
    switch (s.t) {
      case 'plain':
        return s.v
      case 'bold':
        return (
          <span key={key} style={{ fontWeight: 700, color: '#FFFFFF' }}>
            {s.kids ? renderSpans(s.kids, key) : s.v}
          </span>
        )
      case 'italic':
        return (
          <span key={key} style={{ fontStyle: 'italic', color: '#F2F5F9' }}>
            {s.kids ? renderSpans(s.kids, key) : s.v}
          </span>
        )
      case 'strike':
        return (
          <span key={key} style={{ textDecoration: 'line-through', color: 'rgba(255,255,255,0.55)' }}>
            {s.kids ? renderSpans(s.kids, key) : s.v}
          </span>
        )
      case 'underline':
        return (
          <span key={key} style={{ textDecoration: 'underline', color: '#F2F5F9' }}>
            {s.kids ? renderSpans(s.kids, key) : s.v}
          </span>
        )
      case 'code':
        return (
          <span
            key={key}
            style={{
              fontFamily: 'monospace',
              fontSize: '0.88em',
              color: '#8AD5FF',
              backgroundColor: 'rgba(120,190,255,0.14)',
              borderRadius: 10,
              padding: '2px 12px',
            }}
          >
            {s.v}
          </span>
        )
      case 'spoiler':
        return (
          <span key={key} style={{ color: 'rgba(255,255,255,0.5)', backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 8, padding: '2px 10px' }}>
            {s.kids ? renderSpans(s.kids, key) : s.v}
          </span>
        )
      case 'link':
        return (
          <span key={key} style={{ color: '#7CC0FF', textDecoration: 'underline' }}>
            {s.kids ? renderSpans(s.kids, key) : s.v}
          </span>
        )
      case 'emoji':
        return null // премиум-эмодзи в статичной картинке не рендерим
    }
  })
}

/** Блок markdown → JSX-блоки сторис */
function renderBlock(b: Block, key: string, bodySize: number): ReactNode | null {
  switch (b.type) {
    case 'p':
      return (
        <div key={key} style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap' }}>
          {renderSpans(b.spans, key)}
        </div>
      )
    case 'heading':
      return (
        <div key={key} style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', fontWeight: 800, fontSize: bodySize + 6, color: '#FFFFFF' }}>
          {renderSpans(b.spans, key)}
        </div>
      )
    case 'quote':
      return (
        <div
          key={key}
          style={{
            display: 'flex',
            flexDirection: 'row',
            flexWrap: 'wrap',
            paddingLeft: 22,
            borderLeft: '5px solid rgba(122,196,255,0.75)',
            color: 'rgba(240,246,252,0.82)',
            fontStyle: 'italic',
          }}
        >
          {renderSpans(b.spans, key)}
        </div>
      )
    case 'code':
      return (
        <div
          key={key}
          style={{
            display: 'flex',
            fontFamily: 'monospace',
            fontSize: bodySize - 6,
            lineHeight: 1.5,
            color: '#9EE6A8',
            backgroundColor: 'rgba(255,255,255,0.07)',
            borderRadius: 18,
            padding: '18px 22px',
          }}
        >
          {b.v.length > 400 ? `${b.v.slice(0, 400)}…` : b.v}
        </div>
      )
    case 'list':
      return (
        <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {b.items.map((it, i) => (
            <div key={`${key}-${i}`} style={{ display: 'flex', flexDirection: 'row', gap: 12 }}>
              <span style={{ color: '#7CC0FF', fontWeight: 700 }}>{b.ordered ? `${b.start + i}.` : '•'}</span>
              <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', flex: 1 }}>{renderSpans(it, `${key}-${i}`)}</div>
            </div>
          ))}
        </div>
      )
    case 'todo':
      return (
        <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {b.items.map((it, i) => (
            <div key={`${key}-${i}`} style={{ display: 'flex', flexDirection: 'row', gap: 12 }}>
              <span style={{ color: it.done ? '#63D68B' : 'rgba(255,255,255,0.5)' }}>{it.done ? '☑' : '☐'}</span>
              <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', flex: 1, color: it.done ? 'rgba(255,255,255,0.55)' : '#F2F5F9' }}>
                {renderSpans(it.spans, `${key}-${i}`)}
              </div>
            </div>
          ))}
        </div>
      )
    case 'table':
      return (
        <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {b.rows.slice(0, 4).map((r, i) => (
            <div key={`${key}-${i}`} style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap' }}>
              {r.map((c, j) => (
                <span key={`${key}-${i}-${j}`} style={{ color: 'rgba(240,246,252,0.85)' }}>
                  {renderSpans(c, `${key}-${i}-${j}`)}
                  {j < r.length - 1 ? '  ·  ' : ''}
                </span>
              ))}
            </div>
          ))}
        </div>
      )
    case 'hr':
      return (
        <div key={key} style={{ display: 'flex', height: 2, backgroundColor: 'rgba(255,255,255,0.14)', borderRadius: 2 }} />
      )
    default:
      return null
  }
}

/* ------------------------------------------------------------------ */
/* Роут                                                                */
/* ------------------------------------------------------------------ */

function initialsOf(title: string): string {
  const words = (title || 'T').trim().split(/\s+/)
  return words.length >= 2
    ? (words[0].charAt(0) + words[1].charAt(0)).toUpperCase()
    : words[0].slice(0, 2).toUpperCase()
}

export async function GET(request: Request) {
  const g = guardPublic(request, { limit: 30, windowMs: 60_000, bucket: 'story' })
  if (!g.ok) return g.res

  const id = new URL(request.url).searchParams.get('id') ?? ''
  if (!ID_RE.test(id)) return new Response('bad id', { status: 400 })

  const post = await db.post.findUnique({
    where: { id },
    select: {
      text: true,
      mediaUrl: true,
      mediaType: true,
      mediaMeta: true,
      gallery: true,
      likesCount: true,
      viewsCount: true,
      viewsTg: true,
      publishedAt: true,
      channel: {
        select: { id: true, title: true, username: true, verified: true, avatarColor: true, avatarUrl: true, photoFileId: true },
      },
    },
  })
  if (!post) return new Response('not found', { status: 404 })

  const ch = post.channel
  const title = ch.title
  const accent = ch.avatarColor || '#3390ec'
  const views = post.viewsTg ?? post.viewsCount

  /* Картинки: аватар канала + первое фото/постер (параллельно, best-effort) */
  const [avatarUri, mediaUri] = await Promise.all([
    toDataUri(ch.avatarUrl ?? (ch.photoFileId ? `tgfile:${ch.photoFileId}` : null)),
    (async () => {
      // Кандидаты: фото → постер видео/гиф → картинки галереи → постеры галереи
      let meta: { poster?: string; url?: string } | null = null
      try {
        meta = post.mediaMeta ? (JSON.parse(post.mediaMeta) as { poster?: string; url?: string }) : null
      } catch {
        meta = null
      }
      let gallery: { kind?: string; url?: string; poster?: string }[] = []
      try {
        const g = post.gallery ? JSON.parse(post.gallery) : []
        if (Array.isArray(g)) gallery = g.slice(0, 8)
      } catch {
        gallery = []
      }
      const candidates: (string | null | undefined)[] = []
      if (post.mediaType === 'image' || post.mediaType === 'sticker') candidates.push(post.mediaUrl)
      if (post.mediaType === 'video' || post.mediaType === 'gif') candidates.push(meta?.poster ?? post.mediaUrl)
      for (const it of gallery) if (!it.kind || it.kind === 'image') candidates.push(it.url)
      for (const it of gallery) candidates.push(it.poster)
      for (const c of candidates) {
        const uri = await toDataUri(c)
        if (uri) return uri
      }
      return null
    })(),
  ])

  /* Текст: markdown-блоки с бюджетом по символам (сторис должна быть читаемой) */
  const CHAR_BUDGET = 560
  const blocks = blocksOf(post.text)

  // Проход 1: отбор блоков под бюджет символов (блочная нарезка без обрыва строки)
  const chosen: Block[] = []
  let used = 0
  let truncated = false
  for (let i = 0; i < blocks.length && chosen.length < 9; i++) {
    const b = blocks[i]
    const len = blockLen(b)
    if (used > 0 && used + len > CHAR_BUDGET) {
      truncated = true
      break
    }
    if (used === 0 && len > CHAR_BUDGET) {
      // Гигантский первый блок: плоский срез по бюджету — карточка не переполнится
      const spans = b.type === 'p' || b.type === 'heading' || b.type === 'quote' ? b.spans : null
      const raw = spans ? spansToPlain(spans) : b.type === 'code' ? b.v : ''
      if (raw) {
        const cut = `${raw.slice(0, CHAR_BUDGET).replace(/\s+\S*$/, '')}…`
        chosen.push({ type: 'p', spans: [{ t: 'plain', v: cut }] })
        used = CHAR_BUDGET
        truncated = true
        break
      }
    }
    chosen.push(b)
    used += len
  }
  if (!truncated && blocks.length > chosen.length) truncated = true

  const bodySize = used > 420 ? 34 : used > 260 ? 38 : used > 120 ? 42 : 46
  // Медиа сжимается, когда текста много — центр сторис не должен наползать на CTA
  const mediaH = !mediaUri ? 0 : used > 420 ? 360 : used > 260 ? 430 : 500

  // Проход 2: рендер выбранных блоков уже с известным кеглем
  const shown = chosen
    .map((b, i) => renderBlock(b, `b${i}`, bodySize))
    .filter((n): n is ReactNode => n !== null)

  if (shown.length === 0 && post.text.trim()) {
    // парсер вернул пустоту (редкий мусор) — плоский фолбэк
    const flat = post.text.replace(/\s+/g, ' ').trim().slice(0, CHAR_BUDGET)
    shown.push(
      <div key="flat" style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap' }}>
        {flat}
      </div>,
    )
  }
  if (shown.length === 0) truncated = false
  const dateStr = new Date(post.publishedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '72px 70px',
          backgroundImage:
            'radial-gradient(900px 520px at 12% -6%, rgba(64,140,205,0.42) 0%, rgba(64,140,205,0) 60%),' +
            'radial-gradient(760px 480px at 108% 26%, rgba(146,90,205,0.30) 0%, rgba(146,90,205,0) 58%),' +
            'linear-gradient(165deg, #16222F 0%, #0C141D 55%, #101B27 100%)',
        }}
      >
        {/* фоновая окружность-декор */}
        <div
          style={{
            position: 'absolute',
            top: -180,
            right: -140,
            width: 560,
            height: 560,
            borderRadius: 9999,
            backgroundImage: 'radial-gradient(circle at 50% 50%, rgba(90,160,220,0.20) 0%, rgba(90,160,220,0) 70%)',
            display: 'flex',
          }}
        />

        {/* Шапка: бренд */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            <div
              style={{
                width: 62,
                height: 62,
                borderRadius: 20,
                background: 'linear-gradient(135deg, #62BCF9, #2AABEE)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 34,
                fontWeight: 800,
                color: '#fff',
              }}
            >
              S
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontSize: 32, fontWeight: 700, color: '#fff' }}>Tg Swipe</div>
              <div style={{ fontSize: 21, color: 'rgba(255,255,255,0.55)' }}>лента Telegram-каналов</div>
            </div>
          </div>
          <div style={{ fontSize: 22, color: 'rgba(255,255,255,0.4)' }}>@tgswipe_bot</div>
        </div>

        {/* Центр: канал + медиа + текст */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 30,
            flex: 1,
            justifyContent: 'center',
          }}
        >
          {/* Канал: реальная аватарка в градиентном кольце (язык сторис) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
            <div
              style={{
                width: 108,
                height: 108,
                borderRadius: 9999,
                padding: 5,
                backgroundImage: 'linear-gradient(135deg, #62BCF9, #9A6BF3, #F0616D)',
                display: 'flex',
              }}
            >
              {avatarUri ? (
                <img
                  src={avatarUri}
                  width={98}
                  height={98}
                  style={{ borderRadius: 9999, objectFit: 'cover' }}
                  alt=""
                />
              ) : (
                <div
                  style={{
                    width: 98,
                    height: 98,
                    borderRadius: 9999,
                    backgroundColor: accent,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 38,
                    fontWeight: 700,
                    color: '#fff',
                  }}
                >
                  {initialsOf(title)}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 38, fontWeight: 700, color: '#fff' }}>{title.length > 22 ? `${title.slice(0, 22)}…` : title}</span>
                {ch.verified && (
                  <span
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 34,
                      height: 34,
                      borderRadius: 9999,
                      backgroundColor: '#3390ec',
                      color: '#fff',
                      fontSize: 20,
                      fontWeight: 800,
                    }}
                  >
                    ✓
                  </span>
                )}
              </div>
              <div style={{ fontSize: 23, color: 'rgba(255,255,255,0.5)' }}>
                {ch.username ? `@${ch.username}` : 'Telegram'}
              </div>
            </div>
          </div>

          {/* Медиа поста: фото или постер видео — большой скруглённый блок.
              satori не клипает <img> контейнером (overflow:hidden игнорируется),
              поэтому радиус и рамка — прямо на <img>. */}
          {mediaUri && (
            <img
              src={mediaUri}
              width={940}
              height={mediaH}
              style={{
                width: '100%',
                height: mediaH,
                objectFit: 'cover',
                borderRadius: 34,
                border: '1px solid rgba(255,255,255,0.12)',
              }}
              alt=""
            />
          )}

          {/* Текст поста: markdown */}
          {shown.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 20,
                padding: 40,
                borderRadius: 34,
                backgroundColor: 'rgba(255,255,255,0.055)',
                border: '1px solid rgba(255,255,255,0.09)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 18,
                  fontSize: bodySize,
                  lineHeight: 1.4,
                  color: '#F5F7FA',
                }}
              >
                {shown}
              </div>
              {truncated && (
                <div style={{ display: 'flex', fontSize: 26, fontWeight: 600, color: 'rgba(255,255,255,0.45)' }}>
                  … читать дальше в приложении
                </div>
              )}
            </div>
          )}

          {/* Статистика */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 28, fontSize: 25, color: 'rgba(255,255,255,0.55)' }}>
            <span style={{ display: 'flex', color: '#F0616D' }}>♥ {post.likesCount}</span>
            <span style={{ display: 'flex', color: 'rgba(255,255,255,0.35)' }}>·</span>
            <span style={{ display: 'flex' }}>{views > 0 ? `${views.toLocaleString('ru-RU')} просмотров` : dateStr}</span>
          </div>
        </div>

        {/* Низ: CTA приложения + виджет подписки на канал владельца */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '28px 38px',
              borderRadius: 28,
              background: 'linear-gradient(135deg, #2AABEE, #1E86C7)',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 33, fontWeight: 700, color: '#fff' }}>Читать в Tg Swipe</div>
              <div style={{ fontSize: 22, color: 'rgba(255,255,255,0.8)' }}>свайпы · переводы · саммари</div>
            </div>
            <div
              style={{
                display: 'flex',
                padding: '13px 28px',
                borderRadius: 18,
                backgroundColor: 'rgba(255,255,255,0.18)',
                fontSize: 27,
                fontWeight: 700,
                color: '#fff',
              }}
            >
              Открыть
            </div>
          </div>

          {/* Виджет подписки: канал владельца — кликабелен и в картинке (текст), и плашкой Telegram */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '22px 38px',
              borderRadius: 28,
              backgroundColor: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.12)',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: 27, fontWeight: 700, color: '#fff' }}>Подписывайтесь на SnapTeam</div>
              <div style={{ fontSize: 21, color: 'rgba(255,255,255,0.6)' }}>апдейки и новые фичи Tg Swipe</div>
            </div>
            <div
              style={{
                display: 'flex',
                padding: '12px 26px',
                borderRadius: 18,
                backgroundColor: '#fff',
                fontSize: 24,
                fontWeight: 800,
                color: '#0C141D',
              }}
            >
              Подписаться
            </div>
          </div>
        </div>
      </div>
    ),
    {
      width: 1080,
      height: 1920,
      headers: {
        'Cache-Control': 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800',
      },
    },
  )
}

void WIDGET_CHANNEL_URL
