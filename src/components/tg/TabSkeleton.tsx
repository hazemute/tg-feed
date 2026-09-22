'use client'

import type { Tab } from '@/lib/types'

/**
 * v5.85 — мгновенный отклик вкладок.
 *
 * Чанки вкладок грузятся лениво (next/dynamic). Раньше `loading:` не было —
 * пока чанк качался (первый тап, медленная сеть, холодный кэш), вкладка
 * рендерила ПУСТОЙ ЭКРАН (баг «пол года грузится» на скрине владельца).
 * Теперь на время загрузки чанка показывается лёгкий скелетон в палитре
 * темы: экран живой с первого кадра, данные подставляются из apiCached
 * сразу после монтирования.
 */
export function TabSkeleton({ tab }: { tab: Tab }) {
  return (
    <div
      className="no-scrollbar h-full w-full overflow-y-auto overscroll-contain pb-28"
      role="status"
      aria-label="Загружаем раздел"
    >
      <div className="mx-auto w-full max-w-[880px] animate-pulse px-4 pt-6">
        {/* шапка-обложка */}
        <div className="flex items-center gap-4">
          <div className="size-[72px] shrink-0 rounded-2xl bg-tg-sep/70" />
          <div className="flex-1 space-y-2.5">
            <div className="h-5 w-2/5 rounded-lg bg-tg-sep/70" />
            <div className="h-3.5 w-1/4 rounded-lg bg-tg-sep/60" />
            <div className="flex gap-2 pt-1">
              <div className="h-8 w-24 rounded-full bg-tg-sep/60" />
              <div className="h-8 w-24 rounded-full bg-tg-sep/50" />
            </div>
          </div>
        </div>
        {/* сетка плашек: профиль/поиск — 2 колонки, остальное — список */}
        {tab === 'profile' || tab === 'search' ? (
          <div className="mt-6 grid grid-cols-2 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-[92px] rounded-2xl bg-tg-sep/45" />
            ))}
          </div>
        ) : (
          <div className="mt-6 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-16 rounded-2xl bg-tg-sep/45" />
            ))}
          </div>
        )}
        <p className="mt-6 text-center text-[12.5px] text-tg-hint opacity-70">
          Загружаем раздел…
        </p>
      </div>
    </div>
  )
}
