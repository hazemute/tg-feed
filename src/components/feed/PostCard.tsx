'use client'

import { useEffect, useRef, useState } from 'react'
import { Eye, EyeOff, Forward, Heart, MessageCircle, Rocket, Send, Sparkle, Star } from 'lucide-react'
import { motion, useAnimate } from 'framer-motion'
import { cn } from '@/lib/utils'
import { useApp } from '@/lib/store'
import { useT } from '@/lib/i18n'
import { api } from '@/lib/api'
import { formatCount, timeAgo } from '@/lib/format'
import { haptic, openTelegram } from '@/lib/tg'
import type { PostDTO } from '@/lib/types'
import { Avatar } from '@/components/tg/Avatar'
import { VerifiedBadge } from '@/components/tg/VerifiedBadge'
import { RichText } from '@/components/feed/RichText'
import { PostMedia, PostMediaCards, postVisualItems } from '@/components/feed/PostMedia'
import { translatedText, TranslateControl, useTranslation } from '@/components/feed/TranslateButton'
import { ListenButton } from '@/components/feed/TTSButton'
import { RailButton, SubscribeCircle } from '@/components/feed/actions'
import { cutAtWord, TEASER_LINES, useLineTruncate } from '@/lib/clamp-text'
import { useIsDesktop } from '@/lib/use-desktop'

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
      className="flex min-h-[44px] w-full flex-col items-center justify-center gap-1"
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
 * Текст поста ленты: превью — укороченный ДО ЦЕЛОГО СЛОВА текст (5 строк на
 * мобильных) с инлайн-кнопкой «еще» сразу за последним словом — как в нативном
 * Telegram. Кнопка открывает полный экран поста (PostOverlay) — с полным
 * текстом и всеми картинками.
 *
 * Почему так: прежний клип по maxHeight (3 строки + градиент + absolute-кнопка
 * поверх) резал текст посреди строки/слова — владелец: «что бы “еще” было, но
 * что бы не обрезало текст». Теперь превью — это честный укороченный текст:
 * механизм — useLineTruncate (см. lib/clamp-text.ts).
 * На ПК (lg+) текст не обрезаем — читаемость важнее компактности ленты.
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
  // На ПК (lg+) текст не обрезаем — читаемость важнее компактности ленты
  const isDesktop = useIsDesktop()
  const { ref, cut } = useLineTruncate(text, TEASER_LINES, !isDesktop)
  const truncated = cut !== null && cut.length < text.length

  const long = text.length > 400
  // Перевод замещает текст на месте (Twitter-style), контрол — строкой под постом
  const tr = useTranslation(postId, text)
  const shown = translatedText(tr, text)
  // Перевод может быть короче/длиннее оригинала — хук сам пересчитает срез
  const trResult = useLineTruncate(shown, TEASER_LINES, !isDesktop && shown !== text)
  const activeCut = shown !== text ? trResult.cut : cut
  const activeRef = shown !== text ? trResult.ref : ref
  const activeTruncated = activeCut !== null && activeCut.length < shown.length

  return (
    <div className="mt-3">
      <div ref={activeRef}>
        <RichText
          text={activeCut ?? shown}
          trailing={
            activeTruncated && (
              <button
                type="button"
                data-noswipe
                onClick={(e) => {
                  e.stopPropagation()
                  haptic('light')
                  onOpenMore?.()
                }}
                aria-label={t('post.readMore')}
                className="ml-1.5 inline select-none whitespace-nowrap align-baseline text-post font-medium text-tg-hint active:opacity-60"
              >
                {t('post.more')}
              </button>
            )
          }
        />
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

/**
 * Горизонтальный ряд действий для ТЕКСТОВЫХ постов (без медиа).
 * Жалоба владельца: у коротких постов рядом с высоким вертикальным рельсом
 * оставалось огромное пустое место (рельс ~220px против текста в 1-3 строки).
 * Горизонтальный ряд под текстом (как в X/Telegram) убирает пустоту полностью.
 * Кнопка «В историю» уехала в шит «Поделиться» — владелец: она нужна нечасто,
 * а отдельная кнопка перегружала ряд (бардак из подписей на узких экранах).
 */
function TextActionsRow({
  post,
  onLike,
  onBookmark,
}: {
  post: PostDTO
  onLike: () => void
  onBookmark: () => void
}) {
  const t = useT()
  const openComments = useApp((s) => s.openComments)
  const openShareSheet = useApp((s) => s.openShareSheet)
  return (
    <div className="mt-1 flex items-center justify-between pr-2" aria-label={t('card.actions')}>
      <motion.button
        type="button"
        data-noswipe
        whileTap={{ scale: 1.15 }}
        onClick={() => {
          onLike()
          haptic('light')
        }}
        aria-label="Нравится"
        aria-pressed={post.liked}
        className="flex min-h-[44px] items-center gap-1.5 py-1.5 pr-2"
      >
        <Heart
          className={cn(
            'h-[24px] w-[24px] transition-colors',
            post.liked ? 'fill-tg-like text-tg-like' : 'text-tg-text',
          )}
          strokeWidth={post.liked ? 2 : 1.7}
        />
        {post.likesCount > 0 && (
          <span className="text-[13px] font-medium leading-none text-tg-text2 tabular-nums">
            {formatCount(post.likesCount)}
          </span>
        )}
      </motion.button>
      <button
        type="button"
        data-noswipe
        onClick={() => {
          haptic('light')
          openComments(post)
        }}
        aria-label={t('comments.title')}
        className="flex min-h-[44px] items-center gap-1.5 py-1.5 pr-2"
      >
        <MessageCircle className="h-[24px] w-[24px] text-tg-text" strokeWidth={1.7} />
        {post.commentsCount > 0 && (
          <span className="text-[13px] font-medium leading-none text-tg-text2 tabular-nums">
            {formatCount(post.commentsCount)}
          </span>
        )}
      </button>
      <button
        type="button"
        data-noswipe
        onClick={() => {
          onBookmark()
          haptic('light')
        }}
        aria-label={t('post.save')}
        aria-pressed={post.bookmarked}
        className="flex min-h-[44px] items-center gap-1.5 py-1.5 pr-2"
      >
        <Sparkle
          className={cn(
            'h-[24px] w-[24px] transition-colors',
            post.bookmarked ? 'fill-tg-link text-tg-link' : 'text-tg-text',
          )}
          strokeWidth={post.bookmarked ? 2 : 1.7}
        />
        {post.bookmarksCount > 0 && (
          <span className="text-[13px] font-medium leading-none text-tg-text2 tabular-nums">
            {formatCount(post.bookmarksCount)}
          </span>
        )}
      </button>
      <button
        type="button"
        data-noswipe
        onClick={() => {
          haptic('light')
          openShareSheet(post)
        }}
        aria-label={t('post.share')}
        className="flex min-h-[44px] items-center py-1.5"
      >
        <Forward className="h-[24px] w-[24px] text-tg-text" strokeWidth={1.7} />
      </button>
    </div>
  )
}

/** Пост свежее двух часов — рядом со временем показываем зелёную точку «новое» */
const FRESH_MS = 2 * 60 * 60 * 1000

/**
 * Причина рекомендации (чип в мета-строке) — прозрачность ленты: читатель видит,
 * ПОЧЕМУ этот пост ему показан. Эвристика на клиенте (серверные сигналы не выдаём):
 * интересы профиля → «по вашим интересам»; высокое вовлечение → «популярно»;
 * совсем свежий пост → «новое». У подписок и рекламы объяснений не нужно.
 */
function recommendReason(
  post: PostDTO,
  interests: string[],
  lang: 'ru' | 'en',
): { key: 'interests' | 'popular' | 'new'; label: string } | null {
  if (post.sponsored || post.promoted || post.channel.subscribed) return null
  const ageH = Math.max(0, (Date.now() - new Date(post.publishedAt).getTime()) / 3_600_000)
  const inInterests =
    post.channel.categorySlug !== null && interests.includes(post.channel.categorySlug)
  if (inInterests) return { key: 'interests', label: lang === 'ru' ? 'по вашим интересам' : 'for you' }
  const engagement = post.likesCount + post.commentsCount * 3 + post.bookmarksCount * 2
  if (engagement >= 6 && ageH < 48) return { key: 'popular', label: lang === 'ru' ? 'популярно' : 'popular' }
  if (ageH < 3) return { key: 'new', label: lang === 'ru' ? 'новое' : 'new' }
  if (engagement >= 15) return { key: 'popular', label: lang === 'ru' ? 'популярно' : 'popular' }
  return null
}

/** Приблизительное время чтения текста (мин, из расчёта ~180 слов/мин).
 *  Возвращаем 0 для коротких текстов: «1 мин» на каждом посте — шум. */
function readingMinutes(text: string): number {
  const words = text.trim().split(/\s+/).length
  const minutes = Math.round(words / 180)
  return words < 400 ? 0 : Math.max(2, minutes)
}

export function PostCard({
  post,
  onLike,
  onBookmark,
  onSubscribe,
  onSummary,
  onViewed,
  onHide,
  appearDelay,
}: {
  post: PostDTO
  onLike: () => void
  onBookmark: () => void
  onSubscribe: () => void
  onSummary: () => void
  onViewed?: (postId: string) => void
  /** «Не интересно» — скрыть пост из ленты (undefined — кнопка не показывается) */
  onHide?: () => void
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
  const openComments = useApp((s) => s.openComments)
  const openShareSheet = useApp((s) => s.openShareSheet)
  const t = useT()
  const lang = useApp((s) => s.lang)
  const user = useApp((s) => s.user)
  const ch = post.channel
  /** «...еще» → полный экран поста */
  const openFullPost = () => openPost(post)

  // Тизер-режим канала: для неподписанных текст ограничивается
  const teaser =
    !ch.subscribed && ch.teaserMode !== 'none' && post.text.length > ch.teaserLimit
  const teaserText =
    ch.teaserMode === 'cut'
      ? // Срез по границе слова: превью не должно резать слова посередине
        `${cutAtWord(post.text, Math.max(60, ch.teaserLimit)).trimEnd()}…`
      : post.text
  /* Визуал определяет раскладку ряда (высокий блок рядом с рельсов действий);
     карточки (ссылка/файл/опрос…) рисуем ПОД текстом — иначе короткая карточка
     рядом с высокой рельсов оставляла огромную пустоту (жалоба владельца). */
  const hasVisuals = postVisualItems(post).length > 0
  const hasCards =
    (post.media != null && (post.media.url || post.media.name || post.media.question || post.media.link)) ||
    post.gallery.length > 0

  const dwellCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => () => dwellCleanupRef.current?.(), [])
  // Dwell-трекинг: пока ≥50% карточки в вьюпорте — капает время. Флаш каждые
  // 15с и при уходе карточки с экрана (unmount). Ошибки тихие.
  const startDwellTracking = () => {
    const el = rootRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    let visible = false
    let buffer = 0
    let lastTick = Date.now()

    const vis = new IntersectionObserver((entries) => {
      visible = (entries[0]?.intersectionRatio ?? 0) >= 0.5
    }, { threshold: [0, 0.5] })
    vis.observe(el)

    const flush = () => {
      if (buffer < 2000) return // короткие проблески — шум
      const ms = buffer
      buffer = 0
      api('/api/view/dwell', { method: 'POST', body: JSON.stringify({ postId: post.id, ms }) }).catch(() => {})
    }

    const timer = setInterval(() => {
      const now = Date.now()
      const delta = now - lastTick
      lastTick = now
      if (visible) buffer += delta
      if (buffer >= 15_000) flush()
    }, 1_000)

    const cleanup = () => {
      const now = Date.now()
      if (visible) buffer += now - lastTick
      clearInterval(timer)
      vis.disconnect()
      // buffer обнуляем после отправки: pagehide + последующий unmount вызывают
      // cleanup дважды — без обнуления одно и то же время ушло бы дважды
      if (buffer >= 2000) {
        const ms = buffer
        buffer = 0
        // sendBeacon не тянем (нужны заголовки сессии) — обычный fire-and-forget
        api('/api/view/dwell', { method: 'POST', body: JSON.stringify({ postId: post.id, ms }) }).catch(() => {})
      }
    }
    // Флаш при анмаунте карточки
    const onUnload = () => cleanup()
    window.addEventListener('pagehide', onUnload)
    dwellCleanupRef.current = () => {
      window.removeEventListener('pagehide', onUnload)
      cleanup()
    }
  }

  // Просмотр засчитывается, когда пост показался на экране; ПОСЛЕ этого копим
  // dwell — время карточки в вьюпорте (сигнал интереса для рекомендаций)
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
          startDwellTracking()
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
            size={46}
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
              {ch.verified && <VerifiedBadge size={15} />}
              {ch.isPremium && (
                <Star
                  className="h-3.5 w-3.5 shrink-0 fill-tg-star text-tg-star"
                  aria-label={t('post.featuredAria')}
                />
              )}
            </span>
            {/* Без данных подписчиков (0/null) строку не рисуем — «0 подписчиков» вводит в заблуждение */}
            {ch.subscribersCount > 0 && (
              <span className="mt-0.5 block truncate text-[13.5px] leading-tight text-tg-hint">
                {formatCount(ch.subscribersCount)} {t('post.subscribers')}
              </span>
            )}
          </span>
        </button>
        <time
          dateTime={post.publishedAt}
          className="flex shrink-0 items-center gap-1.5 text-[12.5px] text-tg-hint"
          title={new Date(post.publishedAt).toLocaleString(lang === 'en' ? 'en-US' : 'ru-RU')}
        >
          {/* Честная метка спонсорского поста (обязательна по правилам Telegram Ads) */}
          {post.sponsored && (
            <span
              className="rounded-full bg-tg-surface px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-tg-hint"
              title="Спонсорский пост"
            >
              Реклама
            </span>
          )}
          {/* Промо-пост (Snap Pro): заметная плашка продвижения — строгий
              монохром (инверсия текст/фон), без градиентов (стиль v5.34) */}
          {post.promoted && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-tg-text px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-tg-bg"
              title="Пост продвинут автором канала"
            >
              <Rocket className="h-3 w-3" aria-hidden />
              Продвинуто
            </span>
          )}
          {Date.now() - new Date(post.publishedAt).getTime() < FRESH_MS && (
            <span
              aria-label="Новый пост"
              title="Новый пост"
              className="h-2 w-2 rounded-full bg-tg-green"
            />
          )}
          {timeAgo(post.publishedAt, lang)}
        </time>
        <SubscribeCircle subscribed={ch.subscribed} onClick={onSubscribe} />
      </div>

      {/* Медиа + вертикальный рельс (у медиа-постов пустот нет — медиа высокое).
          ТЕКСТОВЫЕ посты (без медиа) — другая раскладка: текст на всю ширину и
          ГОРИЗОНТАЛЬНЫЙ ряд действий под ним (вертикальный рельс оставлял
          огромное пустое место у коротких текстов — жалоба владельца). */}
      {hasVisuals ? (
        <div className="mt-3.5 flex items-start gap-1.5 px-4">
          <div className="min-w-0 flex-1">
            <PostMedia post={post} hideCards onDoubleTap={onMediaDoubleTap} />
          </div>
          <div className="flex w-10 shrink-0 flex-col items-center gap-3.5 pt-0.5" aria-label={t('card.actions')}>
            <LikeRailButton count={post.likesCount} active={post.liked} onClick={onLike} />
            <RailButton
              icon={MessageCircle}
              label={t('comments.title')}
              count={post.commentsCount}
              onClick={() => {
                haptic('light')
                openComments(post)
              }}
            />
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
              onClick={() => openShareSheet(post)}
            />
          </div>
        </div>
      ) : (
        <div className="px-4">
          {post.text && (
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
          <TextActionsRow post={post} onLike={onLike} onBookmark={onBookmark} />
        </div>
      )}

      {/* Текст поста с визуалом — на всю ширину под медиа */}
      {post.text && hasVisuals && (
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

      {/* Карточки (ссылка/файл/голос/опрос) — под текстом, на всю ширину:
          линк-превью после текста как в Telegram, без пустот у рельсы */}
      {hasCards && (
        <div className="px-4">
          <PostMediaCards post={post} />
        </div>
      )}

      {/* Мета-строка (ненавязчивая): просмотры — как в оригинальном канале;
          у длинных текстов — время чтения; справа — «Не интересно» (скрыть пост) */}
      <div
        className={cn(
          'flex items-center gap-1.5 px-4 text-[12.5px] text-tg-hint',
          post.text ? 'mt-2' : 'mt-3',
        )}
      >
        <Eye className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="tabular-nums">
          {formatCount(post.viewsCount)}
          {post.viewsTg != null ? ` ${t('card.inChannel')}` : ` ${t('card.views')}`}
        </span>
        {(() => {
          const reason = recommendReason(post, user?.categories ?? [], lang)
          return (
            reason && (
              <span
                className="shrink-0 rounded-full bg-tg-link/10 px-1.5 py-0.5 text-[10.5px] font-semibold leading-none text-tg-link"
                title={t('feed.reasonHint')}
              >
                {reason.label}
              </span>
            )
          )
        })()}
        {(() => {
          // «N мин» только у реально длинных текстов (≥2 мин) — иначе «1 мин»
          // прилипает к каждому посту и превращается в шум
          const mins = post.text.length > 280 ? readingMinutes(post.text) : 0
          return (
            mins > 0 && (
              <span className="shrink-0 tabular-nums" title={t('feed.minRead')}>
                · {mins} {t('feed.minRead')}
              </span>
            )
          )
        })()}
        {post.text && <ListenButton postId={post.id} text={post.text} className="ml-1" />}
        {onHide && (
          <button
            type="button"
            data-noswipe
            onClick={(e) => {
              e.stopPropagation()
              haptic('light')
              onHide()
            }}
            aria-label={t('feed.notInterested')}
            title={t('feed.notInterested')}
            className="ml-auto -mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-tg-hint transition active:scale-90 active:bg-tg-sep/50"
          >
            <EyeOff className="h-[15px] w-[15px]" aria-hidden />
          </button>
        )}
      </div>
    </>
  )

  // Stagger-появление: только для первой партии постов при первичной загрузке
  // (appearDelay приходит из FeedView), остальные посты — без анимации.
  // v5.58 (60 FPS): feed-card = content-visibility:auto — офф-скрин карточки
  // не участвуют в layout/paint, скролл длинной ленты остаётся плавным.
  const cardShell = cn('feed-card pb-5 pt-4', post.promoted && 'promoted-card')
  return appear >= 0 ? (
    <motion.article
      ref={rootRef}
      className={cardShell}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut', delay: appear }}
    >
      {body}
    </motion.article>
  ) : (
    <article ref={rootRef} className={cardShell}>
      {body}
    </article>
  )
}
