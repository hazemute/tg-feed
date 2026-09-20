'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * Экономное изображение («сбережение трафика»):
 *  • скелетон с shimmer, пока картинка не загружена;
 *  • плавное появление (fade-in 300мс) после загрузки;
 *  • ПОЛНАЯ картинка качается, когда блок во вьюпорте и пост задержался
 *    на экране ~0.4с — быстрые сети получают фото почти мгновенно,
 *    а «пролетевшие» при быстром скролле посты трафик не тратят.
 *    (Было 1.2с — пользователи видели «фото не грузятся».)
 *
 * eager — без задержки (полный экран поста, лайтбокс, стикеры).
 */
export function LazyImage({
  src,
  alt,
  className,
  imgClassName,
  eager,
  draggable,
  onClick,
  onError,
}: {
  src: string
  alt: string
  /** Классы контейнера: размер/скругление (aspect, w-full, max-h, rounded, mx-auto) */
  className?: string
  /** object-fit картинки: cover (по умолчанию) или contain */
  imgClassName?: string
  eager?: boolean
  draggable?: boolean
  onClick?: () => void
  onError?: (e: React.SyntheticEvent<HTMLImageElement>) => void
}) {
  const [active, setActive] = useState(Boolean(eager))
  const [loaded, setLoaded] = useState(false)
  /*
   * v5.59 — ОДИН ТИХИЙ РЕТРАЙ при ошибке: edge мог закэшировать 404 старой
   * мёртвой ссылки ДО лечения (Cache-Control 30с/наследие). Cache-buster
   * обходит edge — сервер в это время уже отдаёт свежие байты.
   */
  const [retrySrc, setRetrySrc] = useState<string | null>(null)
  const retriedRef = useRef(false)
  const handleImgError = (e: React.SyntheticEvent<HTMLImageElement>) => {
    if (!retriedRef.current && src.includes('/api/media')) {
      retriedRef.current = true
      setRetrySrc(`${src}${src.includes('?') ? '&' : '?'}hbr=${Date.now()}`)
      return
    }
    onError?.(e)
  }
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (active) return
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      // Нет IntersectionObserver (старый WebView) — грузим сразу, асинхронно
      const t = window.setTimeout(() => setActive(true), 0)
      return () => window.clearTimeout(t)
    }
    let timer: number | null = null
    const io = new IntersectionObserver(
      (entries) => {
        const visible = (entries[0]?.intersectionRatio ?? 0) >= 0.05
        if (visible && timer === null) {
          timer = window.setTimeout(() => setActive(true), eager ? 0 : 400)
        } else if (!visible && timer !== null) {
          // Улетел с экрана до истечения задержки — откладываем загрузку
          window.clearTimeout(timer)
          timer = null
        }
      },
      { threshold: [0, 0.1, 0.5] },
    )
    io.observe(el)
    return () => {
      io.disconnect()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [active, eager])

  return (
    <div ref={ref} className={cn('relative overflow-hidden bg-tg-surface', className)}>
      {!loaded && <span className="tg-shimmer absolute inset-0" aria-hidden />}
      {active && (
         
        <img
          src={retrySrc ?? src}
          alt={alt}
          draggable={draggable}
          onClick={onClick}
          onLoad={() => setLoaded(true)}
          onError={handleImgError}
          className={cn(
            'absolute inset-0 h-full w-full transition-opacity duration-300',
            loaded ? 'opacity-100' : 'opacity-0',
            imgClassName,
          )}
        />
      )}
    </div>
  )
}
