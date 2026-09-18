'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { haptic } from '@/lib/tg'
import type { MediaItemDTO } from '@/lib/types'

/**
 * Полноэкранный просмотр медиа (как в Telegram): тап по фото/видео/гиф/стикеру
 * открывает во весь экран. Свайп вниз/тап по фону — закрыть; стрелки и свайп
 * по горизонтали — листание галереи; двойной тап — зум 1↔2.5 в точке тапа;
 * кнопка «Скачать» — файл через наш прокси (Content-Disposition: attachment).
 */

/** Проксированный URL для скачивания (u уже проксирован — достаём оригинал) */
function downloadUrl(url: string): string {
  try {
    const m = url.match(/[?&]u=([^&]+)/)
    const origin = m ? decodeURIComponent(m[1]) : url
    if (origin.startsWith('https://')) {
      return `/api/media?u=${encodeURIComponent(origin)}&dl=1`
    }
    return url
  } catch {
    return url
  }
}

export function MediaLightbox({
  items,
  index,
  onClose,
}: {
  items: MediaItemDTO[]
  index: number
  onClose: () => void
}) {
  const [i, setI] = useState(index)
  const [zoom, setZoom] = useState(1)
  const [origin, setOrigin] = useState('50% 50%')
  const clickTimer = useRef<number | null>(null)

  const item = items[i]
  const go = useCallback(
    (d: number) => {
      setZoom(1)
      setI((prev) => {
        const next = prev + d
        if (next < 0 || next >= items.length) return prev
        haptic('light')
        return next
      })
    },
    [items.length],
  )

  // Клавиатура: Esc — закрыть, стрелки — листать
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') go(-1)
      if (e.key === 'ArrowRight') go(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, onClose])

  // Блокируем прокрутку фона
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  if (!item) return null

  const isVideo = item.kind === 'video' || item.kind === 'gif'
  const isSticker = item.kind === 'sticker'

  /** Одиночный тап — закрыть; двойной — зум (таймер разделяет жесты) */
  const onSurfaceClick = (e: React.MouseEvent) => {
    if (clickTimer.current) {
      window.clearTimeout(clickTimer.current)
      clickTimer.current = null
      // двойной тап: зум в точке тапа
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const x = ((e.clientX - rect.left) / rect.width) * 100
      const y = ((e.clientY - rect.top) / rect.height) * 100
      setOrigin(`${x}% ${y}%`)
      setZoom((z) => (z > 1 ? 1 : 2.5))
      return
    }
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = null
      onClose()
    }, 260)
  }

  return (
    <motion.div
      className="fixed inset-0 z-[90] flex flex-col bg-black/97"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      role="dialog"
      aria-modal="true"
      aria-label="Просмотр медиа"
      data-noswipe
    >
      {/* Верхняя панель */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between bg-gradient-to-b from-black/60 to-transparent px-2 pb-8 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={onClose}
          aria-label="Закрыть"
          className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full text-white active:bg-white/10"
        >
          <X className="h-6 w-6" />
        </button>
        <span className="text-[13px] font-medium tabular-nums text-white/80">
          {i + 1} / {items.length}
        </span>
        <a
          href={downloadUrl(item.url ?? '')}
          download
          onClick={(e) => {
            e.stopPropagation()
            haptic('light')
          }}
          aria-label="Скачать"
          className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full text-white active:bg-white/10"
        >
          <Download className="h-5.5 w-5.5" />
        </a>
      </div>

      {/* Контент: свайп вниз — закрыть; горизонталь — листание */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        <AnimatePresence initial={false} mode="wait">
          <motion.div
            key={i}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.16 }}
            className="flex h-full w-full items-center justify-center"
            drag={zoom === 1 ? true : false}
            dragElastic={0.35}
            dragConstraints={{ left: 0, right: 0, top: 0, bottom: 0 }}
            onDragEnd={(_, info) => {
              const dy = info.offset.y
              const dx = info.offset.x
              if (dy > 110 && Math.abs(dy) > Math.abs(dx)) onClose()
              else if (dx < -70 && items.length > 1) go(1)
              else if (dx > 70 && items.length > 1) go(-1)
            }}
          >
            {isVideo ? (
              <video
                src={item.url}
                poster={item.poster}
                controls
                autoPlay
                loop={item.kind === 'gif'}
                playsInline
                onClick={(e) => e.stopPropagation()}
                className="max-h-[86dvh] max-w-full object-contain"
              />
            ) : (
              <img
                src={item.url}
                alt="Медиа поста"
                draggable={false}
                onClick={onSurfaceClick}
                onDoubleClick={(e) => {
                  // дублируем зум по dblclick (десктоп)
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  const x = ((e.clientX - rect.left) / rect.width) * 100
                  const y = ((e.clientY - rect.top) / rect.height) * 100
                  setOrigin(`${x}% ${y}%`)
                  setZoom((z) => (z > 1 ? 1 : 2.5))
                }}
                style={{
                  transform: `scale(${zoom})`,
                  transformOrigin: origin,
                  transition: 'transform 0.2s ease',
                }}
                className={cn(
                  'max-h-[86dvh]',
                  isSticker ? 'max-w-[80vw] object-contain' : 'w-full max-w-[100vw] object-contain',
                  zoom > 1 ? 'cursor-zoom-out' : 'cursor-zoom-in',
                )}
              />
            )}
          </motion.div>
        </AnimatePresence>

        {/* Стрелки (десктоп/галерея) */}
        {items.length > 1 && i > 0 && (
          <button
            type="button"
            aria-label="Предыдущее"
            onClick={() => go(-1)}
            className="absolute left-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-sm active:scale-90"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}
        {items.length > 1 && i < items.length - 1 && (
          <button
            type="button"
            aria-label="Следующее"
            onClick={() => go(1)}
            className="absolute right-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-sm active:scale-90"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        )}
      </div>
    </motion.div>
  )
}
