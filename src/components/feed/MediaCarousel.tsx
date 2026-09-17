'use client'

import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Heart, Play, Volume2, VolumeX } from 'lucide-react'
import { cn } from '@/lib/utils'
import { haptic } from '@/lib/tg'
import type { MediaItemDTO } from '@/lib/types'
import { MediaSpoiler } from '@/components/feed/MediaSpoiler'

/**
 * Ширина «выглядывания» соседних слайдов в peek-макете, px (~12–16).
 * Должна совпадать с классами спейсеров (before/after w-3.5) и scroll-px-3.5
 * у скролл-контейнера — единый источник геометрии peek-областей.
 */
const PEEK_PX = 14

/** Слайд карусели: видео/гиф — автоплеем, остальное — картинкой. Тап — просмотр, ошибка загрузки скрывает слайд */
function SlideVisual({
  item,
  alt,
  i,
  onHide,
  onClick,
}: {
  item: MediaItemDTO
  alt: string
  i: number
  onHide: React.Dispatch<React.SetStateAction<Set<number>>>
  onClick?: () => void
}) {
  const hide = () =>
    onHide((h) => {
      const n = new Set(h)
      n.add(i)
      return n
    })
  if (item.kind === 'video' || item.kind === 'gif') {
    return (
      <video
        src={item.url}
        poster={item.poster}
        aria-label={`${alt} — видео ${i + 1}`}
        muted
        loop
        autoPlay
        playsInline
        preload="metadata"
        onError={hide}
        onClick={onClick}
        className="mx-auto aspect-[4/5] max-h-[54dvh] w-full cursor-zoom-in rounded-[14px] bg-tg-surface object-cover"
      />
    )
  }
  return (
    <img
      src={item.url}
      alt={`${alt} — изображение ${i + 1}`}
      loading="lazy"
      onError={hide}
      onClick={onClick}
      className={cn(
        'mx-auto max-h-[54dvh] w-full cursor-zoom-in rounded-[14px]',
        item.kind === 'sticker'
          ? 'max-h-[44dvh] max-w-[300px] bg-transparent object-contain'
          : 'aspect-[4/5] bg-tg-surface object-cover',
      )}
      draggable={false}
    />
  )
}

/**
 * Медиаблок: картинка или горизонтальный swiper с лаконичными точками.
 * Peek-макет: активный слайд занимает центр, края соседних выглядывают по бокам
 * (~14px с каждой стороны, как в Telegram/Instagram). При одиночной картинке —
 * на всю ширину без peek. Двойной тап по медиа — лайк с всплывающим сердцем.
 * Изображения — lazy loading, битые URL аккуратно скрываются.
 *
 * Геометрия peek: спейсеры 14px по краям строки слайдов (псевдоэлементы —
 * в отличие от padding-right скролл-контейнера они гарантированно учитываются
 * при прокрутке до конца), слайды встык шириной calc(100% - 2*peek).
 * Тогда шаг между слайдами равен ширине слайда и позиция центрирования
 * слайда i — это ровно i * slideWidth (последний слайд тоже центрируется).
 */
