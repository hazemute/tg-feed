'use client'

import { useEffect, useState } from 'react'
import { Check, Send, Sparkles } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { haptic } from '@/lib/tg'

/**
 * Экран выбора интересов (редактирование из профиля).
 * Чипы без эмодзи, stagger-появление, живой прогресс до минимума.
 */
export function Onboarding({
  open,
  mode,
  onClose,
}: {
  open: boolean
  mode: 'onboarding' | 'edit'
  onClose: () => void
}) {
  const { categories, user, bumpFeed } = useApp()
  const [selected, setSelected] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setSelected(mode === 'edit' ? useApp.getState().interests : [])
    }
  }, [open, mode])

  if (!open) return null

  const min = mode === 'onboarding' ? 3 : 1
  const progress = Math.min(1, selected.length / min)
  const canSave = selected.length >= min && !saving

  const toggle = (slug: string) => {
    haptic('light')
    setSelected((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
    )
  }

  const save = async () => {
    if (!user || selected.length < min || saving) return
    setSaving(true)
    try {
      await api('/api/user/categories', {
        method: 'POST',
        body: JSON.stringify({ userId: user.id, categoryIds: selected }),
      })
      // Синхронизируем и профиль, и интересы в сторе (иначе на экране «Профиль» нули)
      useApp.setState((s) => ({
        user: s.user ? { ...s.user, categories: selected } : null,
        interests: selected,
      }))
      bumpFeed()
      haptic('success')
      toast.success(mode === 'onboarding' ? 'Лента собрана под вас' : 'Интересы обновлены')
      onClose()
    } catch (e) {
      toast.error((e as Error).message || 'Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 mx-auto flex w-full flex-col overflow-hidden bg-tg-bg lg:bottom-auto lg:top-[5vh] lg:h-[90vh] lg:max-w-[640px] lg:rounded-3xl lg:border lg:border-tg-sep lg:shadow-[0_24px_90px_rgba(0,0,0,0.30)]" role="dialog" aria-modal="true">
      {/* Логотип с мягким пульсом */}
      <div className="flex justify-center pt-12">
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 300, damping: 20 }}
          className="relative flex h-14 w-14 items-center justify-center rounded-[18px] bg-tg-link shadow-lg shadow-tg-link/30"
        >
          <Send className="h-6 w-6 -translate-x-px translate-y-px text-white" />
          {mode === 'onboarding' && (
            <motion.span
              aria-hidden
              animate={{ scale: [1, 1.5], opacity: [0.35, 0] }}
              transition={{ duration: 1.8, repeat: Infinity, ease: 'easeOut' }}
              className="absolute inset-0 rounded-[18px] bg-tg-link"
            />
          )}
        </motion.div>
      </div>

      <div className="px-6 pt-5 text-center">
        <h1 className="text-[24px] font-bold tracking-tight text-tg-text">
          {mode === 'onboarding' ? 'Добро пожаловать в Tg Swipe' : 'Ваши интересы'}
        </h1>
        <p className="mt-2 text-snippet text-tg-hint">
          {mode === 'onboarding'
            ? 'Выберите минимум 3 темы — алгоритм соберёт ленту из открытых Telegram-каналов'
            : 'Обновите темы — лента перестроится под вас'}
        </p>
      </div>

      {/* Прогресс выбора: N из M тем */}
      <div className="mx-auto mt-4 flex w-full max-w-[300px] items-center gap-2.5 px-6" aria-live="polite">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-tg-surface">
          <motion.div
            className="h-full rounded-full bg-tg-link"
            initial={false}
            animate={{ width: `${Math.round(progress * 100)}%` }}
            transition={{ type: 'spring', stiffness: 260, damping: 26 }}
          />
        </div>
        <span
          className={cn(
            'min-w-12 text-right text-[12px] font-semibold tabular-nums transition-colors',
            selected.length >= min ? 'text-tg-green' : 'text-tg-hint',
          )}
        >
          {selected.length}/{min}
        </span>
      </div>

      <div className="no-scrollbar flex flex-1 flex-wrap content-start justify-center gap-2.5 overflow-y-auto px-6 py-5">
        {categories.length === 0
          ? [...Array(8)].map((_, i) => (
              <div key={i} className="tg-shimmer h-11 w-28 rounded-full" />
            ))
          : categories.map((c, i) => {
              const active = selected.includes(c.slug)
              return (
                <motion.button
                  key={c.slug}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggle(c.slug)}
                  initial={{ opacity: 0, y: 10, scale: 0.92 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ delay: 0.03 * i, type: 'spring', stiffness: 380, damping: 26 }}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full px-4 py-2.5 text-[14px] font-medium transition-colors active:scale-95',
                    active
                      ? 'bg-tg-link text-white shadow-md shadow-tg-link/25'
                      : 'bg-tg-surface text-tg-text',
                  )}
                >
                  {c.title}
                  <AnimatePresence>
                    {active && (
                      <motion.span
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0, opacity: 0 }}
                        transition={{ type: 'spring', stiffness: 500, damping: 26 }}
                        aria-hidden
                        className="flex h-4 w-4 items-center justify-center rounded-full bg-white/25"
                      >
                        <Check className="h-3 w-3 text-white" strokeWidth={3} />
                      </motion.span>
                    )}
                  </AnimatePresence>
                </motion.button>
              )
            })}
      </div>

      <div className="shrink-0 border-t border-tg-sep p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          disabled={!canSave}
          onClick={save}
          className={cn(
            'flex h-[52px] w-full items-center justify-center gap-2 rounded-full text-[16px] font-semibold transition active:scale-[0.98]',
            canSave
              ? 'bg-tg-link text-white shadow-lg shadow-tg-link/25'
              : 'cursor-not-allowed bg-tg-surface text-tg-hint',
          )}
        >
          {canSave && mode === 'onboarding' && <Sparkles className="h-[18px] w-[18px]" />}
          {selected.length < min
            ? `Выбрано ${selected.length} из ${min} — добавьте ещё ${min - selected.length}`
            : saving
              ? 'Сохраняем…'
              : mode === 'onboarding'
                ? 'Настроить ленту'
                : 'Сохранить'}
        </button>
      </div>
    </div>
  )
}
