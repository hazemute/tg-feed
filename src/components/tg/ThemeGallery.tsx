'use client'

import { ArrowLeft, Check, MonitorSmartphone } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { useApp } from '@/lib/store'
import { haptic, useBackButton } from '@/lib/tg'
import { THEMES, type ThemeGroup } from '@/lib/themes'
import type { ThemeMode } from '@/lib/types'

/**
 * Галерея тем оформления: синхронизация с Telegram,
 * светлые и тёмные палитры. Карточка — мини-превью интерфейса (фон, строки,
 * акцент). Выбор сохраняется в localStorage и применяется мгновенно.
 */

const GROUP_TITLES: Record<ThemeGroup, string> = {
  sync: 'Синхронизация',
  light: 'Светлые',
  dark: 'Тёмные',
}

function ThemeCard({
  active,
  name,
  bg,
  surface,
  text,
  accent,
  isAuto,
  onClick,
}: {
  active: boolean
  name: string
  bg: string
  surface: string
  text: string
  accent: string
  isAuto?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Тема ${name}`}
      aria-pressed={active}
      className={cn(
        'relative overflow-hidden rounded-2xl border-2 text-left transition-colors',
        active ? 'border-tg-link' : 'border-tg-sep',
      )}
    >
      {/* Мини-превью интерфейса */}
      <div className="h-24 p-2.5" style={{ background: bg }}>
        <div className="flex items-center gap-1.5">
          <span className="h-5 w-5 rounded-full" style={{ background: accent }} />
          <span className="h-2 w-14 rounded-full" style={{ background: text, opacity: 0.85 }} />
          {isAuto && (
            <MonitorSmartphone className="ml-auto h-3.5 w-3.5" style={{ color: text, opacity: 0.7 }} />
          )}
        </div>
        <div className="mt-2 rounded-lg p-1.5" style={{ background: surface }}>
          <span className="block h-1.5 w-full rounded-full" style={{ background: text, opacity: 0.5 }} />
          <span className="mt-1 block h-1.5 w-3/4 rounded-full" style={{ background: text, opacity: 0.35 }} />
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <span className="h-4 w-12 rounded-md" style={{ background: accent }} />
          <span className="h-1.5 w-6 rounded-full" style={{ background: text, opacity: 0.3 }} />
        </div>
      </div>

      {/* Подпись */}
      <div className="flex items-center justify-between gap-1 bg-tg-surface px-2.5 py-2">
        <span className="truncate text-[13.5px] font-medium text-tg-text">{name}</span>
        {active && (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-tg-link">
            <Check className="h-3.5 w-3.5 text-white" strokeWidth={3} />
          </span>
        )}
      </div>
    </button>
  )
}

export function ThemeGallery({ open, onClose }: { open: boolean; onClose: () => void }) {
  const theme = useApp((s) => s.theme)
  const setTheme = useApp((s) => s.setTheme)

  useBackButton(open, onClose)

  const pick = (id: ThemeMode) => {
    setTheme(id)
    haptic('light')
  }

  const groups: ThemeGroup[] = ['sync', 'light', 'dark']

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%' }}
          transition={{ type: 'spring', damping: 32, stiffness: 330 }}
          className="fixed inset-0 z-[75] mx-auto flex w-full max-w-[430px] flex-col overflow-hidden bg-tg-bg lg:bottom-auto lg:top-[6vh] lg:h-[88vh] lg:max-w-[860px] lg:rounded-3xl lg:border lg:border-tg-sep lg:shadow-[0_24px_90px_rgba(0,0,0,0.30)]"
          role="dialog"
          aria-modal="true"
          aria-label="Тема оформления"
          data-noswipe
        >
          {/* Шапка */}
          <header className="flex shrink-0 items-center gap-2 border-b border-tg-sep px-2 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))]">
            <button
              type="button"
              onClick={() => {
                haptic('light')
                onClose()
              }}
              aria-label="Назад"
              className="flex h-10 w-10 items-center justify-center rounded-full text-tg-text active:bg-tg-surface"
            >
              <ArrowLeft className="h-6 w-6" strokeWidth={1.8} />
            </button>
            <span className="flex-1 text-[17px] font-semibold text-tg-text">Тема оформления</span>
          </header>

          {/* Сетка тем */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-28">
            <p className="pt-3 text-[13.5px] leading-snug text-tg-hint">
              Светлые и тёмные палитры на любой вкус. «Как в Telegram»
              подстраивается под оформление клиента автоматически.
            </p>
            {groups.map((g) => (
              <section key={g} aria-label={GROUP_TITLES[g]} className="pt-4">
                <h3 className="px-0.5 text-[15px] font-bold text-tg-text">{GROUP_TITLES[g]}</h3>
                <div className="mt-2.5 grid grid-cols-2 gap-3">
                  {THEMES.filter((t) => t.group === g).map((t) => (
                    <ThemeCard
                      key={t.id}
                      active={theme === t.id}
                      name={t.name}
                      bg={t.preview.bg}
                      surface={t.preview.surface}
                      text={t.preview.text}
                      accent={t.preview.accent}
                      isAuto={t.id === 'auto'}
                      onClick={() => pick(t.id)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
