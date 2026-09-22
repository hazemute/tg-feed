'use client'

import { useEffect, useRef, useState } from 'react'
import { DownloadCloud, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { haptic } from '@/lib/tg'

/**
 * v5.96 — «Импортировать посты из Telegram» (кнопка кабинета канала).
 *
 * Запускает импорт истории канала из t.me/s (POST /api/mychannel action=backfill —
 * бэкенд гоняет глубокий парсер в after()). Импорт занимает до минуты:
 * кнопка держит спиннер и через равные паузы дёргает onProgress — родитель
 * перезагружает данные, и как только посты приехали, экран сам оживает.
 */

export function BackfillButton({
  channelId,
  className,
  label = 'Импортировать посты из Telegram',
  onProgress,
}: {
  channelId: string
  className?: string
  label?: string
  /** Родитель перезагружает данные: вызывается 4 раза в течение ~минуты */
  onProgress?: () => void
}) {
  const [running, setRunning] = useState(false)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  // Размонтирование: гасим все запланированные перезагрузки
  useEffect(() => {
    const stash = timers.current
    return () => {
      for (const t of stash) clearTimeout(t)
      stash.length = 0
    }
  }, [])

  const start = async () => {
    if (running) return
    setRunning(true)
    haptic('light')
    try {
      await api<{ ok: boolean; started?: boolean }>('/api/mychannel', {
        method: 'POST',
        body: JSON.stringify({ action: 'backfill', channelId }),
      })
      toast('Импорт запущен — посты появятся в течение минуты')
      // Посты приезжают порциями: перезагружаем данные 4 раза за минуту
      const delays = [7_000, 17_000, 30_000, 45_000]
      for (const d of delays) {
        timers.current.push(
          setTimeout(() => {
            onProgress?.()
          }, d),
        )
      }
      // Кнопка возвращается в активное состояние через минуту
      timers.current.push(setTimeout(() => setRunning(false), 50_000))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось запустить импорт')
      setRunning(false)
    }
  }

  return (
    <button
      type="button"
      data-noswipe
      onClick={() => void start()}
      disabled={running}
      className={cn(
        'press flex h-11 items-center justify-center gap-2 rounded-xl bg-tg-link px-5 text-[14px] font-semibold text-white transition active:scale-[0.98] disabled:opacity-70',
        className,
      )}
    >
      {running ? <Loader2 className="h-4.5 w-4.5 animate-spin" aria-hidden /> : <DownloadCloud className="h-4.5 w-4.5" aria-hidden />}
      {running ? 'Импортирую…' : label}
    </button>
  )
}