export function MediaCarousel({
  items,
  alt,
  onDoubleTap,
  onOpenIndex,
}: {
  /** Слайды карусели: фото, видео, GIF и стикеры (визуальные типы) */
  items: MediaItemDTO[]
  alt: string
  onDoubleTap?: () => void
  /** Одиночный тап по слайду — открыть полноэкранный просмотр с этого слайда */
  onOpenIndex?: (index: number) => void
}) {
  const list = items.filter((x) => !!x.url)
  const ref = useRef<HTMLDivElement>(null)
  const [idx, setIdx] = useState(0)
  const [hidden, setHidden] = useState<Set<number>>(new Set())
  const [popKey, setPopKey] = useState(0)
  const tapTimer = useRef<number | null>(null)

  const visible = list.map((_, i) => i).filter((i) => !hidden.has(i))
  if (list.length === 0 || visible.length === 0) return null

  // Peek нужен только при 2+ видимых слайдах; одиночная картинка — на всю ширину
  const peek = visible.length > 1

  // Активный слайд для UI: если текущий скрылся (битая картинка) — первый видимый
  const activeIdx = visible.includes(idx) ? idx : (visible[0] ?? 0)

  /**
   * Активный слайд — ближайший к центру скролл-контейнера:
   * сравниваем scrollLeft + clientWidth/2 с центром слайда (offsetLeft + offsetWidth/2).
   * el.children содержит только видимые слайды (в порядке visible), поэтому позицию
   * ребёнка переводим в оригинальный индекс через visible[pos] — эффекты, точки
   * и счётчик остаются привязаны к оригинальным индексам списка.
   */
  const onScroll = () => {
    const el = ref.current
    if (!el) return
    const center = el.scrollLeft + el.clientWidth / 2
    let bestPos = 0
    let bestDist = Infinity
    for (let pos = 0; pos < el.children.length; pos++) {
      const child = el.children[pos]
      if (!(child instanceof HTMLElement)) continue
      const dist = Math.abs(child.offsetLeft + child.offsetWidth / 2 - center)
      if (dist < bestDist) {
        bestDist = dist
        bestPos = pos
      }
    }
    const origIdx = visible[bestPos]
    if (origIdx !== undefined && origIdx !== idx) setIdx(origIdx)
  }

  /**
   * Прыжок к слайду i (оригинальный индекс, как в точках-табах).
   * Позиция центрирования считается через offsetLeft ребёнка относительно
   * скролл-контейнера (он position: relative — его offsetParent),
   * а не умножением на clientWidth: так смещения от peek-спейсеров
   * и скрытых (битых) слайдов учтены автоматически.
   */
  const goTo = (i: number) => {
    const el = ref.current
    if (!el) return
    const pos = visible.indexOf(i)
    const child = el.children[pos]
    if (!(child instanceof HTMLElement)) return
    // Сдвигаем так, чтобы центр слайда совпал с центром контейнера
    const left = Math.max(0, child.offsetLeft + child.offsetWidth / 2 - el.clientWidth / 2)
    // Мгновенный отклик UI (точки/счётчик), onScroll подтвердит фактическую позицию
    setIdx(i)
    el.scrollTo({ left, behavior: 'smooth' })
  }

  const handleDouble = () => {
    if (tapTimer.current) {
      window.clearTimeout(tapTimer.current)
      tapTimer.current = null
    }
    setPopKey((k) => k + 1)
    onDoubleTap?.()
  }

  /** Одиночный тап — открыть просмотр (двойной успевает отменить таймер) */
  const handleSingle = (slide: number) => {
    if (!onOpenIndex || tapTimer.current) return
    tapTimer.current = window.setTimeout(() => {
      tapTimer.current = null
      onOpenIndex(slide)
    }, 260)
  }

  return (
    <div className="relative select-none" data-noswipe onDoubleClick={handleDouble}>
      <div
        ref={ref}
        onScroll={onScroll}
        className={cn(
          // relative — offsetParent слайдов: offsetLeft считается от контейнера
          'no-scrollbar relative flex snap-x snap-mandatory overflow-x-auto rounded-[14px] bg-tg-surface',
          peek &&
            "scroll-px-3.5 before:content-[''] before:block before:w-3.5 before:shrink-0 after:content-[''] after:block after:w-3.5 after:shrink-0",
        )}
      >
        {list.map((item, i) =>
          hidden.has(i) ? null : (
            <div
              key={i}
              className={cn('shrink-0 snap-center', !peek && 'w-full')}
              style={peek ? { width: `calc(100% - ${PEEK_PX * 2}px)` } : undefined}
            >
              <div
                className="relative transition-transform duration-300 ease-out"
                style={{
                  transform: `scale(${activeIdx === i ? 1 : 0.94})`,
                  opacity: activeIdx === i ? 1 : 0.75,
                }}
              >
                {item.spoiler ? (
                  <MediaSpoiler>
                    <SlideVisual item={item} alt={alt} i={i} onHide={setHidden} onClick={() => handleSingle(i)} />
                  </MediaSpoiler>
                ) : (
                  <SlideVisual item={item} alt={alt} i={i} onHide={setHidden} onClick={() => handleSingle(i)} />
                )}
              </div>
            </div>
          ),
        )}
      </div>

      {/* Сердце при двойном тапе */}
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

      {visible.length > 1 && (
        <>
          <div className="pointer-events-none absolute inset-x-0 bottom-2.5 flex items-center justify-center gap-1.5">
            {visible.map((i) => (
              <span
                key={i}
                className={cn(
                  'h-1.5 rounded-full transition-all duration-200',
                  activeIdx === i ? 'w-4 bg-white' : 'w-1.5 bg-white/50',
                )}
                style={{ boxShadow: '0 0 3px rgba(0,0,0,0.35)' }}
              />
            ))}
          </div>
          {/* Широкая кликабельная зона точек — тап по половинкам прыгает на соседний слайд */}
          <div
            className="absolute inset-x-0 bottom-0 flex h-8 cursor-pointer"
            role="tablist"
            aria-label="Навигация по медиа"
          >
            {visible.map((i) => (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={activeIdx === i}
                aria-label={`Изображение ${i + 1} из ${visible.length}`}
                onClick={(e) => {
                  e.stopPropagation()
                  goTo(i)
                }}
                className="h-full flex-1"
              />
            ))}
          </div>
          <div className="pointer-events-none absolute right-3 top-3 rounded-full bg-black/45 px-2 py-0.5 text-[11px] font-medium text-white">
            {Math.min(activeIdx + 1, visible.length)}/{visible.length}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Видеопост: автоплей без звука, когда видео видно на ≥60% (и пауза вне кадра),
 * кнопка звука, тонкий прогресс-бар, одиночный тап — пауза/плей, двойной — лайк.
 */
export function VideoPlayer({
  src,
  alt,
  onDoubleTap,
  onOpen,
}: {
  src: string
  alt: string
  onDoubleTap?: () => void
  /** Одиночный тап — открыть полноэкранный просмотр (как в Telegram) */
  onOpen?: () => void
}) {
  const vidRef = useRef<HTMLVideoElement>(null)
  const progressRef = useRef<HTMLDivElement>(null)
  const clickTimer = useRef<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(true)

  // Автоплей по видимости (как в нативных лентах)
  useEffect(() => {
    const v = vidRef.current
    if (!v || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[0]
        if (e.intersectionRatio >= 0.6) {
          v.play().catch(() => {})
        } else {
          v.pause()
        }
      },
      { threshold: [0, 0.6] },
    )
    io.observe(v)
    return () => io.disconnect()
  }, [])

  const togglePlay = () => {
    const v = vidRef.current
    if (!v) return
    if (v.paused) v.play().catch(() => {})
    else v.pause()
  }

  // Одиночный тап — открыть полный экран (с задержкой, чтобы двойной успел отменить)
  const onClick = () => {
    if (clickTimer.current) return
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = null
      if (onOpen) {
        haptic('light')
        onOpen()
      } else togglePlay()
    }, 260)
  }
  const onDoubleClick = () => {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current)
      clickTimer.current = null
    }
    onDoubleTap?.()
  }

  const onTimeUpdate = () => {
    const v = vidRef.current
    if (!v || !v.duration) return
    if (progressRef.current) {
      progressRef.current.style.width = `${(v.currentTime / v.duration) * 100}%`
    }
  }

  return (
    <div className="relative select-none" data-noswipe onClick={onClick} onDoubleClick={onDoubleClick}>
      <video
        ref={vidRef}
        src={src}
        aria-label={alt}
        muted={muted}
        loop
        playsInline
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={onTimeUpdate}
        onError={(e) => {
          const el = e.currentTarget
          el.style.display = 'none'
        }}
        className="mx-auto aspect-[4/5] max-h-[54dvh] w-full rounded-[14px] bg-tg-surface object-cover"
      />

      {/* Оверлей «пауза» */}
      <AnimatePresence>
        {!playing && (
          <motion.span
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.7 }}
            transition={{ duration: 0.16 }}
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
            aria-hidden
          >
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-black/40 backdrop-blur-sm">
              <Play className="ml-0.5 h-7 w-7 fill-white text-white" />
            </span>
          </motion.span>
        )}
      </AnimatePresence>

      {/* Кнопка звука */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          const v = vidRef.current
          if (!v) return
          v.muted = !v.muted
          setMuted(v.muted)
        }}
        aria-label={muted ? 'Включить звук' : 'Выключить звук'}
        className="absolute bottom-3.5 right-3 flex h-8 w-8 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition active:scale-90"
      >
        {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
      </button>

      {/* Прогресс-бар */}
      <div className="pointer-events-none absolute inset-x-3 bottom-2 h-[3px] overflow-hidden rounded-full bg-white/25" aria-hidden>
        <div ref={progressRef} className="h-full w-0 rounded-full bg-white" />
      </div>
    </div>
  )
}
