'use client'

import { Heart, Home, ListChecks, Megaphone, Rocket, Search, UserRound } from 'lucide-react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { useApp } from '@/lib/store'
import { useT } from '@/lib/i18n'
import { haptic, userAvatarUrl } from '@/lib/tg'
import { Avatar } from '@/components/tg/Avatar'
import { APP_VERSION } from '@/lib/version'
import type { Tab } from '@/lib/types'

/* v5.58: «Канал» — рабочий стол админа (управление + статистика + ИИ-ассистент). */
const items: {
  id: Tab
  labelKey: 'nav.feed' | 'nav.quests' | 'nav.channel' | 'nav.promo' | 'nav.search' | 'nav.profile'
  icon: typeof Home
}[] = [
  { id: 'feed', labelKey: 'nav.feed', icon: Home },
  { id: 'quests', labelKey: 'nav.quests', icon: ListChecks },
  { id: 'channel', labelKey: 'nav.channel', icon: Megaphone },
  { id: 'promo', labelKey: 'nav.promo', icon: Rocket },
  { id: 'search', labelKey: 'nav.search', icon: Search },
  { id: 'profile', labelKey: 'nav.profile', icon: UserRound },
]

/**
 * Навигация для десктопа (lg+): вертикальный сайдбар слева вместо плавающей
 * нижней капсулы. Контент остаётся в читабельной колонке по центру.
 */
export function Sidebar() {
  const { tab, goToTab, user } = useApp()
  const t = useT()

  return (
    <aside
      className="hidden w-[228px] shrink-0 flex-col border-r border-tg-sep bg-tg-bg/60 px-3 pb-5 pt-6 lg:flex"
      aria-label={t('nav.main')}
    >
      {/* Воркмарк */}
      <div className="mb-8 flex items-center gap-2.5 px-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-tg-link/10">
          <svg viewBox="0 0 24 24" className="h-5 w-5 fill-tg-link" aria-hidden>
            <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.161-1.86 8.766c-.14.62-.51.772-1.032.48l-2.85-2.1-1.376 1.324c-.152.152-.28.28-.574.28l.204-2.9 5.286-4.774c.23-.204-.05-.318-.354-.114l-6.534 4.112-2.814-.88c-.612-.192-.624-.612.128-.906l11.004-4.244c.51-.192.956.114.772.956z" />
          </svg>
        </span>
        <span>
          <span className="block text-[16px] font-bold leading-tight text-tg-text">Tg Swipe</span>
          <span className="block text-[11.5px] leading-tight text-tg-hint">{t('nav.tagline')}</span>
        </span>
      </div>

      <nav className="flex flex-col gap-1">
        {items.map(({ id, labelKey, icon: Icon }) => {
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
              className={cn(
                'relative flex h-11 items-center gap-3 rounded-xl px-3.5 text-[14.5px] font-medium transition active:scale-[0.98] motion-reduce:transition-none',
                active ? 'text-tg-link' : 'text-tg-hint hover:bg-tg-surface hover:text-tg-text2',
              )}
            >
              {active && (
                <motion.span
                  layoutId="sidebar-pill"
                  transition={{ type: 'spring', stiffness: 480, damping: 36 }}
                  aria-hidden
                  className="absolute inset-0 rounded-xl bg-tg-link/10"
                />
              )}
              <Icon className="relative z-10 h-[19px] w-[19px]" strokeWidth={active ? 2.3 : 1.9} />
              <span className="relative z-10">{label}</span>
            </button>
          )
        })}
      </nav>

      <div className="mt-auto px-2">
        {user && (
          <div className="mb-3 flex items-center gap-2 rounded-xl bg-tg-surface/70 p-2.5">
            {/* Фото профиля (если есть) с фолбэком на инициал — как в профиле */}
            <Avatar
              name={user.isGuest ? 'Читатель' : (user.firstName ?? user.username ?? '?')}
              src={userAvatarUrl(user.id, user.photoUrl)}
              size={28}
              className="text-[11px]"
            />
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-tg-text2">
              {user.isGuest ? t('nav.reader') : (user.firstName ?? user.username ?? t('nav.reader'))}
            </span>
            <Heart className="h-3.5 w-3.5 text-tg-like" aria-hidden />
          </div>
        )}
        <p className="text-[11px] leading-snug text-tg-hint/80">Tg Swipe · v{APP_VERSION}</p>
      </div>
    </aside>
  )
}
