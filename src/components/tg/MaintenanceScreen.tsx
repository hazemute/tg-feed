'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { RefreshCw } from 'lucide-react'

/**
 * Экран технических работ: видят пользователи без допуска, пока включён
 * режим техработ. Полностью на токенах темы — выглядит одинаково уместно
 * во всех 23 палитрах. Раз в 60с сам перепроверяет доступ; «Проверить» —
 * вручную в любой момент.
 */

const RETRY_SEC = 60

export function MaintenanceScreen({
  onRetry,
  message,
}: {
  /** пере-проверить доступ; true — доступ открыт (пользователя пропускаем) */
  onRetry: () => Promise<boolean>
  message?: string
}) {
  const [left, setLeft] = useState(RETRY_SEC)
  const [checking, setChecking] = useState(false)

  const check = async () => {
    if (checking) return
    setChecking(true)
    setLeft(RETRY_SEC)
    try {
      await onRetry()
    } finally {
      setChecking(false)
    }
  }

  // авто-перепроверка раз в минуту
  useEffect(() => {
    const t = setInterval(() => {
      setLeft((s) => {
        if (s <= 1) {
          void check()
          return RETRY_SEC
        }
        return s - 1
      })
    }, 1000)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="flex h-dvh justify-center bg-tg-bg" role="status" aria-label="Технические работы">
      <div className="flex h-full w-full max-w-[430px] flex-col items-center justify-center bg-tg-bg px-8 md:border-x md:border-tg-sep">
        {/* Иконка: самолётик «на обслуживании» в мягком кольце */}
        <motion.div
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.5, ease: [0.22, 0.68, 0.3, 1] }}
          className="relative flex size-28 items-center justify-center"
        >
          <span className="absolute inset-0 rounded-full bg-tg-link/10" aria-hidden />
          <motion.svg
            width="64"
            height="64"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden
            className="text-tg-link"
            animate={{ y: [0, -4, 0], rotate: [-9, -12, -9] }}
            transition={{ duration: 3.4, repeat: Infinity, ease: 'easeInOut' }}
          >
            <path d="M23.91 3.79 20.3 20.84c-.25 1.21-.98 1.5-2 .94l-5.5-4.07-2.66 2.57c-.3.3-.55.56-1.1.56-.55 0-.46-.21-.65-.66L6.6 14.04l-5.45-1.7c-1.18-.36-1.19-1.18.25-1.75l21.26-8.2c.97-.43 1.9.24 1.25 1.4z" />
          </motion.svg>
          {/* гаечный ключ — маленький бейдж у кольца */}
          <span className="absolute bottom-1 right-1 flex size-8 items-center justify-center rounded-full bg-tg-surface ring-1 ring-tg-sep" aria-hidden>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-tg-hint">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
            </svg>
          </span>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25, duration: 0.5, ease: 'easeOut' }}
          className="mt-6 flex flex-col items-center gap-2 text-center"
        >
          <h1 className="text-[22px] font-bold tracking-tight text-tg-text">
            Проводим технические работы
          </h1>
          <p className="max-w-[300px] text-[14.5px] leading-relaxed text-tg-hint">
            {message ?? 'Обновляем ленту и чиним мелочи. Скоро вернёмся — обычно это занимает немного времени.'}
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.45, duration: 0.5 }}
          className="mt-8 flex flex-col items-center gap-3"
        >
          <button
            type="button"
            onClick={() => void check()}
            disabled={checking}
            className="flex min-h-[44px] items-center gap-2 rounded-full bg-tg-link px-6 text-[15px] font-semibold text-white shadow-sm transition-transform active:scale-95 disabled:opacity-60"
          >
            <RefreshCw className={checking ? 'size-4 animate-spin' : 'size-4'} aria-hidden />
            {checking ? 'Проверяем…' : 'Проверить снова'}
          </button>
          <span className="text-xs tabular-nums text-tg-hint">
            Автопроверка через {left} с
          </span>
        </motion.div>
      </div>
    </div>
  )
}
