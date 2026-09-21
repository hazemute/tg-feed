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

/*
 * Панель работает в светлой теме (bg-slate-50 + shadcn-токены по умолчанию).
 * Раньше здесь был ThemeController, принудительно включавший .dark, —
 * удалён вместе с boot-скриптом в layout.
 */

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

/* v5.62 (редизайн оболочки): секции снова в «панельном» стиле — белый фон,
 * тонкий бордер, мягкая тень, скругление xl. Темы перекрашивают .bg-white и
 * .border-slate-200, поэтому панели красятся во всех 4 палитрах без правок
 * вкладок. inputDark/btnOutlineDark сознательно не менялись: их классы
 * (.bg-slate-100, .border-slate-200, .hover\:bg-slate-200/70…) перекрываются
 * оверрайдами тем из layout.tsx. */
export const panelCard = 'rounded-xl border border-slate-200 bg-white shadow-sm'
export const inputDark =
  'border-slate-200 bg-slate-100 text-slate-800 placeholder:text-slate-500'
export const btnOutlineDark =
  'border-slate-200 bg-slate-100 text-slate-700 hover:bg-slate-200/70 hover:text-slate-900'

/* ===================== Аватар-кружок ===================== */

export function Avatar({
  color,
  title,
  src,
  className,
}: {
  color: string
  title: string
  src?: string | null
  className?: string
}) {
  const letter = (title || '?').trim().charAt(0).toUpperCase() || '?'
  if (src) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden
        className={cn(
          'size-9 shrink-0 rounded-full object-cover',
          className,
        )}
      />
    )
  }
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
  active: { label: 'активен', className: 'border-emerald-500/30 bg-emerald-50 text-emerald-700' },
  moderation: { label: 'модерация', className: 'border-amber-500/30 bg-amber-50 text-amber-700' },
  rejected: { label: 'отклонён', className: 'border-red-500/30 bg-red-50 text-red-700' },
}

export function statusLabel(status: ChannelStatus): string {
  return STATUS_META[status].label
}

export function StatusBadge({ status }: { status: ChannelStatus }) {
  const meta = STATUS_META[status]
  return (
    <Badge variant="outline" className={cn('rounded-full text-[11px] font-medium', meta.className)}>
      {meta.label}
    </Badge>
  )
}

export function UserKindBadge({ isGuest }: { isGuest: boolean }) {
  return isGuest ? (
    <Badge variant="outline" className="rounded-full border-slate-200 bg-slate-100 text-[11px] text-slate-500">
      Гость
    </Badge>
  ) : (
    <Badge variant="outline" className="rounded-full border-sky-500/30 bg-sky-500/10 text-[11px] text-sky-700">
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
    <Badge variant="outline" className="rounded-full border border-emerald-500/30 bg-emerald-50 text-[11px] text-emerald-700">
      {trueText}
    </Badge>
  ) : (
    <Badge variant="outline" className="rounded-full border border-slate-200 bg-slate-100 text-[11px] text-slate-500">
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
  /* v5.62: чистая карточка-метрика — чип иконки, крупное значение с
   * табличными цифрами, подпись; панель + бордер + мягкая тень. */
  return (
    <motion.div
      variants={fadeUp}
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-2xl font-semibold tabular-nums leading-tight text-slate-900">
            {fmtNum(value)}
          </div>
          <div className="mt-1 truncate text-xs text-slate-500">{label}</div>
        </div>
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
          <Icon className="size-4" aria-hidden />
        </span>
      </div>
      {(badges || hint) && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {badges?.map((b) => (
            <span
              key={b.text}
              className={cn('rounded-full px-1.5 py-0.5 text-[11px] font-medium', b.className)}
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
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-14 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
        <Icon className="size-5" aria-hidden />
      </span>
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {hint ? <p className="max-w-xs text-xs text-slate-500">{hint}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  )
}

export function SkeletonRows({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-14 w-full rounded-lg bg-slate-100" />
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
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-1 pt-4">
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
