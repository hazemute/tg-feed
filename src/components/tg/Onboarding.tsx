'use client'

import { useEffect, useState } from 'react'
import { Send } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { haptic } from '@/lib/tg'

/**
 * Экран выбора интересов (онбординг при первом входе / редактирование из профиля).
 * PRD: при первом входе нужно выбрать минимум 3 темы.
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
    <div className="fixed inset-0 z-50 flex flex-col bg-tg-bg" role="dialog" aria-modal="true">
      <div className="flex justify-center pt-12">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-tg-button">
          <Send className="h-5 w-5 -translate-x-px translate-y-px text-white" />
        </div>
      </div>

      <div className="px-6 pt-5 text-center">
        <h1 className="text-[24px] font-bold tracking-tight text-tg-text">
          {mode === 'onboarding' ? 'Добро пожаловать в TG-Feed' : 'Ваши интересы'}
        </h1>
        <p className="mt-2 text-snippet text-tg-hint">
          {mode === 'onboarding'
            ? 'Выберите минимум 3 темы — алгоритм соберёт ленту из открытых Telegram-каналов'
            : 'Обновите темы — лента перестроится под вас'}
        </p>
      </div>

      <div className="no-scrollbar flex flex-1 flex-wrap content-start justify-center gap-2.5 overflow-y-auto px-6 py-6">
        {categories.length === 0
          ? [...Array(8)].map((_, i) => (
              <div key={i} className="h-11 w-28 animate-pulse rounded-full bg-tg-surface" />
            ))
          : categories.map((c) => {
              const active = selected.includes(c.slug)
              return (
                <button
                  key={c.slug}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggle(c.slug)}
                  className={cn(
                    'rounded-full px-4 py-2.5 text-[14px] font-medium transition active:scale-95',
                    active ? 'bg-tg-link text-white' : 'bg-tg-surface text-tg-text',
                  )}
                >
                  {c.title}
                </button>
              )
            })}
      </div>

      <div className="shrink-0 border-t border-tg-sep p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          disabled={selected.length < min || saving}
          onClick={save}
          className={cn(
            'h-[52px] w-full rounded-full text-[16px] font-semibold transition active:scale-[0.98]',
            selected.length < min
              ? 'cursor-not-allowed bg-tg-surface text-tg-hint'
              : 'bg-tg-link text-white',
          )}
        >
          {selected.length < min
            ? `Выбрано: ${selected.length}/${min}`
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
