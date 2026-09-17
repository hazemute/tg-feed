'use client'

import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Check, Plus, Sparkle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { haptic } from '@/lib/tg'
import { formatCount } from '@/lib/format'
import { RichText } from '@/components/feed/RichText'

/** Кнопка действия в правой панели поста: иконка + счётчик под ней (макет) */
export function RailButton({
  icon: Icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: LucideIcon
  label: string
  count?: number
  active?: boolean
  onClick: () => void
}) {
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 1.2 }}
      transition={{ type: 'spring', stiffness: 500, damping: 15 }}
      onClick={() => {
        onClick()
        haptic('light')
      }}
      aria-label={label}
      aria-pressed={active}
      className="flex flex-col items-center gap-1"
    >
      <Icon
        className={cn(
          'h-[26px] w-[26px] transition-colors',
          active ? 'fill-tg-like text-tg-like' : 'text-tg-text',
        )}
        strokeWidth={active ? 2 : 1.7}
      />
      {typeof count === 'number' && count > 0 && (
        <span className="text-[12px] font-medium leading-none text-tg-text2 tabular-nums">
          {formatCount(count)}
        </span>
      )}
    </motion.button>
  )
}

/** Круглая кнопка подписки [+]; после тапа — синяя с галочкой */
export function SubscribeCircle({
  subscribed,
  onClick,
}: {
  subscribed: boolean
  onClick: () => void
}) {
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.9 }}
      onClick={onClick}
      aria-pressed={subscribed}
      aria-label={subscribed ? 'Вы подписаны' : 'Подписаться на канал'}
      className={cn(
        'flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors',
        subscribed ? 'bg-tg-link text-white' : 'bg-tg-surface text-tg-text',
      )}
    >
      {subscribed ? <Check className="h-5 w-5" strokeWidth={2.6} /> : <Plus className="h-5.5 w-5.5" strokeWidth={2.2} />}
    </motion.button>
  )
}

/**
 * Текст поста: 3 строки с «...еще» в правом нижнем углу (как в макете),
 * раскрытие с плавной анимацией; у длинных постов — ссылка на AI-саммари.
 *
 * Кнопка — absolute в правом нижнем углу ОБРЕЗАННОГО контейнера (float-вариант
 * уходил под отсечку overflow:hidden и пропадал). Слева — градиент под фон,
 * растворяющий текст. Высота строки — из computed style (реальный line-height).
 */
export function ExpandableText({ text, onSummary }: { text: string; onSummary?: () => void }) {
  const innerRef = useRef<HTMLParagraphElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [clamp, setClamp] = useState<{ full: number; collapsed: number } | null>(null)

  const measure = () => {
    const el = innerRef.current
    if (!el) return
    const cs = getComputedStyle(el)
    const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5
    const collapsed = Math.round(line * 3) // ровно 3 строки, как в макете
    const full = el.scrollHeight
    const over = full > collapsed + 4
    // Идемпотентно (см. PostText) — ResizeObserver не должен провоцировать рендеры
    setClamp((prev) => {
      const next = over ? { full, collapsed } : null
      if (
        prev === next ||
        (prev && next && prev.full === next.full && prev.collapsed === next.collapsed)
      )
        return prev
      return next
    })
  }

  // ResizeObserver на абзаце: монтирование / смена текста / шрифты / поворот экрана.
  // Замер не зависит от expanded: scrollHeight абзаца всегда полная (клип — на родителе)
  useEffect(() => {
    const el = innerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const long = text.length > 400

  return (
    <div className="mt-3">
      <div
        className="relative"
        style={{
          maxHeight: expanded ? (clamp?.full ?? 9999) : (clamp?.collapsed ?? 9999),
          overflow: 'hidden',
          transition: 'max-height 320ms ease',
        }}
      >
        <div ref={innerRef}>
          <RichText text={text} />
        </div>
        {/* Оверлей «...еще» на третьей строке */}
        {clamp && !expanded && (
          <button
            type="button"
            onClick={() => {
              setExpanded(true)
              haptic('light')
            }}
            aria-label="Развернуть текст"
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
      {clamp && expanded && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-1 text-[15px] font-medium text-tg-hint active:opacity-60"
        >
          Свернуть
        </button>
      )}
      {expanded && long && onSummary && (
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
