'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { motion, type Variants } from 'framer-motion'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

import { fmtNum, type ChannelStatus } from './api'

/* ===================== Тема ===================== */

/**
 * Включает shadcn-токены .dark на <html> (в root layout темы нет — мини-апп
 * управляет темой через data-theme). На размонтировании возвращает как было.
 */
export function ThemeController() {
  useEffect(() => {
    document.documentElement.classList.add('dark')
    return () => document.documentElement.classList.remove('dark')
  }, [])
  return null
}

/* ===================== Motion-варианты ===================== */

export const staggerContainer: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.03 } },
}

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.25, ease: 'easeOut' } },
}

/* ===================== Общие пропсы вкладок ===================== */

export interface TabProps {
  /** Счётчик «Обновить» из шапки — изменение триггерит перезапрос. */
  tick: number
  /** Вкладка сообщает шапке, что загрузка завершилась (кнопка перестаёт крутиться). */
  onSettled: () => void
}

/* ===================== Стили-константы ===================== */

export const panelCard = 'border-white/[0.08] bg-[#131c26]'
export const inputDark =
  'border-white/10 bg-white/[0.04] text-slate-200 placeholder:text-slate-500'
export const btnOutlineDark =
  'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] hover:text-slate-100'

/* ===================== Аватар-кружок ===================== */

export function Avatar({
  color,
  title,
  className,
}: {
  color: string
  title: string
  className?: string
}) {
  const letter = (title || '?').trim().charAt(0).toUpperCase() || '?'
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-9 shrink-0 select-none items-center justify-center rounded-full text-sm font-semibold text-white',
        className,
      )}
      style={{ backgroundColor: color || '#334155' }}
    >
      {letter}
    </span>
  )
}

/* ===================== Бейджи ===================== */

const STATUS_META: Record<ChannelStatus, { label: string; className: string }> = {
  active: { label: 'активен', className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' },
  moderation: { label: 'модерация', className: 'border-amber-500/30 bg-amber-500/10 text-amber-300' },
  rejected: { label: 'отклонён', className: 'border-red-500/30 bg-red-500/10 text-red-300' },
}

export function statusLabel(status: ChannelStatus): string {
  return STATUS_META[status].label
}

export function StatusBadge({ status }: { status: ChannelStatus }) {
  const meta = STATUS_META[status]
  return (
    <Badge variant="outline" className={cn('border', meta.className)}>
      {meta.label}
    </Badge>
  )
}

export function UserKindBadge({ isDemo }: { isDemo: boolean }) {
  return isDemo ? (
    <Badge variant="outline" className="border-white/10 bg-white/[0.04] text-slate-400">
      Демо
    </Badge>
  ) : (
    <Badge variant="outline" className="border-sky-500/30 bg-sky-500/10 text-sky-300">
      TG
    </Badge>
  )
}

export function BoolBadge({
  value,
  trueText = 'да',
  falseText = 'нет',
}: {
  value: boolean
  trueText?: string
  falseText?: string
}) {
  return value ? (
    <Badge variant="outline" className="border border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
      {trueText}
    </Badge>
  ) : (
    <Badge variant="outline" className="border border-white/10 bg-white/[0.04] text-slate-400">
      {falseText}
    </Badge>
  )
}

/* ===================== Метрика ===================== */

export function MetricCard({
  icon: Icon,
  label,
  value,
  badges,
  hint,
}: {
  icon: LucideIcon
  label: string
  value: number
  badges?: { text: string; className: string }[]
  hint?: ReactNode
}) {
  return (
    <motion.div
      variants={fadeUp}
      className="rounded-lg border border-white/[0.08] bg-[#131c26] p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xl font-semibold tabular-nums text-slate-100 md:text-2xl">
            {fmtNum(value)}
          </div>
          <div className="mt-0.5 truncate text-xs text-slate-400">{label}</div>
        </div>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-300">
          <Icon className="size-4" aria-hidden />
        </span>
      </div>
      {(badges || hint) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {badges?.map((b) => (
            <span
              key={b.text}
              className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-medium', b.className)}
            >
              {b.text}
            </span>
          ))}
          {hint}
        </div>
      )}
    </motion.div>
  )
}

/* ===================== Состояния ===================== */

export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: LucideIcon
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-14 text-center">
      <Icon className="size-10 text-slate-600" aria-hidden />
      <p className="text-sm font-medium text-slate-300">{title}</p>
      {hint ? <p className="max-w-xs text-xs text-slate-500">{hint}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}

export function SkeletonRows({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-12 w-full rounded-md bg-white/[0.05]" />
      ))}
    </div>
  )
}

/* ===================== Пагинация ===================== */

export function Pagination({
  page,
  pageSize,
  total,
  onChange,
}: {
  page: number
  pageSize: number
  total: number
  onChange: (page: number) => void
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return (
    <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] px-1 pt-4">
      <Button
        variant="outline"
        size="sm"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
        aria-label="Предыдущая страница"
        className={btnOutlineDark}
      >
        <ChevronLeft aria-hidden /> Назад
      </Button>
      <span className="text-xs text-slate-500">
        Стр. {page} из {pages} · всего {fmtNum(total)}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={page >= pages}
        onClick={() => onChange(page + 1)}
        aria-label="Следующая страница"
        className={btnOutlineDark}
      >
        Вперёд <ChevronRight aria-hidden />
      </Button>
    </div>
  )
}

/* ===================== Хук debounce ===================== */

export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}
