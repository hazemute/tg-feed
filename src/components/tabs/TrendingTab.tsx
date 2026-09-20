'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, Eye, Heart, Plus, TrendingUp } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api, apiCached } from '@/lib/api'
import { useApp } from '@/lib/store'
import { formatCount, pluralRu, timeAgoRu } from '@/lib/format'
import { haptic } from '@/lib/tg'
import type { ChannelDTO, PostDTO, TrendingResponse } from '@/lib/types'
import { Avatar } from '@/components/tg/Avatar'

/**
 * Экран «Тренды»: пульс сообщества за 24ч, топ хэштегов (клики за 72ч),
 * топ постов по вовлечённости и популярные каналы.
 * Стилистика — единая с приложением: нейтральные строки с разделителями,
 * чипы как на «Поиске», единственный акцент — tg-link.
 * Данные — GET /api/trending (агрегат, персонализация по Bearer-сессии).
 */
export function TrendingTab() {
  const [data, setData] = useState<TrendingResponse | null>(null)
  const [failed, setFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let alive = true
    // v5.34: клиентский кэш 45с — вкладка открывается мгновенно, префетч на простое греет заранее
    apiCached<TrendingResponse>('/api/trending', 45_000)
      .then((r) => {
        if (alive) setData(r)
      })
      .catch(() => {
        if (alive) {
          setFailed(true)
          toast.error('Тренды недоступны')
        }
      })
    return () => {
      alive = false
    }
  }, [reloadKey])

  return (
    <div className="no-scrollbar h-full w-full overflow-y-auto overscroll-contain pb-24">
      {/* Центрированная колонка: на широких мониторах тренды не растягиваются на всю ширину */}
      <div className="mx-auto w-full max-w-[1000px]">
      {/* Заголовок — как на «Поиске» */}
      <header className="px-4 pb-3 pt-4">
        <h1 className="text-screen-title text-tg-text">Тренды</h1>
        <p className="mt-1 text-[15px] text-tg-hint">Что обсуждают прямо сейчас</p>
      </header>

      {failed ? (
        <Empty
          text="Не удалось загрузить тренды. Потяните вкладку вниз позже или откройте заново."
          action={
            <button
              type="button"
              onClick={() => {
                haptic('light')
                setFailed(false)
                setReloadKey((k) => k + 1)
              }}
              className="mt-4 h-10 rounded-full bg-tg-link px-6 text-[14px] font-semibold text-white transition active:scale-95"
            >
              Повторить
            </button>
          }
        />
      ) : !data ? (
        <TrendingSkeleton />
      ) : (
        <>
          {data.pulse && <PulseStrip pulse={data.pulse} />}
          {data.hashtags.length > 0 && <HashtagRail hashtags={data.hashtags} />}
          {data.topPosts.length > 0 && <TopPosts posts={data.topPosts} />}
          {data.topChannels.length > 0 && <TopChannels channels={data.topChannels} />}
          {!data.pulse && data.hashtags.length === 0 && data.topPosts.length === 0 && (
            <Empty text="Пока тихо — как только появятся посты и обсуждения, они соберутся здесь." />
          )}
        </>
      )}
      </div>
    </div>
  )
}

/* ---------- Пульс 24ч: одна спокойная строка статистики ---------- */

