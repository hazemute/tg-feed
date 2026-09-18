'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { Check, Plus, Sparkle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { haptic } from '@/lib/tg'
import { formatCount } from '@/lib/format'
import { useT } from '@/lib/i18n'
import { TEASER_LINES, useLineTruncate } from '@/lib/clamp-text'
import { RichText } from '@/components/feed/RichText'
import { useIsDesktop } from '@/lib/use-desktop'

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
 * Текст поста в ленте канала: превью — укороченный до целого слова текст
 * (5 строк на мобильных) с инлайн-кнопкой «еще» прямо за последним словом,
 * раскрытие/сворачивание на месте. У длинных постов — ссылка на AI-саммари.
 *
 * Прежний вариант (клип по maxHeight + absolute-кнопка поверх градиента) резал
 * текст посреди строки — заменён на useLineTruncate (см. lib/clamp-text.ts).
 * На ПК (lg+) текст не обрезаем — читаемость важнее компактности.
 */
export function ExpandableText({ text, onSummary }: { text: string; onSummary?: () => void }) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  // На ПК (lg+) текст не обрезаем — читаемость важнее компактности
  const isDesktop = useIsDesktop()
  const { ref, cut } = useLineTruncate(text, TEASER_LINES, !isDesktop && !expanded)
  const truncated = cut !== null && cut.length < text.length

  const long = text.length > 400

  return (
    <div className="mt-3">
      <div ref={ref}>
        <RichText
          text={expanded ? text : (cut ?? text)}
          trailing={
            !expanded &&
            truncated && (
              <button
                type="button"
                onClick={() => {
                  setExpanded(true)
                  haptic('light')
                }}
                aria-label="Развернуть текст"
                className="ml-1.5 inline select-none whitespace-nowrap align-baseline text-post font-medium text-tg-hint active:opacity-60"
              >
                {t('post.more')}
              </button>
            )
          }
        />
      </div>
      {expanded && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-1 text-[15px] font-medium text-tg-hint active:opacity-60"
        >
          {t('post.collapse')}
        </button>
      )}
      {expanded && long && onSummary && (
        <button
          type="button"
          onClick={onSummary}
          className="mt-2 inline-flex items-center gap-1.5 text-[14px] font-semibold text-tg-link active:opacity-60"
        >
          <Sparkle className="h-4 w-4" />
          {t('post.summary')}
        </button>
      )}
    </div>
  )
}
