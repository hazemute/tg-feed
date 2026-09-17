'use client'

import { useMemo, useState } from 'react'
import { ArrowLeft, Bookmark, Forward, Heart, Star } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { haptic, sharePost, useBackButton } from '@/lib/tg'
import { formatCount, timeAgoRu } from '@/lib/format'
import type { PostDTO } from '@/lib/types'
import { Avatar } from '@/components/tg/Avatar'
import { MediaCarousel, VideoPlayer } from '@/components/feed/MediaCarousel'
import { tokenizeHashtags } from '@/components/feed/PostCard'

/**
 * Полный экран поста («...еще» в ленте): весь текст без обрезки, все картинки,
 * видео, полная дата, статистика и действия (лайк/закладка/поделиться/Telegram).
 * Открывается как слайд поверх приложения; канал открывается поверх поста.
 * Лайк/закладка оптимистично обновляют оверлей и рассылают событие
 * tgfeed:post-updated, чтобы лента синхронизировалась без рефетча.
 */

/** Полный текст поста с кликабельными #хэштегами (без clamp) */
function FullText({ text }: { text: string }) {
  const openSearchWith = useApp((s) => s.openSearchWith)
  const parts = useMemo(() => tokenizeHashtags(text), [text])
  return (
    <p className="text-post whitespace-pre-line break-words text-tg-text">
      {parts.map((part, i) =>
        typeof part === 'string' ? (
          part
        ) : (
          <button
            key={i}
            type="button"
            aria-label={`Найти по теме ${part.tag}`}
            onClick={(e) => {
              e.stopPropagation()
              haptic('light')
              api('/api/hashtags/click', {
                method: 'POST',
                body: JSON.stringify({ tag: part.tag.slice(1) }),
              }).catch(() => {})
              openSearchWith(part.tag.slice(1))
            }}
            className="text-tg-link active:opacity-60"
          >
            {part.tag}
          </button>
        ),
      )}
    </p>
  )
}

/** Синхронизация изменений поста с лентой без рефетча */
export function emitPostUpdated(patch: {
  postId: string
  liked?: boolean
  likesCount?: number
  bookmarked?: boolean
  bookmarksCount?: number
}) {
  window.dispatchEvent(new CustomEvent('tgfeed:post-updated', { detail: patch }))
}

