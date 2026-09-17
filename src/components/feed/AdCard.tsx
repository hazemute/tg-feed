'use client'

import { ChevronRight } from 'lucide-react'
import type { AdDTO } from '@/lib/types'
import { openExternal, openTelegram } from '@/lib/tg'

/** Рекламный слот: каждый 10-й пост в ленте. Светлый, ненавязчивый, во всю ширину. */
export function AdCard({ ad }: { ad: AdDTO }) {
  const isTg = ad.link.includes('t.me')

  const onClick = () => {
    if (isTg) openTelegram(ad.link)
    else openExternal(ad.link)
  }

  return (
    <aside className="px-4 py-3" aria-label="Реклама">
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-center gap-3.5 rounded-2xl bg-tg-surface p-4 text-left transition active:scale-[0.99]"
      >
        {ad.imageUrl && (
           
          <img
            src={ad.imageUrl}
            alt=""
            className="h-14 w-14 shrink-0 rounded-xl object-cover"
            loading="lazy"
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-semibold uppercase tracking-wide text-tg-hint">
            Реклама
          </span>
          <span className="mt-0.5 block truncate text-[16px] font-semibold text-tg-text">
            {ad.title}
          </span>
          <span className="mt-0.5 line-clamp-2 text-snippet text-tg-hint">{ad.body}</span>
        </span>
        <ChevronRight className="h-5 w-5 shrink-0 text-tg-hint" />
      </button>
    </aside>
  )
}
