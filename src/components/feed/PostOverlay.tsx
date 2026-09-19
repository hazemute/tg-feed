'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowUpRight, Bookmark, Check, ChevronLeft, ChevronRight, Copy, Forward, Heart, MessageCircle, Send, Sparkle, Star } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { useApp } from '@/lib/store'
import { fullDateLocalized, useT } from '@/lib/i18n'
import { haptic, openTelegram, useBackButton } from '@/lib/tg'
import { formatCount, timeAgo } from '@/lib/format'
import { stripMarkdown } from '@/lib/markdown'
import type { PostDTO } from '@/lib/types'
import { Avatar } from '@/components/tg/Avatar'
import { RichText } from '@/components/feed/RichText'
import { PostMedia } from '@/components/feed/PostMedia'
import { TranslateControl, translatedText, useTranslation } from '@/components/feed/TranslateButton'
import { ListenButton } from '@/components/feed/TTSButton'
import { SummarySheet } from '@/components/feed/SummarySheet'

/**
 * Полный экран поста («...еще» в ленте): весь текст без обрезки, все картинки,
 * видео, полная дата, статистика и действия (лайк/закладка/поделиться/Telegram).
 * Открывается как слайд поверх приложения; канал открывается поверх поста.
 * Лайк/закладка оптимистично обновляют оверлей и рассылают событие
 * tgfeed:post-updated, чтобы лента синхронизировалась без рефетча.
 */

/** Кнопка «Копировать текст»: чистый текст поста в буфер обмена */
function CopyTextButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const t = useT()
  return (
    <button
      type="button"
      data-noswipe
      onClick={async () => {
        haptic('light')
        // copyText: Clipboard API + фолбэк execCommand (iOS-safe readonly+select) —
        // локальная копия фолбэка убрана: без них execCommand в iframe Telegram/iOS
        // молча не копировал, а тост показывал «Скопировано» даже при неудаче
        const ok = await copyText(stripMarkdown(text))
        if (ok) {
          setCopied(true)
          toast.success(t('post.copiedToast'))
          setTimeout(() => setCopied(false), 1600)
        } else {
          toast.error(t('post.copyFail'))
        }
      }}
      aria-label={t('post.copyText')}
      className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-tg-surface text-[14px] font-semibold text-tg-link active:opacity-70"
    >
      {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
      {copied ? t('post.copied') : t('post.copyText')}
    </button>
  )
}

/** Синхронизация изменений поста с лентой без рефетча */
export function emitPostUpdated(patch: {
  postId: string
  liked?: boolean
  likesCount?: number
  bookmarked?: boolean
  bookmarksCount?: number
  commentsCount?: number
}) {
  window.dispatchEvent(new CustomEvent('tgfeed:post-updated', { detail: patch }))
}

/**
 * Текст поста в полном экране + перевод на месте (Twitter-style).
 * Ключ по id поста: при свайпе ←/→ компонент пересоздаётся —
 * перевод предыдущего поста не «переехает» на следующий.
 */
function OverlayText({
  post,
  teaser,
  teaserText,
}: {
  post: PostDTO
  teaser: boolean
  teaserText: string
}) {
  const tr = useTranslation(post.id, post.text)
  const shown = teaser ? teaserText : translatedText(tr, post.text)
  return (
    <div className="px-4 pt-3">
      <RichText text={shown} />
      {!teaser && <TranslateControl tr={tr} />}
    </div>
  )
}