export function PostOverlay() {
  const post = useApp((s) => s.post)
  const closePost = useApp((s) => s.closePost)
  const openChannel = useApp((s) => s.openChannel)
  const user = useApp((s) => s.user)
  const open = !!post

  // Локальная копия для оптимистичных действий
  const [live, setLive] = useState<PostDTO | null>(null)
  const current = post && live && live.id === post.id ? live : post

  useBackButton(open, closePost)

  const ch = current?.channel

  const onLike = async () => {
    if (!current || !user) return
    const nextLiked = !current.liked
    const nextCount = Math.max(0, current.likesCount + (nextLiked ? 1 : -1))
    setLive({ ...current, liked: nextLiked, likesCount: nextCount })
    haptic('light')
    try {
      const r = await api<{ liked: boolean; likesCount: number }>('/api/like', {
        method: 'POST',
        body: JSON.stringify({ userId: user.id, postId: current.id }),
      })
      setLive((prev) => (prev ? { ...prev, liked: r.liked, likesCount: r.likesCount } : prev))
      emitPostUpdated({ postId: current.id, liked: r.liked, likesCount: r.likesCount })
    } catch {
      setLive({ ...current, liked: !nextLiked, likesCount: current.likesCount })
      toast.error('Не удалось сохранить лайк')
    }
  }

  const onBookmark = async () => {
    if (!current || !user) return
    const next = !current.bookmarked
    const nextCount = Math.max(0, current.bookmarksCount + (next ? 1 : -1))
    setLive({ ...current, bookmarked: next, bookmarksCount: nextCount })
    haptic(next ? 'success' : 'light')
    try {
      await api('/api/bookmark', {
        method: 'POST',
        body: JSON.stringify({ userId: user.id, postId: current.id }),
      })
      toast.success(next ? 'Сохранено' : 'Убрано из сохранённых')
      emitPostUpdated({ postId: current.id, bookmarked: next, bookmarksCount: nextCount })
    } catch {
      setLive({ ...current, bookmarked: !next, bookmarksCount: current.bookmarksCount })
      toast.error('Ошибка')
    }
  }

  const images = current ? [current.mediaUrl, ...current.gallery].filter((x): x is string => !!x) : []
  const fullDate = current ? new Date(current.publishedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : ''

  return (
    <AnimatePresence>
      {open && current && ch && (
        <motion.div
          key={current.id}
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%' }}
          transition={{ type: 'spring', damping: 32, stiffness: 330 }}
          className="fixed inset-0 z-[65] mx-auto flex w-full max-w-[430px] flex-col bg-tg-bg"
          role="dialog"
          aria-modal="true"
          aria-label="Пост"
          data-noswipe
        >
          {/* Шапка */}
          <header className="flex shrink-0 items-center gap-2 border-b border-tg-sep px-2 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))]">
            <button
              type="button"
              onClick={() => {
                haptic('light')
                closePost()
              }}
              aria-label="Назад"
              className="flex h-10 w-10 items-center justify-center rounded-full text-tg-text active:bg-tg-surface"
            >
              <ArrowLeft className="h-6 w-6" strokeWidth={1.8} />
            </button>
            <span className="flex-1 text-[17px] font-semibold text-tg-text">Пост</span>
            <time dateTime={current.publishedAt} className="pr-2 text-[12.5px] text-tg-hint">
              {timeAgoRu(current.publishedAt)}
            </time>
          </header>

          {/* Контент */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {/* Канал */}
            <button
              type="button"
              onClick={() => {
                haptic('light')
                openChannel(ch.username)
              }}
              aria-label={`Открыть канал ${ch.title}`}
              className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-tg-surface/60"
            >
              <Avatar name={ch.title} color={ch.avatarColor} src={ch.avatarUrl} size={46} className="ring-1 ring-tg-sep/70" />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1">
                  <span className="truncate text-[16px] font-bold leading-tight text-tg-text">{ch.title}</span>
                  {ch.isPremium && (
                    <Star className="h-3.5 w-3.5 shrink-0 fill-tg-star text-tg-star" aria-label="Продвинутый канал" />
                  )}
                </span>
                <span className="mt-0.5 block truncate text-[13px] leading-tight text-tg-hint">
                  {formatCount(ch.subscribersCount)} подписчиков · @{ch.username}
                </span>
              </span>
            </button>

            {/* Медиа */}
            {current.mediaType === 'video' && current.mediaUrl ? (
              <VideoPlayer
                src={current.mediaUrl}
                alt={`Видео канала «${ch.title}»`}
                onDoubleTap={onLike}
              />
            ) : (
              images.length > 0 && (
                <MediaCarousel images={images} alt={`Пост канала «${ch.title}»`} onDoubleTap={onLike} />
              )
            )}

            {/* Текст (всегда полностью) */}
            {current.text && (
              <div className="px-4 pt-3">
                <FullText text={current.text} />
              </div>
            )}

            {/* Полная дата + статистика */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3 text-[12.5px] text-tg-hint">
              <span>{fullDate}</span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">{formatCount(current.viewsCount)} просмотров</span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">{formatCount(current.likesCount)} лайков</span>
              {current.bookmarksCount > 0 && (
                <>
                  <span aria-hidden>·</span>
                  <span className="tabular-nums">{formatCount(current.bookmarksCount)} в закладках</span>
                </>
              )}
            </div>
            <div className="h-24" />
          </div>

          {/* Панель действий */}
          <nav
            aria-label="Действия с постом"
            className="absolute inset-x-0 bottom-0 border-t border-tg-sep bg-tg-bg/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2.5 backdrop-blur"
          >
            <div className="mx-auto flex max-w-[430px] items-center justify-around">
              <motion.button
                type="button"
                whileTap={{ scale: 1.2 }}
                transition={{ type: 'spring', stiffness: 500, damping: 15 }}
                onClick={onLike}
                aria-label="Нравится"
                aria-pressed={current.liked}
                className="flex items-center gap-1.5 py-1.5"
              >
                <Heart
                  className={cn(
                    'h-[24px] w-[24px]',
                    current.liked ? 'fill-tg-like text-tg-like' : 'text-tg-text',
                  )}
                  strokeWidth={current.liked ? 2 : 1.7}
                />
                <span className="text-[13px] font-medium tabular-nums text-tg-text2">
                  {formatCount(current.likesCount)}
                </span>
              </motion.button>
              <button
                type="button"
                onClick={onBookmark}
                aria-label="Сохранить"
                aria-pressed={current.bookmarked}
                className="flex items-center gap-1.5 py-1.5"
              >
                <Bookmark
                  className={cn(
                    'h-[23px] w-[23px]',
                    current.bookmarked ? 'fill-tg-link text-tg-link' : 'text-tg-text',
                  )}
                  strokeWidth={current.bookmarked ? 2 : 1.7}
                />
                <span className="text-[13px] font-medium tabular-nums text-tg-text2">
                  {formatCount(current.bookmarksCount)}
                </span>
              </button>
              <button
                type="button"
                onClick={() => sharePost(current.link, ch.title)}
                aria-label="Поделиться"
                className="flex items-center gap-1.5 py-1.5"
              >
                <Forward className="h-[23px] w-[23px] text-tg-text" strokeWidth={1.7} />
                <span className="text-[13px] font-medium text-tg-text2">Поделиться</span>
              </button>
              <a
                href={current.link || `https://t.me/${ch.username}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => haptic('light')}
                className="flex items-center gap-1.5 py-1.5"
              >
                <svg viewBox="0 0 24 24" className="h-[22px] w-[22px] fill-tg-link" aria-hidden>
                  <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.161-1.86 8.766c-.14.62-.51.772-1.032.48l-2.85-2.1-1.376 1.324c-.152.152-.28.28-.574.28l.204-2.9 5.286-4.774c.23-.204-.05-.318-.354-.114l-6.534 4.112-2.814-.88c-.612-.192-.624-.612.128-.906l11.004-4.244c.51-.192.956.114.772.956z" />
                </svg>
                <span className="text-[13px] font-medium text-tg-text2">Telegram</span>
              </a>
            </div>
          </nav>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
