'use client'

import { useEffect, useRef, useState } from 'react'
import { Eye, Forward, Heart, Sparkle, Star } from 'lucide-react'
import { motion, useAnimate } from 'framer-motion'
import { cn } from '@/lib/utils'
import { useApp } from '@/lib/store'
import { api } from '@/lib/api'
import { formatCount, timeAgoRu } from '@/lib/format'
import { sharePost, haptic } from '@/lib/tg'
import type { PostDTO } from '@/lib/types'
import { Avatar } from '@/components/tg/Avatar'
import { MediaCarousel, VideoPlayer } from '@/components/feed/MediaCarousel'
import { RailButton, SubscribeCircle } from '@/components/feed/actions'

/**
 * Пост ленты по макету:
 * шапка канала (аватар, название, подписчики, круглая [+]),
 * медиа с правой панелью действий, текст с «...еще».
 * Двойной тап по медиа — лайк со всплывающим сердцем.
 * #хэштеги в тексте кликабельны — открывают поиск по теме.
 */

// Хэштег: # + 2–30 символа латиницы/цифр/подчёркивания или кириллицы (а-яё).
// Регистр учитывается (без флага i), флаг u обязателен для кириллического класса.
// Глобальный флаг безопасен: matchAll не мутирует lastIndex исходного регэкспа.
const HASHTAG_RE = /#[\wа-яё]{2,30}/gu

