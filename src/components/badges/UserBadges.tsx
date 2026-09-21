'use client'

/**
 * Бейджи пользователей (v5.19): цветные чипы статусов
 * developer / manager / moderator / sponsor / vip / early.
 * Общие для профиля, комментариев и админки. Цвета — lib/badges.ts.
 */

import { ClipboardCheck, Code2, Crown, HeartHandshake, ShieldCheck, Sparkles } from 'lucide-react'

import { cn } from '@/lib/utils'
import { BADGES, type BadgeDef, type BadgeSlug } from '@/lib/badges'

const ICONS = {
  Code2,
  ClipboardCheck,
  ShieldCheck,
  HeartHandshake,
  Crown,
  Sparkles,
} as const

/** Один чип бейджа: icon+label или только иконка (compact) */
export function BadgeChip({
  slug,
  compact = false,
  solid = false,
  className,
}: {
  slug: string
  compact?: boolean
  solid?: boolean
  className?: string
}) {
  const def = BADGES[slug as BadgeSlug]
  if (!def) return null
  const Icon = ICONS[def.icon]
  return (
    <span
      title={def.label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-bold leading-none',
        compact
          ? 'size-[15px] border-transparent p-0'
          : 'gap-0.5 border px-1.5 py-[3px] text-[10.5px]',
        solid ? def.solid : cn(def.chip, def.chipDark),
        className,
      )}
    >
      <Icon className={cn('shrink-0', compact ? 'size-[11px]' : 'size-3')} aria-hidden />
      {!compact && <span>{def.label}</span>}
    </span>
  )
}

/** Ряд бейджей пользователя: не более max, остальные — «+N» */
export function UserBadges({
  badges,
  max = 4,
  compact = false,
  solid = false,
  className,
}: {
  badges?: string[] | null
  max?: number
  compact?: boolean
  solid?: boolean
  className?: string
}) {
  if (!badges || badges.length === 0) return null
  const shown = badges.slice(0, max)
  const rest = badges.length - shown.length
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      {shown.map((slug) => (
        <BadgeChip key={slug} slug={slug} compact={compact} solid={solid} />
      ))}
      {rest > 0 && (
        <span
          className="text-[10.5px] font-semibold text-tg-hint"
          title={badges.slice(max).map((s) => BADGES[s as BadgeSlug]?.label ?? s).join(', ')}
        >
          +{rest}
        </span>
      )}
    </span>
  )
}

export type { BadgeDef }
