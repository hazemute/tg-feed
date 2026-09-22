'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { useApp } from '@/lib/store'
import { haptic } from '@/lib/tg'

/**
 * Sticky-плашка над лентой: линейки категорий (горизонтальный скролл).
 * Никаких шапок и лишнего пространства — только переключатель пула постов.
 */
export function AppHeader() {
  const { category, setCategory, categories } = useApp()

  return (
    <header className="z-20 shrink-0 border-b border-tg-sep bg-tg-bg/90 backdrop-blur-md">
      <div
        className="no-scrollbar flex gap-1.5 overflow-x-auto px-3 py-2"
        role="tablist"
        aria-label="Категории ленты"
      >
        <Chip active={category === 'all'} onClick={() => setCategory('all')}>
          Все
        </Chip>
        {categories.map((c) => (
          <Chip key={c.slug} active={category === c.slug} onClick={() => setCategory(c.slug)}>
            {c.title}
          </Chip>
        ))}
      </div>
    </header>
  )
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => {
        onClick()
        haptic('light')
      }}
      className={cn(
        'h-8 shrink-0 whitespace-nowrap rounded-full px-3.5 text-[13px] font-medium transition active:scale-95',
        active ? 'bg-tg-button text-white' : 'bg-tg-surface text-tg-hint',
      )}
    >
      {children}
    </button>
  )
}
