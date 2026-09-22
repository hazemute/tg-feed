'use client'

import { useMemo } from 'react'
import { levelProgress } from '@/lib/xp-rules'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/**
 * LevelBar (v5.75) — минималистичная полоска уровня «как в Telegram»:
 * тонкий скруглённый прогресс + метка уровня слева и XP справа.
 * Рендерится под ником в своём профиле и в публичном профиле.
 *
 * Чисто презентационный: цифры приходят пропсами, вся математика —
 * в lib/xp-rules.ts (общая с сервером). Тап опционален (свой профиль
 * открывает LevelSheet, в чужом профиле — просто индикатор).
 */
export function LevelBar({
  xp,
  level,
  onClick,
  className,
  compact,
}: {
  xp: number
  level: number
  onClick?: () => void
  className?: string
  /** компактный режим — в публичном профиле (мельче шрифт, уже полоса) */
  compact?: boolean
}) {
  const t = useT()
  const p = useMemo(() => levelProgress(xp, level), [xp, level])

  const inner = (
    <>
      <span
        className={cn(
          'shrink-0 font-bold leading-none text-tg-link',
          compact ? 'text-[10.5px]' : 'text-[11.5px]',
        )}
      >
        {t('level.short')} {p.level}
      </span>
      {/* Тонкий трек с заполнением: высота 5px, tabular-nums справа */}
      <span className="relative h-[5px] min-w-0 flex-1 overflow-hidden rounded-full bg-tg-sep">
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-tg-link transition-[width] duration-500 ease-out"
          style={{ width: `${Math.round(p.pct * 100)}%` }}
        />
      </span>
      <span
        className={cn(
          'shrink-0 leading-none tabular-nums text-tg-hint',
          compact ? 'text-[10.5px]' : 'text-[11.5px]',
        )}
      >
        {p.inLevelXp}/{p.levelEnd - p.levelStart} XP
      </span>
    </>
  )

  const width = compact ? 'max-w-[200px]' : 'max-w-[260px]'

  if (!onClick) {
    return (
      <div
        className={cn('flex w-full items-center gap-2 px-1', width, className)}
        role="img"
        aria-label={`${t('level.progressAria')}: ${p.level}`}
      >
        {inner}
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 px-1 transition active:opacity-70',
        width,
        className,
      )}
      aria-label={`${t('level.progressAria')}: ${p.level}`}
    >
      {inner}
    </button>
  )
}
