'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { optimizedImgSrc } from '@/lib/media'

/**
 * Экономное изображение («сбережение трафика»):
 *  • скелетон с shimmer, пока картинка не загружена;
 *  • плавное появление (fade-in 300мс) после загрузки;
 *  • ПОЛНАЯ картинка качается, когда блок во вьюпорте и пост задержался
 *    на экране ~0.4с — быстрые сети получают фото почти мгновенно,
 *    а «пролетевшие» при быстром скролле посты трафик не тратят.
 *
 * eager — без задержки (полный экран поста, лайтбокс, стикеры).
 *
 * v5.60 — ЛЕСТНИЦА КАНДИДАТОВ (медиа грузится «что бы то ни стало»):
 *  1. /_next/image (AVIF/WebP, байтов ×3-5 меньше) — самый быстрый на плохих
 *     каналах;
 *  2. прямой /api/media — если оптимизатор споткнулся;
 *  3-4. прямой с cache-buster (hbr) — обход залипшего edge/404-наследия;
 *  между попытками — растущая пауза (0.4/0.8/1.2с), часовой watchdog 20с
 *  ловит «залипший» коннект (мобильные сети душат большие ответы).
 *  Все попытки кончились — НЕ прячем медиа, а показываем кнопку «Повторить»:
 *  один тап перезапускает лестницу (у юзера всегда есть ручной шанс).
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
  imgWidth = 828,
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
  /** Вызывается когда исчерпана ВСЯ лестница и юзер больше не жмёт «Повторить» —
   *  раньше родители прятали слайд по первой ошибке, теперь медиа живучее */
  onError?: (e: React.SyntheticEvent<HTMLImageElement>) => void
  /** Ширина для /_next/image (устройства с dpr — Optimizer сам отдаст нужную) */
  imgWidth?: number
}) {
  const [active, setActive] = useState(Boolean(eager))
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  /** индекс текущего кандидата лестницы */
  const [attempt, setAttempt] = useState(0)
  /** поколение попыток: тап «Повторить» или новая src перегенерируют кандидатов */
  const [gen, setGen] = useState(0)

  const candidates = useMemo(() => {
    void gen // смена поколения → свежие hbr-таймстампы
    const list: string[] = []
    if (src.startsWith('/api/media')) {
      list.push(optimizedImgSrc(src, imgWidth))
      const bust = (n: number) => `${src}${src.includes('?') ? '&' : '?'}hbr=${Date.now()}${n}`
      list.push(src, bust(1), bust(2))
    } else {
      list.push(src)
    }
    return list
  }, [src, gen, imgWidth])

  const attemptRef = useRef(0)
  attemptRef.current = attempt
  const cur = candidates[Math.min(attempt, candidates.length - 1)]

  /** Следующий кандидат; кончились — экран «Повторить» + нотификация родителю */
  const advance = (e?: React.SyntheticEvent<HTMLImageElement>) => {
    if (attemptRef.current < candidates.length - 1) {
      // растущая пауза 0.4/0.8/1.2с — даём сети выдохнуть между попытками
      const delay = Math.min(3000, 400 * (attemptRef.current + 1))
      window.setTimeout(() => setAttempt((a) => a + 1), delay)
      return
    }
    setFailed(true)
    if (e) onError?.(e) // родители прячут слайд ТОЛЬКО когда медиа мертво по-настоящему
  }

  const handleImgError = (e: React.SyntheticEvent<HTMLImageElement>) => {
    advance(e)
  }

  const ref = useRef<HTMLDivElement>(null)
  /* Новая src (компонент переиспользован для другого поста) — полный сброс */
  const [prevSrc, setPrevSrc] = useState(src)
  if (prevSrc !== src) {
    setPrevSrc(src)
    setLoaded(false)
    setFailed(false)
    setAttempt(0)
    setGen((g) => g + 1)
  }

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

  /* Часовой: картинка «висит» дольше 20с (душеный коннект) — считаем ошибкой,
     переходим к следующему кандидату (свежий hbr = новое соединение) */
  useEffect(() => {
    if (!active || loaded || failed) return
    const t = window.setTimeout(() => advance(), 20_000)
    return () => window.clearTimeout(t)
  }, [active, loaded, failed, attempt, cur])

  return (
    <div ref={ref} className={cn('relative overflow-hidden bg-tg-surface', className)}>
      {!loaded && !failed && <span className="tg-shimmer absolute inset-0" aria-hidden />}
      {active && !failed && (
        <img
          key={cur}
          src={cur}
          alt={alt}
          draggable={draggable}
          decoding="async"
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
      {failed && (
        <button
          type="button"
          data-noswipe
          onClick={(e) => {
            e.stopPropagation()
            setFailed(false)
            setAttempt(0)
            setGen((g) => g + 1)
            setLoaded(false)
          }}
          aria-label="Повторить загрузку медиа"
          className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-tg-surface/85 text-tg-hint transition active:scale-[0.98]"
        >
          <RefreshCw className="h-5 w-5" aria-hidden />
          <span className="text-[12px] font-semibold">Повторить</span>
        </button>
      )}
    </div>
  )
}
