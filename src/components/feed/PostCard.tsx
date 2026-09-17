'use client'

import { useEffect, useRef, useState } from 'react'
import { Eye, Forward, Heart, Send, Sparkle, Star } from 'lucide-react'
import { motion, useAnimate } from 'framer-motion'
import { cn } from '@/lib/utils'
import { useApp } from '@/lib/store'
import { useT } from '@/lib/i18n'
import { api } from '@/lib/api'
import { formatCount, timeAgo } from '@/lib/format'
import { haptic, openTelegram, sharePost } from '@/lib/tg'
import type { PostDTO } from '@/lib/types'
import { Avatar } from '@/components/tg/Avatar'
import { RichText } from '@/components/feed/RichText'
import { PostMedia } from '@/components/feed/PostMedia'
import { translatedText, TranslateControl, useTranslation } from '@/components/feed/TranslateButton'
import { ListenButton } from '@/components/feed/TTSButton'
import { RailButton, SubscribeCircle } from '@/components/feed/actions'

/**
 * Пост ленты по макету:
 * шапка канала (аватар, название, подписчики, круглая [+]),
 * медиа с правой панелью действий, текст с «...еще».
 * Двойной тап по медиа — лайк со всплывающим сердцем.
 * #хэштеги в тексте кликабельны — открывают поиск по теме.
 *
 * Тизер-механика (настройка канала в «Мой канал»): для неподписанных
 * текст обрезается (cut) или размазывается (blur) с призывом читать
 * в оригинальном канале — читатель превращается в подписчика.
 */

/**
 * Кнопка лайка: как RailButton, но счётчик пружинно подпрыгивает
 * при изменении числа (spring 1.25 → 1, ~250мс; не анимируется при первом рендере).
 */
function LikeRailButton({ count, active, onClick }: { count: number; active: boolean; onClick: () => void }) {
  // Императивная анимация счётчика (useAnimate): рефы читаем только в эффекте
  const [countScope, animate] = useAnimate()
  // Предыдущее значение числа: подпрыгивание — только при реальном изменении,
  // не при первом рендере (prev === null). Повторный прогон эффекта с тем же
  // значением (в т.ч. StrictMode-дабл) безопасно пропускается (prev === count).
  const prevCountRef = useRef<number | null>(null)

  useEffect(() => {
    const prev = prevCountRef.current
    prevCountRef.current = count
    if (prev === null || prev === count || !countScope.current) return
    void animate(countScope.current, { scale: [1.25, 1] }, { type: 'spring', stiffness: 550, damping: 18 })
  }, [count, animate, countScope])

  return (
    <motion.button
      type="button"
      whileTap={{ scale: 1.2 }}
      transition={{ type: 'spring', stiffness: 500, damping: 15 }}
      onClick={() => {
        onClick()
        haptic('light')
      }}
      aria-label="Нравится"
      aria-pressed={active}
      className="flex flex-col items-center gap-1"
    >
      <Heart
        className={cn(
          'h-[26px] w-[26px] transition-colors',
          active ? 'fill-tg-like text-tg-like' : 'text-tg-text',
        )}
        strokeWidth={active ? 2 : 1.7}
      />
      {count > 0 && (
        <span ref={countScope} className="text-[12px] font-medium leading-none text-tg-text2 tabular-nums">
          {formatCount(count)}
        </span>
      )}
    </motion.button>
  )
}

/** CTA тизера: читатель должен стать подписчиком оригинального канала */
function TeaserCta({ post }: { post: PostDTO }) {
  const t = useT()
  return (
    <div className="mt-2.5">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          haptic('light')
          openTelegram(post.link ?? `https://t.me/${post.channel.username}`)
        }}
        className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-tg-link/10 text-[14px] font-semibold text-tg-link transition active:scale-[0.98]"
      >
        <Send className="h-4 w-4" aria-hidden />
        {t('post.readInTg')}
      </button>
      <p className="mt-1.5 text-center text-[11.5px] leading-snug text-tg-hint">
        {t('post.teaserHint')}
      </p>
    </div>
  )
}

/**
 * Текст поста ленты: clamp ровно 3 строки, кнопка «...еще» в правом нижнем углу
 * обрезанного блока открывает полный экран поста (PostOverlay) — с полным текстом
 * и всеми картинками. Текст рендерится markdown-lite (RichText).
 *
 * Почему absolute, а не float: кнопка-float стоит ПОСЛЕ абзаца с полным текстом —
 * при обрезке overflow:hidden она попадает под линию отсечки и становится невидимой.
 * Абсолютная кнопка привязана к НИЗУ обрезанного контейнера (низ = конец 3-й строки)
 * и всегда видима. Слева от кнопки — градиент под цвет фона, текст под ней
 * растворяется без жёсткого края.
 */
