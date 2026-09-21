'use client'

import { Home, ListChecks, Megaphone, Search, UserRound } from 'lucide-react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { useApp } from '@/lib/store'
import { useT } from '@/lib/i18n'
import { haptic } from '@/lib/tg'
import type { Tab } from '@/lib/types'

/* v5.58: «Канал» вернулся в навигацию как полноценный раздел для админов —
 * рабочий стол: управление каналом, статистика и ИИ-ассистент в одном месте. */
const items: {
  id: Tab
  labelKey: 'nav.feed' | 'nav.quests' | 'nav.channel' | 'nav.search' | 'nav.profile'
  icon: typeof Home
  /** fill активной иконки (мини-акцент, как у Ленты/Заданий) */
  fillActive?: boolean
}[] = [
  { id: 'feed', labelKey: 'nav.feed', icon: Home, fillActive: true },
  { id: 'quests', labelKey: 'nav.quests', icon: ListChecks, fillActive: true },
  { id: 'channel', labelKey: 'nav.channel', icon: Megaphone },
  { id: 'search', labelKey: 'nav.search', icon: Search },
  { id: 'profile', labelKey: 'nav.profile', icon: UserRound },
]

/**
 * Плавающая нижняя навигация: стеклянная капсула со скруглением и активной
 * пилюлей (layoutId). Контент вкладок прокручивается под ней — вкладки
 * дают нижний паддинг. safe-area учтена в pb капсулы.
 * v5.58: 5 пунктов — капсула адаптирована (узкие кнопки, компактные лейблы).
 */
export function BottomNav() {
  const { tab, goToTab } = useApp()
  const t = useT()

  return (
    <nav
      className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex justify-center pb-[calc(env(safe-area-inset-bottom)+10px)] lg:hidden"
      aria-label={t('nav.main')}
    >
      <div
        data-noswipe
        className="pointer-events-auto flex items-center gap-0 rounded-[24px] border border-tg-sep/70 bg-tg-surface/85 p-1.5 shadow-[0_8px_32px_rgba(0,0,0,0.16)] backdrop-blur-xl dark:bg-tg-surface/75"
      >
        {items.map(({ id, labelKey, icon: Icon, fillActive }) => {
          const active = tab === id
          const label = t(labelKey)
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
              className="relative flex h-[52px] w-[64px] flex-col items-center justify-center gap-[3px] transition active:scale-95"
            >
              {active && (
                <motion.span
                  layoutId="bottomnav-pill"
                  transition={{ type: 'spring', stiffness: 480, damping: 36 }}
                  aria-hidden
                  className="absolute inset-x-0.5 inset-y-0 rounded-[18px] bg-tg-link/12"
                />
              )}
              <Icon
                className={cn(
                  'relative z-10 h-[22px] w-[22px] transition-colors',
                  active ? 'text-tg-link' : 'text-tg-hint',
                )}
                strokeWidth={active ? 2.3 : 1.8}
                fill={active && fillActive ? 'currentColor' : 'none'}
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
