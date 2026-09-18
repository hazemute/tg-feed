import { ImageResponse } from 'next/og'
import { db } from '@/lib/db'
import { guardPublic } from '@/lib/guard'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/story?id=<postId> — стилизованная картинка поста для Telegram
 * Stories (п.4 запроса владельца): Mini App вызывает WebApp.shareToStory()
 * с URL этой картинки; Telegram сам скачивает PNG и вешает ссылку на бота
 * (widget_link). Друзья автора переходят в приложение из сторис.
 *
 * Формат сторис 9:16 (1080×1920). Публичный GET (Telegram-клиент не умеет
 * Authorization) + exemption от техработ в middleware (это медиа-GET);
 * картинка неизменяема для поста — агрессивный Cache-Control.
 * Без внешних шрифтов/картинок (satori): аватар канала — цветной круг
 * с инициалами, как фолбэк в приложении.
 */

const ID_RE = /^[a-zA-Z0-9_-]{5,40}$/

/** Чистка текста поста для карточки: маркеры/ссылки/эмодзи → чистая проза */
function cleanStoryText(raw: string, max = 330): string {
  let s = raw
    .replace(/!\[[a-z]{2,4}:[^\]]*\]\([^)]*\)/gi, ' ') // премиум-эмодзи/стикеры
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [текст](url) → текст
    .replace(/(\*\*|__|~~|\^\^|\|\||`{1,3})/g, '') // стилевые маркеры
    .replace(/^#{1,3} /gm, '')
    .replace(/^> ?/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (s.length > max) s = `${s.slice(0, max).replace(/\s+\S*$/, '')}…`
  return s
}

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
      likesCount: true,
      viewsCount: true,
      viewsTg: true,
      channel: { select: { title: true, verified: true, avatarColor: true } },
    },
  })
  if (!post) return new Response('not found', { status: 404 })

  const title = post.channel.title
  const initials = initialsOf(title)
  const accent = post.channel.avatarColor || '#3390ec'
  const body = cleanStoryText(post.text)
  const views = post.viewsTg ?? post.viewsCount

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '84px 76px',
          backgroundImage: 'linear-gradient(160deg, #1B2836 0%, #0E1621 58%, #101B27 100%)',
        }}
      >
        {/* Шапка: бренд */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: 20,
                background: 'linear-gradient(135deg, #62BCF9, #2AABEE)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 36,
                fontWeight: 800,
                color: '#fff',
              }}
            >
              S
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontSize: 34, fontWeight: 700, color: '#fff' }}>Tg Swipe</div>
              <div style={{ fontSize: 22, color: 'rgba(255,255,255,0.55)' }}>
                лента Telegram-каналов
              </div>
            </div>
          </div>
          <div style={{ fontSize: 24, color: 'rgba(255,255,255,0.45)' }}>@tgswipe_bot</div>
        </div>

        {/* Центр: канал + текст поста */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 40,
            flex: 1,
            justifyContent: 'center',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
            <div
              style={{
                width: 96,
                height: 96,
                borderRadius: 96,
                backgroundColor: accent,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 40,
                fontWeight: 700,
                color: '#fff',
              }}
            >
              {initials}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 40, fontWeight: 700, color: '#fff' }}>{title}</div>
              <div style={{ fontSize: 24, color: 'rgba(255,255,255,0.5)' }}>
                {(post.channel.verified ? 'официальный канал · ' : '') + 'Telegram'}
              </div>
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              padding: 44,
              borderRadius: 36,
              backgroundColor: 'rgba(255,255,255,0.055)',
              border: '1px solid rgba(255,255,255,0.09)',
            }}
          >
            <div
              style={{
                fontSize: body.length > 220 ? 40 : 46,
                lineHeight: 1.42,
                color: '#F5F7FA',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {body || 'Интересный пост в Telegram'}
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 36,
              fontSize: 26,
              color: 'rgba(255,255,255,0.55)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ color: '#F0616D' }}>♥</span>
              <span>{post.likesCount}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span>·</span>
              <span>{views > 0 ? `${views.toLocaleString('ru-RU')} просмотров` : ''}</span>
            </div>
          </div>
        </div>

        {/* Низ: призыв (widget_link вешает Telegram на сторис — кликабельно) */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '30px 40px',
            borderRadius: 28,
            background: 'linear-gradient(135deg, #2AABEE, #1E86C7)',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 34, fontWeight: 700, color: '#fff' }}>Читать в Tg Swipe</div>
            <div style={{ fontSize: 24, color: 'rgba(255,255,255,0.8)' }}>
              свайпы · переводы · саммари
            </div>
          </div>
          <div
            style={{
              padding: '14px 30px',
              borderRadius: 20,
              backgroundColor: 'rgba(255,255,255,0.16)',
              fontSize: 28,
              fontWeight: 700,
              color: '#fff',
            }}
          >
            Открыть
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
