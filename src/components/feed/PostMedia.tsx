'use client'

import { useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { BarChart3, FileText, Heart, Link2, Mic, Music2, Volume2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { haptic, openExternal, openTelegram } from '@/lib/tg'
import type { MediaItemDTO, PostDTO } from '@/lib/types'
import { MediaCarousel, VideoPlayer } from '@/components/feed/MediaCarousel'
import { MediaSpoiler } from '@/components/feed/MediaSpoiler'
import { MediaLightbox } from '@/components/feed/MediaLightbox'

/**
 * Универсальный медиаблок поста — поддерживает все типы контента Telegram,
 * которые отдаёт веб-превью t.me/s: фото (в т.ч. альбомы), видео, GIF-анимации,
 * стикеры, голосовые, аудио, файлы, опросы и превью ссылок.
 *
 * Визуальные типы (фото/видео/гиф/стикер) рисуются картинкой-слайдом,
 * «карточные» (файл/аудио/голос/опрос/линк-превью) — компактными карточками
 * под визуалом, как в Telegram. Двойной тап по визуалу — лайк с сердцем.
 */

/** Сердце при двойном тапе по одиночному визуалу; одиночный тап — открыть просмотр */
function DoubleTapHeart({
  children,
  onDoubleTap,
  onSingleTap,
  className,
}: {
  children: React.ReactNode
  onDoubleTap?: () => void
  onSingleTap?: () => void
  className?: string
}) {
  const [popKey, setPopKey] = useState(0)
  const timer = useRef<number | null>(null)
  return (
    <div
      className={cn('relative select-none', className)}
      data-noswipe
      onClick={() => {
        if (!onSingleTap) return
        if (timer.current) return
        timer.current = window.setTimeout(() => {
          timer.current = null
          onSingleTap()
        }, 260)
      }}
      onDoubleClick={() => {
        if (timer.current) {
          window.clearTimeout(timer.current)
          timer.current = null
        }
        setPopKey((k) => k + 1)
        onDoubleTap?.()
      }}
    >
      {children}
      <AnimatePresence>
        {popKey > 0 && (
          <motion.div
            key={popKey}
            initial={{ opacity: 0, scale: 0.4 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.15 }}
            transition={{ duration: 0.45, ease: 'easeOut' }}
            onAnimationComplete={() => setPopKey(0)}
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
            aria-hidden
          >
            <Heart className="h-20 w-20 fill-white text-white drop-shadow-[0_2px_12px_rgba(0,0,0,0.35)]" />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Карточные типы контента                                             */
/* ------------------------------------------------------------------ */

function CardShell({
  icon,
  title,
  subtitle,
  actionLabel,
  onAction,
}: {
  icon: React.ReactNode
  title: string
  subtitle?: string
  actionLabel: string
  onAction: () => void
}) {
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-tg-surface p-3.5" data-noswipe>
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-tg-link/10 text-tg-link">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14.5px] font-semibold text-tg-text">{title}</span>
        {subtitle && <span className="mt-0.5 block truncate text-[12.5px] text-tg-hint">{subtitle}</span>}
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          haptic('light')
          onAction()
        }}
        className="shrink-0 rounded-full bg-tg-link/10 px-3.5 py-2 text-[12.5px] font-semibold text-tg-link transition active:scale-95"
      >
        {actionLabel}
      </button>
    </div>
  )
}

function CardView({ item, tgLink }: { item: MediaItemDTO; tgLink: string | null }) {
  const openTg = () => (tgLink ? openTelegram(tgLink) : undefined)

  switch (item.kind) {
    case 'file':
      return (
        <CardShell
          icon={<FileText className="h-5 w-5" />}
          title={item.name ?? 'Файл'}
          subtitle={item.size ?? 'Документ'}
          actionLabel="Открыть"
          onAction={openTg}
        />
      )
    case 'voice':
    case 'audio':
      // Если парсер достал прямой src — даём слушать прямо в приложении
      if (item.url) {
        return (
          <div className="rounded-2xl bg-tg-surface p-3.5" data-noswipe>
            <div className="flex items-center gap-2">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-tg-link/10 text-tg-link">
                {item.kind === 'voice' ? <Mic className="h-4.5 w-4.5" /> : <Music2 className="h-4.5 w-4.5" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-semibold text-tg-text">
                  {item.kind === 'voice' ? 'Голосовое сообщение' : (item.title ?? 'Аудио')}
                </span>
                {item.performer && (
                  <span className="block truncate text-[12.5px] text-tg-hint">{item.performer}</span>
                )}
              </span>
              <Volume2 className="h-4 w-4 shrink-0 text-tg-hint" aria-hidden />
            </div>
            <audio controls preload="none" src={item.url} className="mt-2.5 h-9 w-full" />
          </div>
        )
      }
      return (
        <CardShell
          icon={item.kind === 'voice' ? <Mic className="h-5 w-5" /> : <Music2 className="h-5 w-5" />}
          title={item.kind === 'voice' ? 'Голосовое сообщение' : (item.title ?? 'Аудио')}
          subtitle={item.performer ?? 'Прослушать можно в Telegram'}
          actionLabel="Слушать"
          onAction={openTg}
        />
      )
    case 'poll':
      return (
        <div className="rounded-2xl bg-tg-surface p-4" data-noswipe>
          <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-tg-hint">
            <BarChart3 className="h-3.5 w-3.5" aria-hidden />
            Опрос
          </div>
          <div className="mt-1.5 text-[15px] font-semibold leading-snug text-tg-text">
            {item.question ?? 'Опрос'}
          </div>
          <div className="mt-3 space-y-2">
            {(item.answers ?? []).slice(0, 8).map((a, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full bg-tg-link/40" aria-hidden />
                <span className="truncate text-[13.5px] text-tg-text2">{a}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[12px] text-tg-hint">
            Голосовать — в оригинальном канале Telegram
          </p>
        </div>
      )
    case 'link':
      return (
        <button
          type="button"
          data-noswipe
          onClick={(e) => {
            e.stopPropagation()
            haptic('light')
            const url = item.link ?? tgLink
            if (url) {
              if (url.includes('t.me')) openTelegram(url)
              else openExternal(url)
            }
          }}
          className="block w-full overflow-hidden rounded-2xl bg-tg-surface text-left transition active:scale-[0.99]"
        >
          {item.url && (
            <img
              src={item.url}
              alt={item.title ?? 'Превью ссылки'}
              loading="lazy"
              className="max-h-[54dvh] w-full object-cover"
              onError={(e) => {
                e.currentTarget.style.display = 'none'
              }}
            />
          )}
          <span className="block p-3.5">
            {item.site && (
              <span className="text-[12px] font-medium text-tg-hint">{item.site}</span>
            )}
            {item.title && (
              <span className="mt-0.5 block text-[15px] font-semibold leading-snug text-tg-text">
                {item.title}
              </span>
            )}
            {item.description && (
              <span className="mt-1 line-clamp-3 block text-[13px] leading-snug text-tg-hint">
                {item.description}
              </span>
            )}
            <span className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-semibold text-tg-link">
              <Link2 className="h-3.5 w-3.5" aria-hidden />
              Открыть ссылку
            </span>
          </span>
        </button>
      )
    default:
      return null
  }
}

/* ------------------------------------------------------------------ */
/* Одиночные визуальные слайды                                         */
/* ------------------------------------------------------------------ */

function SingleVisual({
  item,
  alt,
  onDoubleTap,
  onOpen,
}: {
  item: MediaItemDTO
  alt: string
  onDoubleTap?: () => void
  onOpen?: () => void
}) {
  const inner = <SingleVisualInner item={item} alt={alt} onDoubleTap={onDoubleTap} onOpen={onOpen} />
  return item.spoiler ? <MediaSpoiler>{inner}</MediaSpoiler> : inner
}

function SingleVisualInner({
  item,
  alt,
  onDoubleTap,
  onOpen,
}: {
  item: MediaItemDTO
  alt: string
  onDoubleTap?: () => void
  onOpen?: () => void
}) {
  if (item.kind === 'video' && item.url) {
    return <VideoPlayer src={item.url} alt={alt} onDoubleTap={onDoubleTap} onOpen={onOpen} />
  }
  if (item.kind === 'gif' && item.url) {
    return (
      <div
        className="relative select-none"
        data-noswipe
        onDoubleClick={onDoubleTap}
        onClick={() => onOpen?.()}
      >
        <video
          src={item.url}
          poster={item.poster}
          aria-label={alt}
          muted
          loop
          autoPlay
          playsInline
          preload="metadata"
          className="mx-auto aspect-[4/5] max-h-[54dvh] w-full rounded-[14px] bg-tg-surface object-cover"
        />
        <span className="pointer-events-none absolute left-3 top-3 rounded-full bg-black/45 px-2 py-0.5 text-[10px] font-bold tracking-wide text-white">
          GIF
        </span>
      </div>
    )
  }
  if (item.kind === 'sticker' && item.url) {
    const isVideoSticker = item.url.endsWith('.webm') || item.url.endsWith('.mp4')
    return (
      <DoubleTapHeart onDoubleTap={onDoubleTap} onSingleTap={onOpen} className="flex items-center justify-center py-2">
        {isVideoSticker ? (
          <video
            src={item.url}
            aria-label={alt}
            muted
            loop
            autoPlay
            playsInline
            className="max-h-[44dvh] w-full max-w-[300px] rounded-2xl object-contain"
          />
        ) : (
          <img
            src={item.url}
            alt={alt}
            loading="lazy"
            draggable={false}
            className="max-h-[44dvh] w-full max-w-[300px] rounded-2xl object-contain"
            onError={(e) => {
              e.currentTarget.closest('[data-noswipe]')?.setAttribute('style', 'display:none')
            }}
          />
        )}
      </DoubleTapHeart>
    )
  }
  // image
  if (item.url) {
    return (
      <DoubleTapHeart onDoubleTap={onDoubleTap} onSingleTap={onOpen}>
        <img
          src={item.url}
          alt={alt}
          loading="lazy"
          draggable={false}
          className="mx-auto aspect-[4/5] max-h-[54dvh] w-full cursor-zoom-in rounded-[14px] bg-tg-surface object-cover"
          onError={(e) => {
            e.currentTarget.closest('[data-noswipe]')?.setAttribute('style', 'display:none')
          }}
        />
      </DoubleTapHeart>
    )
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Публичный компонент                                                 */
/* ------------------------------------------------------------------ */

const VISUAL_KINDS = new Set(['image', 'video', 'gif', 'sticker'])
const CARD_KINDS = new Set(['file', 'voice', 'audio', 'poll', 'link'])

/** Все медиа поста: основное первым */
export function postMediaItems(post: PostDTO): MediaItemDTO[] {
  const items: MediaItemDTO[] = []
  if (post.media && (post.media.url || post.media.name || post.media.question || post.media.link)) {
    items.push(post.media)
  }
  items.push(...post.gallery)
  return items
}

export function PostMedia({
  post,
  onDoubleTap,
}: {
  post: PostDTO
  onDoubleTap?: () => void
}) {
  const items = postMediaItems(post)
  const [lbIndex, setLbIndex] = useState<number | null>(null)
  if (items.length === 0) return null

  const visual = items.filter((x) => VISUAL_KINDS.has(x.kind) && x.url)
  const cards = items.filter((x) => CARD_KINDS.has(x.kind))
  const alt = `Пост канала «${post.channel.title}»`

  return (
    <div className="space-y-2.5">
      {visual.length === 1 && (
        <SingleVisual item={visual[0]} alt={alt} onDoubleTap={onDoubleTap} onOpen={() => setLbIndex(0)} />
      )}
      {visual.length > 1 && (
        <MediaCarousel items={visual} alt={alt} onDoubleTap={onDoubleTap} onOpenIndex={(idx) => setLbIndex(idx)} />
      )}
      {cards.map((c, i) => (
        <CardView key={i} item={c} tgLink={c.link ?? post.link} />
      ))}
      {/* Полноэкранный просмотр + скачивание (как в Telegram) */}
      {lbIndex != null && (
        <MediaLightbox items={visual} index={lbIndex} onClose={() => setLbIndex(null)} />
      )}
    </div>
  )
}