/** Разбивает текст поста на обычные фрагменты и хэштеги (для инлайн-рендера) */
export function tokenizeHashtags(text: string): Array<string | { tag: string }> {
  const parts: Array<string | { tag: string }> = []
  let last = 0
  for (const m of text.matchAll(HASHTAG_RE)) {
    const i = m.index ?? 0
    if (i > last) parts.push(text.slice(last, i))
    parts.push({ tag: m[0] })
    last = i + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

/**
 * Кнопка лайка: как RailButton, но счётчик пружинно подпрыгивает
 * при изменении числа (spring 1.25 → 1, ~250мс; не анимируется при первом рендере).
 * Локальная копия, т.к. actions.tsx вне зоны правок этого агента.
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

/**
 * Текст поста ленты: clamp ровно 3 строки, кнопка «...еще» в правом нижнем углу
 * обрезанного блока открывает полный экран поста (PostOverlay) — с полным текстом
 * и всеми картинками.
 *
 * Почему absolute, а не float: кнопка-float стоит ПОСЛЕ абзаца с полным текстом —
 * при обрезке overflow:hidden она попадает под линию отсечки и становится невидимой.
 * Абсолютная кнопка привязана к НИЗУ обрезанного контейнера (низ = конец 3-й строки)
 * и всегда видима. Слева от кнопки — градиент под цвет фона, текст под ней
 * растворяется без жёсткого края.
 * Хэштег — inline-кнопка с унаследованными текстовыми метриками, поэтому
 * высотный clamp не ломается. Каналы (ChannelSheet) используют ExpandableText.
 */
function PostText({
  text,
  onSummary,
  onOpenMore,
}: {
  text: string
  onSummary?: () => void
  onOpenMore?: () => void
}) {
  const innerRef = useRef<HTMLParagraphElement>(null)
  // Высота 3 строк в px — из фактического измерения (корректно при любом fontScale)
  const [clamp, setClamp] = useState<{ collapsed: number } | null>(null)
  const openSearchWith = useApp((s) => s.openSearchWith)

  const measure = () => {
    const el = innerRef.current
    if (!el) return
    const cs = getComputedStyle(el)
    // Реальная высота строки из computed style (было жёстко 1.42 при фактических 1.5 —
    // из-за этого отсечение врезалось в 3-ю строку, а «...еще» оставалось под обрезкой)
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

  // ResizeObserver на абзаце: срабатывает и при монтировании, и при смене текста,
  // поздней загрузке шрифта и повороте экрана (p лежит внутри clip-контейнера,
  // поэтому его собственная высота — всегда полная, не обрезанная)
  useEffect(() => {
    const el = innerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const long = text.length > 400

  // Токенизация по ПОЛНОМУ тексту: видимость «...еще» считается по высоте
  // (maxHeight + overflow hidden), а не обрезкой строки, поэтому кликабельность
  // хэштегов работает одинаково в свёрнутом и раскрытом виде.
  const parts = tokenizeHashtags(text)

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
        <p ref={innerRef} className="text-post whitespace-pre-line break-words text-tg-text">
          {parts.map((part, i) =>
            typeof part === 'string' ? (
              part
            ) : (
              <button
                key={i}
                type="button"
                aria-label={`Найти по теме ${part.tag}`}
                onClick={(e) => {
                  e.stopPropagation() // не задеваем обработчики поста и ленты
                  haptic('light')
                  // Статистика клика по хэштегу → тренды «Сейчас обсуждают»
                  api('/api/hashtags/click', {
                    method: 'POST',
                    body: JSON.stringify({ tag: part.tag.slice(1) }),
                  }).catch(() => {})
                  openSearchWith(part.tag.slice(1)) // ищем по слову без решётки
                }}
                className="text-tg-link active:opacity-60"
              >
                {part.tag}
              </button>
            ),
          )}
        </p>
        {/* Оверлей «...еще» на третьей строке → полный экран поста.
            Градиент слева растворяет обрезанный текст под кнопкой */}
        {clamp && (
          <button
            type="button"
            onClick={() => {
              haptic('light')
              onOpenMore?.()
            }}
            aria-label="Читать пост полностью"
            className="absolute bottom-0 right-0 bg-tg-bg pl-2 text-post font-medium text-tg-hint active:opacity-70"
          >
            <span
              aria-hidden
              className="absolute right-full top-0 h-full w-10 bg-gradient-to-r from-transparent to-tg-bg"
            />
            ...еще
          </button>
        )}
      </div>
      {long && onSummary && (
        <button
          type="button"
          onClick={onSummary}
          className="mt-2 inline-flex items-center gap-1.5 text-[14px] font-semibold text-tg-link active:opacity-60"
        >
          <Sparkle className="h-4 w-4" />
          Краткое содержание
        </button>
      )}
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
  const ch = post.channel

  /** «...еще» → полный экран поста */
  const openFullPost = () => openPost(post)

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

  const images = [post.mediaUrl, ...post.gallery].filter((x): x is string => !!x)

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
                  aria-label="Продвинутый канал"
                />
              )}
            </span>
            <span className="mt-0.5 block truncate text-[13.5px] leading-tight text-tg-hint">
              {formatCount(ch.subscribersCount)} подписчиков
            </span>
          </span>
        </button>
        <time
          dateTime={post.publishedAt}
          className="shrink-0 text-[12.5px] text-tg-hint"
          title={new Date(post.publishedAt).toLocaleString('ru-RU')}
        >
          {timeAgoRu(post.publishedAt)}
        </time>
        <SubscribeCircle subscribed={ch.subscribed} onClick={onSubscribe} />
      </div>

      {/* Медиа + правая панель действий (у текстовых постов текст идёт рядом с рельсом) */}
      <div className="mt-3.5 flex items-start gap-1.5 px-4">
        <div className="min-w-0 flex-1">
          {post.mediaType === 'video' && post.mediaUrl ? (
            <VideoPlayer
              src={post.mediaUrl}
              alt={`Видео канала «${ch.title}»`}
              onDoubleTap={onMediaDoubleTap}
            />
          ) : (
            images.length > 0 && (
              <MediaCarousel
                images={images}
                alt={`Пост канала «${ch.title}»`}
                onDoubleTap={onMediaDoubleTap}
              />
            )
          )}
          {/* Текст поста без медиа — в одну колонку с рельсом */}
          {post.text && images.length === 0 && !(post.mediaType === 'video' && post.mediaUrl) && (
            <div className="pt-1">
              <PostText text={post.text} onSummary={onSummary} onOpenMore={openFullPost} />
            </div>
          )}
        </div>
        <div className="flex w-10 shrink-0 flex-col items-center gap-4" aria-label="Действия">
          <LikeRailButton count={post.likesCount} active={post.liked} onClick={onLike} />
          <RailButton
            icon={Sparkle}
            label="Сохранить"
            count={post.bookmarksCount}
            active={post.bookmarked}
            onClick={onBookmark}
          />
          <RailButton
            icon={Forward}
            label="Поделиться"
            onClick={() => sharePost(post.link, ch.title)}
          />
        </div>
      </div>

      {/* Текст поста с медиа — на всю ширину под медиа */}
      {post.text && (images.length > 0 || (post.mediaType === 'video' && post.mediaUrl)) && (
        <div className="px-4">
          <PostText text={post.text} onSummary={onSummary} onOpenMore={openFullPost} />
        </div>
      )}

      {/* Мета-строка (ненавязчивая) */}
      <div
        className={cn(
          'flex items-center gap-1.5 px-4 text-[12.5px] text-tg-hint',
          post.text ? 'mt-2' : 'mt-3',
        )}
      >
        <Eye className="h-3.5 w-3.5" aria-hidden />
        <span className="tabular-nums">{formatCount(post.viewsCount)} просмотров</span>
        {!post.text && (
          <button
            type="button"
            onClick={onSummary}
            className="ml-auto inline-flex items-center gap-1 font-medium text-tg-link active:opacity-60"
          >
            <Sparkle className="h-3.5 w-3.5" /> Краткое содержание
          </button>
        )}
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