function PulseStrip({ pulse }: { pulse: TrendingResponse['pulse'] }) {
  const items = [
    { value: pulse.posts, word: ['пост', 'поста', 'постов'] },
    { value: pulse.likes, word: ['лайк', 'лайка', 'лайков'] },
    { value: pulse.views, word: ['просмотр', 'просмотра', 'просмотров'] },
    { value: pulse.clicks, word: ['клик', 'клика', 'кликов'] },
  ]

  return (
    <section className="px-4 pb-2" aria-label="Активность за 24 часа">
      <div className="grid grid-cols-4 divide-x divide-tg-sep/60 rounded-2xl bg-tg-surface py-3.5">
        {items.map((m) => (
          <div key={m.word[2]} className="min-w-0 px-1 text-center">
            <div className="text-[17px] font-bold leading-none text-tg-text tabular-nums">
              <CountUp value={m.value} />
            </div>
            <div className="mt-1.5 truncate px-0.5 text-[11px] leading-tight text-tg-hint">
              {pluralRu(m.value, m.word[0], m.word[1], m.word[2])}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

/** Плавный счётчик: 0 → value за 700мс (easeOutCubic), формат formatCount */
function CountUp({ value }: { value: number }) {
  const [display, setDisplay] = useState(0)
  const rafRef = useRef(0)

  useEffect(() => {
    const start = performance.now()
    const duration = 700
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      setDisplay(Math.round(value * eased))
      if (t < 1) rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [value])

  return <>{formatCount(display)}</>
}

/* ---------- Хэштеги — чипы точно как на «Поиске» ---------- */

function HashtagRail({ hashtags }: { hashtags: TrendingResponse['hashtags'] }) {
  const { openSearchWith } = useApp()

  return (
    <section className="pb-2 pt-3" aria-label="Сейчас обсуждают">
      <h2 className="px-4 text-[15px] font-semibold text-tg-text">Сейчас обсуждают</h2>
      <div className="no-scrollbar mt-2 flex gap-2 overflow-x-auto px-4" data-noswipe>
        {hashtags.map((h) => (
          <button
            key={h.tag}
            type="button"
            onClick={() => {
              haptic('light')
              openSearchWith(h.tag)
            }}
            aria-label={`Искать по теме ${h.tag}, ${h.clicks} ${pluralRu(h.clicks, 'клик', 'клика', 'кликов')}`}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-tg-sep bg-tg-surface px-3 text-sm text-tg-text transition active:scale-95"
          >
            <TrendingUp className="h-3.5 w-3.5 shrink-0 text-tg-hint" />
            <span className="max-w-32 truncate">{h.tag}</span>
            <span className="text-[12px] font-medium text-tg-hint">{formatCount(h.clicks)}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

/* ---------- Топ постов: строки с разделителями, как результаты поиска ---------- */

function TopPosts({ posts }: { posts: PostDTO[] }) {
  const { openChannel } = useApp()

  return (
    <section className="pb-2 pt-3" aria-label="Топ постов недели">
      <h2 className="px-4 text-[15px] font-semibold text-tg-text">Топ постов недели</h2>
      <div className="mt-1">
        {posts.map((p, i) => (
          <button
            key={p.id}
            type="button"
            onClick={() => {
              haptic('light')
              openChannel(p.channel.username)
            }}
            aria-label={`Открыть канал ${p.channel.title}, ${i + 1} место в топе`}
            className={cn(
              'flex w-full items-center gap-3 px-4 py-3 text-left transition active:bg-tg-surface/60',
              i > 0 && 'border-t border-tg-sep/60',
            )}
          >
            <span
              className={cn(
                'w-5 shrink-0 text-center text-[13px] tabular-nums',
                i < 3 ? 'font-bold text-tg-link' : 'font-medium text-tg-hint',
              )}
            >
              {i + 1}
            </span>
            <Avatar name={p.channel.title} color={p.channel.avatarColor} src={p.channel.avatarUrl} size={44} />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className="truncate text-[15px] font-semibold text-tg-text">
                  {p.channel.title}
                </span>
                <span className="shrink-0 text-[12px] text-tg-hint">{timeAgoRu(p.publishedAt)}</span>
              </span>
              <span className="mt-0.5 line-clamp-2 text-[14px] leading-snug text-tg-hint">
                {cleanPreview(p.text) || 'медиа-пост'}
              </span>
              <span className="mt-1 flex items-center gap-3 text-[12px] text-tg-hint">
                <span className="flex items-center gap-1">
                  <Heart className={cn('h-3.5 w-3.5', p.liked && 'fill-current text-tg-like')} />
                  {formatCount(p.likesCount)}
                </span>
                <span className="flex items-center gap-1">
                  <Eye className="h-3.5 w-3.5" />
                  {formatCount(p.viewsCount)}
                </span>
              </span>
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}

/* ---------- Популярные каналы: строки как на «Поиске» + подписка в один тап ---------- */

function TopChannels({ channels }: { channels: ChannelDTO[] }) {
  const { user, openChannel } = useApp()
  const [list, setList] = useState<ChannelDTO[]>(channels)

  // Обновляем локальный список, когда родитель перезагрузил данные (retry)
  useEffect(() => {
    setList(channels)
  }, [channels])

  const toggleSub = async (ch: ChannelDTO) => {
    if (!user) return
    const next = !ch.subscribed
    setList((prev) =>
      prev.map((c) =>
        c.id === ch.id
          ? { ...c, subscribed: next, subscribersCount: Math.max(0, c.subscribersCount + (next ? 1 : -1)) }
          : c,
      ),
    )
    haptic('light')
    try {
      await api('/api/subscribe', {
        method: 'POST',
        body: JSON.stringify({ userId: user.id, channelId: ch.id }),
      })
      toast.success(next ? `Вы подписались на «${ch.title}»` : `Вы отписались от «${ch.title}»`)
    } catch {
      setList((prev) =>
        prev.map((c) =>
          c.id === ch.id
            ? { ...c, subscribed: !next, subscribersCount: Math.max(0, c.subscribersCount + (next ? -1 : 1)) }
            : c,
        ),
      )
      toast.error('Ошибка подписки')
    }
  }

  return (
    <section className="pb-6 pt-3" aria-label="Популярные каналы">
      <h2 className="px-4 text-[15px] font-semibold text-tg-text">Популярные каналы</h2>
      <div className="mt-1">
        {list.map((c, i) => (
          <div
            key={c.id}
            className={cn(
              'flex items-center gap-3 px-4 py-3',
              i > 0 && 'border-t border-tg-sep/60',
            )}
          >
            <span
              className={cn(
                'w-5 shrink-0 text-center text-[13px] tabular-nums',
                i < 3 ? 'font-bold text-tg-link' : 'font-medium text-tg-hint',
              )}
            >
              {i + 1}
            </span>
            <button
              type="button"
              onClick={() => {
                haptic('light')
                openChannel(c.username)
              }}
              aria-label={`Открыть канал ${c.title}`}
              className="shrink-0"
            >
              <Avatar name={c.title} color={c.avatarColor} src={c.avatarUrl} size={44} />
            </button>
            <button
              type="button"
              onClick={() => {
                haptic('light')
                openChannel(c.username)
              }}
              className="min-w-0 flex-1 text-left"
            >
              <span className="block truncate text-[16px] font-bold leading-snug text-tg-text">
                {c.title}
              </span>
              <span className="mt-0.5 block truncate text-[13px] text-tg-hint">
                {c.subscribersCount > 0
                  ? `${formatCount(c.subscribersCount)} ${pluralRu(c.subscribersCount, 'подписчик', 'подписчика', 'подписчиков')}`
                  : `@${c.username}`}
              </span>
            </button>
            <SubscribeButton subscribed={c.subscribed} title={c.title} onClick={() => toggleSub(c)} />
          </div>
        ))}
      </div>
    </section>
  )
}

/** Компактная круглая кнопка подписки (лидерборд узкий — пилюля не помещается) */
function SubscribeButton({
  subscribed,
  title,
  onClick,
}: {
  subscribed: boolean
  title: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={subscribed}
      aria-label={subscribed ? `Отписаться от «${title}»` : `Подписаться на «${title}»`}
      className={cn(
        'flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition active:scale-90',
        subscribed ? 'bg-tg-surface text-tg-green' : 'bg-tg-link text-white',
      )}
    >
      {subscribed ? <Check className="h-4.5 w-4.5" strokeWidth={2.4} /> : <Plus className="h-5 w-5" strokeWidth={2.6} />}
    </button>
  )
}

/* ---------- Служебные блоки ---------- */

function Empty({ text, action }: { text: string; action?: React.ReactNode }) {
  return (
    <div className="px-8 py-14 text-center">
      <p className="text-[14px] leading-relaxed text-tg-hint">{text}</p>
      {action}
    </div>
  )
}

function TrendingSkeleton() {
  return (
    <div aria-hidden>
      <div className="px-4 pb-2">
        <div className="tg-shimmer grid h-[68px] grid-cols-4 rounded-2xl" />
      </div>
      <div className="flex gap-2 overflow-hidden px-4 pt-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="tg-shimmer h-8 w-24 shrink-0 rounded-full" />
        ))}
      </div>
      <div className="mt-3">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="flex items-center gap-3 border-t border-tg-sep/60 px-4 py-3.5 first:border-t-0">
            <div className="tg-shimmer h-11 w-11 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1">
              <div className="tg-shimmer h-3.5 w-32 rounded" />
              <div className="tg-shimmer mt-2 h-3 w-full rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Вычистить markdown-мусор из текста поста для превью */
function cleanPreview(text: string): string {
  return text
    .replace(/[*_`~[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}
