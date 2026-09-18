'use client'

import { useState } from 'react'
import { EyeOff } from 'lucide-react'
import { haptic } from '@/lib/tg'

/**
 * Медиа-спойлер (как в Telegram): фото/видео размыто и приглушено,
 * тап раскрывает. Парсер ставит item.spoiler=true, когда в исходном
 * посте медиа обёрнуто спойлером (tg-spoiler/message_spoiler в t.me/s).
 */
export function MediaSpoiler({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  if (open) return <>{children}</>
  return (
    <button
      type="button"
      data-noswipe
      onClick={(e) => {
        e.stopPropagation()
        haptic('light')
        setOpen(true)
      }}
      aria-label="Спойлер — нажмите, чтобы показать"
      className="group relative block w-full cursor-pointer overflow-hidden rounded-[14px]"
    >
      <div aria-hidden className="pointer-events-none scale-110 blur-2xl saturate-[0.4]">
        {children}
      </div>
      <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/25">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/45 backdrop-blur-sm transition group-active:scale-90">
          <EyeOff className="h-6 w-6 text-white" />
        </span>
        <span className="rounded-full bg-black/45 px-3 py-1 text-[12.5px] font-semibold text-white backdrop-blur-sm">
          Спойлер
        </span>
      </span>
    </button>
  )
}
