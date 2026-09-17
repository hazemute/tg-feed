'use client'

import { Flame, Home, Search, UserRound } from 'lucide-react'
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

/** Нижняя навигация как в макетах: иконка + подпись, активная — синим */
export function BottomNav() {
  const { tab, goToTab } = useApp()

  return (
    <nav
      className="shrink-0 border-t border-tg-sep bg-tg-bg pb-[env(safe-area-inset-bottom)]"
      aria-label="Основная навигация"
    >
      <div className="grid grid-cols-4">
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
              className={cn(
                'flex min-h-[52px] flex-col items-center justify-center gap-[3px] pt-1.5 pb-1 transition active:scale-95',
                active ? 'text-tg-link' : 'text-tg-text',
              )}
            >
              <Icon
                className="h-[24px] w-[24px]"
                strokeWidth={active ? 2.2 : 1.7}
                fill={active && (id === 'feed' || id === 'trending') ? 'currentColor' : 'none'}
              />
              <span className={cn('text-[10px] leading-none', active ? 'font-semibold' : 'font-medium')}>
                {label}
              </span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