export function PostOverlay() {
  const post = useApp((s) => s.post)
  const closePost = useApp((s) => s.closePost)
  const openPost = useApp((s) => s.openPost)
  const postQueue = useApp((s) => s.postQueue)
  const openChannel = useApp((s) => s.openChannel)
  const openAuthGate = useApp((s) => s.openAuthGate)
  const openComments = useApp((s) => s.openComments)
  const openShareSheet = useApp((s) => s.openShareSheet)
  const user = useApp((s) => s.user)
  const open = !!post
  const t = useT()
  const lang = useApp((s) => s.lang)

  // Локальная копия для оптимистичных действий: хранится вместе с id поста —
  // при переключении на соседний пост (свайп/стрелки) копия автоматически
  // игнорируется, отдельный сброс в эффекте не нужен
  const [live, setLive] = useState<{ id: string; data: PostDTO } | null>(null)
  // «Краткое содержание» прямо из полного экрана поста
  const [summaryPost, setSummaryPost] = useState<PostDTO | null>(null)
  const current = post && live && live.id === post.id ? live.data : post

  /* ---------- Свайп ←/→ между постами очереди ленты ---------- */

  // Направление последнего переключения (1 — к следующему, -1 — к предыдущему,
  // 0 — первичное открытие): задаёт сторону влёта контента
  const [slideDir, setSlideDir] = useState(0)

  const qIndex = current ? postQueue.findIndex((p) => p.id === current.id) : -1
  const hasNext = qIndex >= 0 && qIndex < postQueue.length - 1
  const hasPrev = qIndex > 0

  const goNext = useCallback(() => {
    const i = postQueue.findIndex((p) => p.id === post?.id)
    if (i >= 0 && i < postQueue.length - 1) {
      setSlideDir(1)
      haptic('light')
      openPost(postQueue[i + 1])
    }
  }, [postQueue, post?.id, openPost])

  const goPrev = useCallback(() => {
    const i = postQueue.findIndex((p) => p.id === post?.id)
    if (i > 0) {
      setSlideDir(-1)
      haptic('light')
      openPost(postQueue[i - 1])
    }
  }, [postQueue, post?.id, openPost])

  // Сброс оптимистичной копии при смене поста происходит автоматически:
  // current берёт live только при совпадении id (см. комментарий выше)

  // Клавиатура (десктоп): ←/→ листают посты очереди
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') goNext()
      else if (e.key === 'ArrowLeft') goPrev()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, goNext, goPrev])

  // Комментарии (шит поверх оверлея) обновили счётчик — патчим живую копию,
  // чтобы число в панели действий не отставало
  useEffect(() => {
    const onUpdated = (e: Event) => {
      const d = (e as CustomEvent).detail as { postId: string; commentsCount?: number }
      const cc = d?.commentsCount
      if (!d?.postId || typeof cc !== 'number') return
      setLive((prev) =>
        prev && prev.id === d.postId
          ? { ...prev, data: { ...prev.data, commentsCount: cc } }
          : prev,
      )
    }
    window.addEventListener('tgfeed:post-updated', onUpdated)
    return () => window.removeEventListener('tgfeed:post-updated', onUpdated)
  }, [])

  /* ---------- Dwell полного просмотра: сигнал интереса для рекомендаций ---------- */
  // Время, проведённое в оверлее конкретного поста, — самый сильный сигнал
  // «заинтересовало» (сильнее лайка: дочитал до конца). Отправляем при закрытии
  // и при переключении на соседний пост; кап 10 минут, шум <5с не пишем.
  const dwellRef = useRef<{ id: string; since: number } | null>(null)
  const flushDwell = useCallback(() => {
    const d = dwellRef.current
    dwellRef.current = null
    if (!d) return
    const ms = Math.min(Date.now() - d.since, 600_000)
    if (ms < 5_000) return
    api('/api/view/dwell', { method: 'POST', body: JSON.stringify({ postId: d.id, ms }) }).catch(() => {})
  }, [])

  useEffect(() => {
    if (open && current) {
      // Смена поста внутри оверлея — флашим предыдущий, открываем новый отсчёт
      if (dwellRef.current && dwellRef.current.id !== current.id) flushDwell()
      if (!dwellRef.current) dwellRef.current = { id: current.id, since: Date.now() }
    } else if (!open) {
      flushDwell() // закрытие оверлея
    }
  }, [open, current?.id, current, flushDwell])

  // Touch-свайп: горизонталь должна доминировать над вертикалью (иначе это скролл),
  // порог 80px и не дольше 700мс — не мешает вертикальной прокрутке контента
  const touchStart = useRef<{ x: number; y: number; t: number } | null>(null)
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0]
    touchStart.current = { x: t.clientX, y: t.clientY, t: Date.now() }
  }
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = touchStart.current
    touchStart.current = null
    if (!s) return
    const t = e.changedTouches[0]
    const dx = t.clientX - s.x
    const dy = t.clientY - s.y
    if (Date.now() - s.t > 700) return
    if (Math.abs(dx) < 80 || Math.abs(dx) < Math.abs(dy) * 1.5) return
    if (dx < 0) goNext()
    else goPrev()
  }

  useBackButton(open, closePost)

  const ch = current?.channel

  const onLike = async () => {
    if (!current || !user) return
    // Ленивая регистрация: лайк гостя → шторка входа за 2 секунды
    if (user.isGuest) {
      openAuthGate('like')
      haptic('light')
      return
    }
    const nextLiked = !current.liked
    const nextCount = Math.max(0, current.likesCount + (nextLiked ? 1 : -1))
    setLive({ id: current.id, data: { ...current, liked: nextLiked, likesCount: nextCount } })
    haptic('light')
    try {
      const r = await api<{ liked: boolean; likesCount: number }>('/api/like', {
        method: 'POST',
        body: JSON.stringify({ userId: user.id, postId: current.id }),
      })
      setLive((prev) =>
        prev && prev.id === current.id
          ? { ...prev, data: { ...prev.data, liked: r.liked, likesCount: r.likesCount } }
          : prev,
      )
      emitPostUpdated({ postId: current.id, liked: r.liked, likesCount: r.likesCount })
    } catch {
      setLive({ id: current.id, data: { ...current, liked: !nextLiked, likesCount: current.likesCount } })
      toast.error(t('post.likeError'))
    }
  }

  const onBookmark = async () => {
    if (!current || !user) return
    // Ленивая регистрация: сохранение гостя → шторка входа
    if (user.isGuest) {
      openAuthGate('bookmark')
      haptic('light')
      return
    }
    const next = !current.bookmarked
    const nextCount = Math.max(0, current.bookmarksCount + (next ? 1 : -1))
    setLive({ id: current.id, data: { ...current, bookmarked: next, bookmarksCount: nextCount } })
    haptic(next ? 'success' : 'light')
    try {
      await api('/api/bookmark', {
        method: 'POST',
        body: JSON.stringify({ userId: user.id, postId: current.id }),
      })
      toast.success(next ? t('post.savedToast') : t('post.unsavedToast'))
      emitPostUpdated({ postId: current.id, bookmarked: next, bookmarksCount: nextCount })
    } catch {
      setLive({ id: current.id, data: { ...current, bookmarked: !next, bookmarksCount: current.bookmarksCount } })
      toast.error(t('post.error'))
    }
  }

  const fullDate = current ? fullDateLocalized(lang, current.publishedAt) : ''
  // Тизер-режим канала: полный текст — только у подписчиков оригинала
  const chTeaser = current?.channel
  const teaser =
    chTeaser &&
    !chTeaser.subscribed &&
    chTeaser.teaserMode !== 'none' &&
    current.text.length > chTeaser.teaserLimit
  const teaserText =
    chTeaser && current && chTeaser.teaserMode === 'cut'
      ? current.text.slice(0, Math.max(60, chTeaser.teaserLimit)).trimEnd() + '…'
      : current?.text ?? ''

  return (
    <>
      <AnimatePresence>
        {open && current && ch && (
          <motion.div
            key={current.id}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 32, stiffness: 330 }}
            className="fixed inset-0 z-[65] mx-auto flex w-full max-w-[430px] flex-col overflow-hidden bg-tg-bg lg:bottom-auto lg:top-[4vh] lg:h-[92vh] lg:max-w-[760px] lg:rounded-3xl lg:border lg:border-tg-sep lg:shadow-[0_24px_90px_rgba(0,0,0,0.30)]"
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
              aria-label={t('post.back')}
              className="flex h-10 w-10 items-center justify-center rounded-full text-tg-text active:bg-tg-surface"
            >
              <ArrowLeft className="h-6 w-6" strokeWidth={1.8} />
            </button>
            <span className="flex-1 text-[17px] font-semibold text-tg-text">{t('post.title')}</span>
            {/* Пейджер очереди ленты: свайп/стрелки листают посты без выхода в ленту */}
            {qIndex >= 0 && postQueue.length > 1 && (
              <nav aria-label={t('post.pager')} className="flex items-center gap-0.5 rounded-full bg-tg-surface px-1 py-0.5">
                <button
                  type="button"
                  onClick={goPrev}
                  disabled={!hasPrev}
                  aria-label={t('post.prev')}
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-full',
                    hasPrev ? 'text-tg-text active:bg-tg-sep/60' : 'text-tg-hint/40',
                  )}
                >
                  <ChevronLeft className="h-4.5 w-4.5" strokeWidth={2.2} />
                </button>
                <span className="min-w-[38px] text-center text-[12px] font-semibold tabular-nums text-tg-hint" aria-live="polite">
                  {qIndex + 1}/{postQueue.length}
                </span>
                <button
                  type="button"
                  onClick={goNext}
                  disabled={!hasNext}
                  aria-label={t('post.next')}
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-full',
                    hasNext ? 'text-tg-text active:bg-tg-sep/60' : 'text-tg-hint/40',
                  )}
                >
                  <ChevronRight className="h-4.5 w-4.5" strokeWidth={2.2} />
                </button>
              </nav>
            )}
            <time dateTime={current.publishedAt} className="pr-2 text-[12.5px] text-tg-hint">
              {timeAgo(current.publishedAt, lang)}
            </time>
          </header>

          {/* Контент */}
          <div
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
          >
            {/* Смена поста (свайп/стрелки) приезжает с соответствующей стороны */}
            <motion.div
              key={current.id}
              initial={{ x: slideDir * 72, opacity: slideDir === 0 ? 1 : 0 }}
              animate={{ x: 0, opacity: 1 }}
              transition={{ type: 'spring', damping: 34, stiffness: 400 }}
            >
            {/* Канал */}
            <button
              type="button"
              onClick={() => {
                haptic('light')
                openChannel(ch.username)
              }}
              aria-label={`${t('post.openChannel')} ${ch.title}`}
              className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-tg-surface/60"
            >
              <Avatar name={ch.title} color={ch.avatarColor} src={ch.avatarUrl} size={46} className="ring-1 ring-tg-sep/70" />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1">
                  <span className="truncate text-[16px] font-bold leading-tight text-tg-text">{ch.title}</span>
                  {ch.isPremium && (
                    <Star className="h-3.5 w-3.5 shrink-0 fill-tg-star text-tg-star" aria-label={t('post.premium')} />
                  )}
                </span>
                <span className="mt-0.5 block truncate text-[13px] leading-tight text-tg-hint">
                  {ch.subscribersCount > 0 ? (
                    <>
                      {formatCount(ch.subscribersCount)} {t('post.subscribers')} · @{ch.username}
                    </>
                  ) : (
                    <>@{ch.username}</>
                  )}
                </span>
              </span>
            </button>

            {/* Медиа (все типы: фото/видео/гиф/стикер/файл/аудио/опрос/линк).
                Двойной тап — ТОЛЬКО лайк (как в ленте): снятие лайка двойным
                тапом по уже лайкнутому посту — случайное действие, теряющее
                отметку без возможности «отменить жест» */}
            <PostMedia post={current} onDoubleTap={() => { if (!current.liked) void onLike() }} eager />

            {/* Текст (тизер или полностью; перевод замещает текст на месте) */}
            {current.text &&
              (teaser && chTeaser?.teaserMode === 'blur' ? (
                <div className="px-4 pt-3">
                  <div className="pointer-events-none select-none blur-[7px]" aria-hidden>
                    <RichText text={current.text} />
                  </div>
                </div>
              ) : (
                <OverlayText
                  key={current.id}
                  post={current}
                  teaser={!!teaser}
                  teaserText={teaserText}
                />
              ))}

            {/* CTA тизера: конвертация читателя в подписчика канала */}
            {teaser && current.text && chTeaser && (
              <div className="mt-3 px-4">
                <button
                  type="button"
                  onClick={() => {
                    haptic('light')
                    openTelegram(current.link ?? `https://t.me/${chTeaser.username}`)
                  }}
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-tg-link/10 text-[14.5px] font-semibold text-tg-link transition active:scale-[0.98]"
                >
                  <Send className="h-4 w-4" aria-hidden />
                  {t('post.readInTg')}
                </button>
                <p className="mt-1.5 text-center text-[12px] leading-snug text-tg-hint">
                  {t('post.teaserHint')}
                </p>
              </div>
            )}

            {/* Полная дата + статистика */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3 text-[12.5px] text-tg-hint">
              <span>{fullDate}</span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">{formatCount(current.viewsCount)} {t('post.views')}</span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">{formatCount(current.likesCount)} {t('post.likes')}</span>
              {current.bookmarksCount > 0 && (
                <>
                  <span aria-hidden>·</span>
                  <span className="tabular-nums">{formatCount(current.bookmarksCount)} {t('post.inBookmarks')}</span>
                </>
              )}
            </div>
            {/* Озвучка поста — крупная кнопка под статистикой */}
            {current.text && (
              <div className="mt-3 space-y-2 px-4">
                <ListenButton
                  postId={current.id}
                  text={current.text}
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-tg-surface text-[14px] font-semibold text-tg-link"
                />
                <CopyTextButton text={current.text} />
              </div>
            )}
            {/* Краткое содержание доступно и из полного экрана — у любого длинного текста без тизера */}
            {current.text && current.text.length > 400 && !teaser && (
              <button
                type="button"
                onClick={() => {
                  haptic('light')
                  setSummaryPost(current)
                }}
                className="mt-3 mx-4 inline-flex h-11 items-center gap-1.5 rounded-xl bg-tg-surface px-4 text-[14px] font-semibold text-tg-link active:opacity-70"
              >
                <Sparkle className="h-4 w-4" aria-hidden />
                {t('post.summary')}
              </button>
            )}
            {/* CTA Pro-автора: полноширинная кнопка-ссылка в самом низу поста
                (над панелью действий с входом к комментариям). Поля ctaLabel/
                ctaUrl приходят в DTO только при активном Pro-владельце канала —
                без них блок не рендерится вовсе (никаких заглушек). */}
            {ch.ctaLabel && ch.ctaUrl && (
              <div className="mt-3 px-4">
                <a
                  href={ch.ctaUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => haptic('light')}
                  className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-tg-link text-[15px] font-semibold text-white active:opacity-80"
                >
                  {ch.ctaLabel}
                  <ArrowUpRight className="h-4.5 w-4.5" aria-hidden />
                </a>
              </div>
            )}
            <div className="h-24" />
            </motion.div>
          </div>

          {/* Панель действий */}
          <nav
            aria-label="Действия с постом"
            className="absolute inset-x-0 bottom-0 border-t border-tg-sep bg-tg-bg/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2.5 backdrop-blur"
          >
            <div className="mx-auto flex max-w-[430px] items-center justify-around lg:max-w-[560px]">
              <motion.button
                type="button"
                whileTap={{ scale: 1.2 }}
                transition={{ type: 'spring', stiffness: 500, damping: 15 }}
                onClick={onLike}
                aria-label={t('post.like')}
                aria-pressed={current.liked}
                className="flex min-h-[44px] items-center gap-1.5 py-1.5"
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
                aria-label={t('post.save')}
                aria-pressed={current.bookmarked}
                className="flex min-h-[44px] items-center gap-1.5 py-1.5"
              >
                <Bookmark
                  className={cn(
                    'h-[24px] w-[24px]',
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
                onClick={() => {
                  haptic('light')
                  openComments(current)
                }}
                aria-label={t('comments.title')}
                className="flex min-h-[44px] items-center gap-1.5 py-1.5"
              >
                <MessageCircle className="h-[24px] w-[24px] text-tg-text" strokeWidth={1.7} />
                <span className="text-[13px] font-medium tabular-nums text-tg-text2">
                  {formatCount(current.commentsCount)}
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  haptic('light')
                  openShareSheet(current)
                }}
                aria-label={t('post.shareAria')}
                className="flex min-h-[44px] items-center gap-1.5 py-1.5"
              >
                <Forward className="h-[24px] w-[24px] text-tg-text" strokeWidth={1.7} />
                <span className="text-[13px] font-medium text-tg-text2">{t('post.share')}</span>
              </button>
            </div>
          </nav>
        </motion.div>
      )}
      </AnimatePresence>
      {/* Саммари рендерится поверх полного экрана поста */}
      <SummarySheet post={summaryPost} onClose={() => setSummaryPost(null)} />
    </>
  )
}