function PostText({
  text,
  postId,
  onSummary,
  onOpenMore,
}: {
  text: string
  postId: string
  onSummary?: () => void
  onOpenMore?: () => void
}) {
  const t = useT()
  const innerRef = useRef<HTMLDivElement>(null)
  // Высота 3 строк в px — из фактического измерения (корректно при любом fontScale)
  const [clamp, setClamp] = useState<{ collapsed: number } | null>(null)

  const measure = () => {
    const el = innerRef.current
    if (!el) return
    const cs = getComputedStyle(el)
    const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5
    const collapsed = Math.round(line * 3) // ровно 3 строки, как в макете
    const over = el.scrollHeight > collapsed + 4
    // Идемпотентно: не создаём новый объект без изменений — иначе ResizeObserver
    // зациклится на перерендерах
    setClamp((prev) => {
      const next = over ? { collapsed } : null
      if (prev === next || (prev && next && prev.collapsed === next.collapsed)) return prev
      return next
    })
  }

  // ResizeObserver на контейнере: срабатывает и при монтировании, и при смене текста,
  // поздней загрузке шрифта и повороте экрана (div лежит внутри clip-контейнера,
  // поэтому его собственная высота — всегда полная, не обрезанная)
  useEffect(() => {
    const el = innerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const long = text.length > 400
  // Перевод замещает текст на месте (Twitter-style), контрол — строкой под постом
  const tr = useTranslation(postId, text)
  const shown = translatedText(tr, text)

  return (
    <div className="mt-3">
      <div
        className="relative"
        style={{
          maxHeight: clamp ? clamp.collapsed : 9999,
          overflow: 'hidden',
          transition: 'max-height 320ms ease',
        }}
      >
        <div ref={innerRef}>
          <RichText text={shown} />
        </div>
        {/* Оверлей «...еще» на третьей строке → полный экран поста.
            Градиент слева растворяет обрезанный текст под кнопкой */}
        {clamp && (
          <button
            type="button"
            onClick={() => {
              haptic('light')
              onOpenMore?.()
            }}
            aria-label={t('post.readMore')}
            className="absolute bottom-0 right-0 bg-tg-bg pl-2 text-post font-medium text-tg-hint active:opacity-70"
          >
            <span
              aria-hidden
              className="absolute right-full top-0 h-full w-10 bg-gradient-to-r from-transparent to-tg-bg"
            />
            {t('post.more')}
          </button>
        )}
      </div>
      {long && onSummary && (
        <button
          type="button"
          onClick={onSummary}
          className="mt-2 flex w-fit items-center gap-1.5 text-[14px] font-semibold text-tg-link active:opacity-60"
        >
          <Sparkle className="h-4 w-4" />
          {t('post.summary')}
        </button>
      )}
      {/* Перевод: замещает текст на месте + строка-контрол (Twitter-style) */}
      <TranslateControl tr={tr} />
    </div>
  )
}

/** Тело поста: текст/тизер + CTA (общее для постов с медиа и без) */
function PostBody({
  post,
  teaser,
  teaserText,
  onSummary,
  onOpenMore,
}: {
  post: PostDTO
  teaser: boolean
  teaserText: string
  onSummary: () => void
  onOpenMore: () => void
}) {
  const ch = post.channel
  return teaser && ch.teaserMode === 'blur' ? (
    <div className="mt-2">
      <div className="pointer-events-none select-none blur-[7px]" aria-hidden>
        <RichText text={post.text} />
      </div>
      <TeaserCta post={post} />
    </div>
  ) : (
    <div className="mt-0.5">
      <PostText
        text={teaser && ch.teaserMode === 'cut' ? teaserText : post.text}
        postId={post.id}
        onSummary={teaser ? undefined : onSummary}
        onOpenMore={teaser ? undefined : onOpenMore}
      />
      {teaser && <TeaserCta post={post} />}
    </div>
  )
}

export function PostCard({
  post,
  onLike,
  onBookmark,
  onSubscribe,
  onSummary,
  onViewed,
  appearDelay,
}: {
  post: PostDTO
  onLike: () => void
  onBookmark: () => void
  onSubscribe: () => void
  onSummary: () => void
  onViewed?: (postId: string) => void
  /** Задержка stagger-появления карточки (сек); undefined — появление без анимации */
  appearDelay?: number
}) {
  // Задержка появления «прилипает» к первому рендеру карточки: родитель после
  // первой загрузки передаёт undefined, и если бы тип корня менялся на лету
  // (motion.article ↔ article), случился бы remount и повторный счёт просмотра.
  const [appear] = useState(() => appearDelay ?? -1)

  const rootRef = useRef<HTMLElement>(null)
  const viewedRef = useRef(false)
  const openChannel = useApp((s) => s.openChannel)
  const openPost = useApp((s) => s.openPost)
  const t = useT()
  const lang = useApp((s) => s.lang)
  const ch = post.channel
  /** «...еще» → полный экран поста */
  const openFullPost = () => openPost(post)

  // Тизер-режим канала: для неподписанных текст ограничивается
  const teaser =
    !ch.subscribed && ch.teaserMode !== 'none' && post.text.length > ch.teaserLimit
  const teaserText =
    ch.teaserMode === 'cut' ? post.text.slice(0, Math.max(60, ch.teaserLimit)).trimEnd() + '…' : post.text
  const hasMedia =
    (post.media != null && (post.media.url || post.media.name || post.media.question || post.media.link)) ||
    post.gallery.length > 0

  // Просмотр засчитывается, когда пост показался на экране
  useEffect(() => {
    if (viewedRef.current) return
    const el = rootRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[0]
        if (e.intersectionRatio >= 0.7) {
          viewedRef.current = true
          io.disconnect()
          const userId = useApp.getState().user?.id
          if (!userId) return
          api<{ added: number }>('/api/view', {
            method: 'POST',
            body: JSON.stringify({ postIds: [post.id] }),
          })
            .then((r) => {
              if (r?.added > 0) onViewed?.(post.id)
            })
            .catch(() => {})
        }
      },
      { threshold: [0, 0.7] },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [post.id, onViewed])

  // Двойной тап по медиа: ставим лайк, если его не было
  const onMediaDoubleTap = () => {
    haptic('light')
    if (!post.liked) onLike()
  }

  const body = (
    <>
      {/* Шапка канала (тап — экран канала внутри приложения) */}
      <div className="flex items-center gap-3 px-4">
        <button
          type="button"
          onClick={() => {
            haptic('light')
            openChannel(ch.username)
          }}
          aria-label={`Открыть канал ${ch.title}`}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <Avatar
            name={ch.title}
            color={ch.avatarColor}
            src={ch.avatarUrl}
            size={50}
            className={cn(
              'ring-1',
              ch.isPremium ? 'ring-tg-star/50' : 'ring-tg-sep/70',
            )}
          />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate text-[16.5px] font-bold leading-tight text-tg-text">
                {ch.title}
              </span>
              {ch.isPremium && (
                <Star
                  className="h-3.5 w-3.5 shrink-0 fill-tg-star text-tg-star"
                  aria-label={t('post.featuredAria')}
                />
              )}
            </span>
            <span className="mt-0.5 block truncate text-[13.5px] leading-tight text-tg-hint">
              {formatCount(ch.subscribersCount)} {t('post.subscribers')}
            </span>
          </span>
        </button>
        <time
          dateTime={post.publishedAt}
          className="shrink-0 text-[12.5px] text-tg-hint"
          title={new Date(post.publishedAt).toLocaleString(lang === 'en' ? 'en-US' : 'ru-RU')}
        >
          {timeAgo(post.publishedAt, lang)}
        </time>
        <SubscribeCircle subscribed={ch.subscribed} onClick={onSubscribe} />
      </div>

      {/* Медиа + правая панель действий. У текстовых постов без медиа текст стоит
          рядом с рельсом (компактно), у постов с медиа — на всю ширину под медиа */}
      <div className="mt-3.5 flex items-start gap-1.5 px-4">
        <div className="min-w-0 flex-1">
          {hasMedia && <PostMedia post={post} onDoubleTap={onMediaDoubleTap} />}
          {/* Текст поста без медиа — в одну колонку с рельсом */}
          {post.text && !hasMedia && (
            <div className="pt-0.5">
              <PostBody
                post={post}
                teaser={teaser}
                teaserText={teaserText}
                onSummary={onSummary}
                onOpenMore={openFullPost}
              />
            </div>
          )}
        </div>
        <div className="flex w-10 shrink-0 flex-col items-center gap-4 pt-0.5" aria-label={t('card.actions')}>
          <LikeRailButton count={post.likesCount} active={post.liked} onClick={onLike} />
          <RailButton
            icon={Sparkle}
            label={t('post.save')}
            count={post.bookmarksCount}
            active={post.bookmarked}
            onClick={onBookmark}
          />
          <RailButton
            icon={Forward}
            label={t('post.share')}
            onClick={() => sharePost(post.link, ch.title)}
          />
        </div>
      </div>

      {/* Текст поста с медиа — на всю ширину под медиа */}
      {post.text && hasMedia && (
        <div className="px-4">
          <PostBody
            post={post}
            teaser={teaser}
            teaserText={teaserText}
            onSummary={onSummary}
            onOpenMore={openFullPost}
          />
        </div>
      )}

      {/* Мета-строка (ненавязчивая): просмотры — как в оригинальном канале */}
      <div
        className={cn(
          'flex items-center gap-1.5 px-4 text-[12.5px] text-tg-hint',
          post.text ? 'mt-2' : 'mt-3',
        )}
      >
        <Eye className="h-3.5 w-3.5" aria-hidden />
        <span className="tabular-nums">
          {formatCount(post.viewsCount)}
          {post.viewsTg != null ? ` ${t('card.inChannel')}` : ` ${t('card.views')}`}
        </span>
        {post.text && <ListenButton postId={post.id} text={post.text} className="ml-1" />}
      </div>
    </>
  )

  // Stagger-появление: только для первой партии постов при первичной загрузке
  // (appearDelay приходит из FeedView), остальные посты — без анимации.
  return appear >= 0 ? (
    <motion.article
      ref={rootRef}
      className="pb-5 pt-4"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut', delay: appear }}
    >
      {body}
    </motion.article>
  ) : (
    <article ref={rootRef} className="pb-5 pt-4">
      {body}
    </article>
  )
}
