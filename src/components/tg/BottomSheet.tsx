'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useBackButton } from '@/lib/tg'

/** Лаконичный bottom sheet в стиле Telegram (светлый, без неона) */
export function BottomSheet({
  open,
  onClose,
  title,
  subtitle,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string
  children: ReactNode
}) {
  // Нативная кнопка «назад» Telegram закрывает шит
  useBackButton(open, onClose)
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[60] flex flex-col justify-end"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} aria-hidden />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 320 }}
            className="relative mx-auto w-full max-w-[520px] rounded-t-3xl bg-tg-bg px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-8px_40px_rgba(0,0,0,0.18)]"
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-tg-sep" aria-hidden />
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <div className="text-[19px] font-bold text-tg-text">{title}</div>
                {subtitle && <div className="mt-0.5 text-[13.5px] text-tg-hint">{subtitle}</div>}
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Закрыть"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-tg-surface text-tg-hint active:scale-90"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
