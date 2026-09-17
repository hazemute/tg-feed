'use client'

import { Flame, Home, Search, UserRound } from 'lucide-react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { useApp } from '@/lib/store'
import { haptic } from '@/lib/tg'
import type { Tab } from '@/lib/types'

const items: { id: Tab; label: string; icon: typeof Home }[] = [
  { id: 'feed', label: 'Лента', icon: Home },
  { id: 'trending', label: 'Тренды', icon: Flame },
  { id: 'search', label: 'Поиск', icon: Search },
  { id: 'profile', label: 'Профиль', icon: UserRound },
]

/**
 * Плавающая нижняя навигация: стеклянная капсула со скруглением и активной
 * пилюлей (layoutId). Контент вкладок прокручивается под ней — вкладки
 * дают нижний паддинг. safe-area учтена в pb капсулы.
 */
export function BottomNav() {
  const { tab, goToTab } = useApp()

  return (
    <nav
      className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex justify-center pb-[calc(env(safe-area-inset-bottom)+10px)]"
      aria-label="Основная навигация"
    >
      <div
        data-noswipe
        className="pointer-events-auto flex items-center gap-0.5 rounded-[24px] border border-tg-sep/70 bg-tg-surface/85 p-1.5 shadow-[0_8px_32px_rgba(0,0,0,0.16)] backdrop-blur-xl dark:bg-tg-surface/75"
      >
        {items.map(({ id, label, icon: Icon }) => {
          const active = tab === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => {
                if (!active) {
                  haptic('light')
                  goToTab(id)
                }
              }}
              aria-current={active ? 'page' : undefined}
              aria-label={label}
              className="relative flex h-[52px] w-[72px] flex-col items-center justify-center gap-[3px] transition active:scale-95"
            >
              {active && (
                <motion.span
                  layoutId="bottomnav-pill"
                  transition={{ type: 'spring', stiffness: 480, damping: 36 }}
                  aria-hidden
                  className="absolute inset-x-1 inset-y-0 rounded-[18px] bg-tg-link/12"
                />
              )}
              <Icon
                className={cn(
                  'relative z-10 h-[22px] w-[22px] transition-colors',
                  active ? 'text-tg-link' : 'text-tg-hint',
                )}
                strokeWidth={active ? 2.3 : 1.8}
                fill={active && (id === 'feed' || id === 'trending') ? 'currentColor' : 'none'}
              />
              <span
                className={cn(
                  'relative z-10 text-[10px] leading-none transition-colors',
                  active ? 'font-semibold text-tg-link' : 'font-medium text-tg-hint',
                )}
              >
                {label}
              </span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
