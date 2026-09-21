'use client'

import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Sparkles } from 'lucide-react'
import { apiStream } from '@/lib/api'
import { stripMarkdown } from '@/lib/markdown'
import { useBackButton } from '@/lib/tg'
import { useT } from '@/lib/i18n'
import type { PostDTO } from '@/lib/types'
import { Portal } from '@/components/ui/Portal'

/**
 * AI-саммари: полупрозрачный bottom sheet с выжимкой лонгрида в 3 пункта.
 *
 * ПАНЕЛЬ ОТКРЫВАЕТСЯ МГНОВЕННО по тапу на кнопку — генерация идёт ВНУТРИ
 * панели: пункты печатаются построчно по мере прихода дельт LLM (SSE
 * /api/summary/stream). Раньше панель была, но 5–15с скелетонов выглядели
 * как «кнопка не работает» — теперь текст появляется через ~1с.
 * Результат кэшируется на бэке (Post.aiSummary) — повторное открытие мгновенно.
 */

type SummaryState = {
  postId: string
  lines: string[]
  /** Незавершённая строка, которую модель ещё печатает */
  partial: string
  done: boolean
  note?: string
  fallback?: boolean
}

export function SummarySheet({ post, onClose }: { post: PostDTO | null; onClose: () => void }) {
  const t = useT()
  const [data, setData] = useState<SummaryState | null>(null)

  // Нативная кнопка «назад» Telegram закрывает шит
  useBackButton(!!post, onClose)

  useEffect(() => {
    if (!post) return
    let cancelled = false
    const pid = post.id
    // data не сбрасываем: state ключуется по postId, «чужие» данные
    // отфильтровываются проверкой data.postId !== post.id ниже

    // Аккумулятор сырого потока: превращаем в «готовые строки + печатаемая»
    let raw = ''
    const applyRaw = () => {
      const parts = raw
        .split('\n')
        .map((l) => l.replace(/^[\s\d.*•\-]+/, '').trim())
        .filter(Boolean)
      const lines = parts.slice(0, -1)
      const partial = parts.length > 0 ? (parts[parts.length - 1] ?? '') : ''
      if (!cancelled) setData({ postId: pid, lines, partial, done: false })
    }

    apiStream('/api/summary/stream', { postId: pid }, (type, d) => {
      if (cancelled) return
      if (type === 'cached' || type === 'done') {
        const items = (Array.isArray(d.items) ? (d.items as string[]) : []).map((s) =>
          stripMarkdown(String(s)).trim(),
        )
        setData({
          postId: pid,
          lines: items,
          partial: '',
          done: true,
          fallback: d.fallback === true,
        })
      } else if (type === 'delta') {
        raw += String(d.v ?? '')
        applyRaw()
      } else if (type === 'tooShort') {
        setData({ postId: pid, lines: [], partial: '', done: true, note: t('summary.tooShort') })
      } else if (type === 'fail') {
        setData({
          postId: pid,
          lines: [],
          partial: '',
          done: true,
          note: String(d.message ?? '') || t('summary.error'),
        })
      }
    }).catch(() => {
      if (!cancelled)
        setData({ postId: pid, lines: [], partial: '', done: true, note: t('summary.error') })
    })

    return () => {
      cancelled = true
    }
  }, [post?.id, t])

  const loading = !!post && (!data || data.postId !== post.id)
  const state = data && post && data.postId === post.id ? data : null
  const lines = state?.lines ?? []
  const partial = !state?.done ? (state?.partial ?? '') : ''
  const note = state?.note ?? null

  // v5.74: портал в body — иначе шит застревает в stacking context motion.main
  // и красится ПОД навбаром (z-40)
  return (
    <Portal>
    <AnimatePresence>
      {post && (
        <motion.div
          className="fixed inset-0 z-[60] flex flex-col justify-end lg:justify-center lg:px-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={onClose}
            aria-hidden
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={t('summary.title')}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 320 }}
            className="relative mx-auto max-h-[92dvh] w-full max-w-[520px] overflow-y-auto rounded-t-3xl lg:max-h-[80vh] lg:rounded-3xl lg:shadow-[0_24px_80px_rgba(0,0,0,0.28)] bg-tg-bg p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-[0_-8px_40px_rgba(0,0,0,0.18)]"
          >
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-tg-sep lg:hidden" aria-hidden />

            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-tg-link/10">
                <Sparkles className="h-[18px] w-[18px] text-tg-link" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-semibold text-tg-text">{t('summary.title')}</div>
                <div className="truncate text-[12px] text-tg-hint">
                  {post.channel.title} · {t('summary.subtitle')}
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="press rounded-full bg-tg-surface px-3 py-1.5 text-[12px] font-medium text-tg-text2"
              >
                {t('summary.close')}
              </button>
            </div>

            <div className="mt-4 space-y-3">
              {loading ? (
                [0, 1, 2].map((i) => (
                  <div key={i} className="flex items-start gap-3">
                    <div className="tg-shimmer h-6 w-6 shrink-0 rounded-full" />
                    <div className="tg-shimmer h-4 flex-1 rounded" />
                  </div>
                ))
              ) : note ? (
                <p className="text-snippet text-tg-text2">{note}</p>
              ) : (
                <>
                  {lines.map((b, i) => (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.18 }}
                      className="flex items-start gap-3"
                    >
                      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-tg-link/10 text-[12px] font-bold text-tg-link">
                        {i + 1}
                      </span>
                      <p className="text-snippet leading-snug text-tg-text">{stripMarkdown(b)}</p>
                    </motion.div>
                  ))}
                  {/* Строка, которую модель печатает прямо сейчас — эффект «живой генерации» */}
                  {(partial || (!state?.done && lines.length === 0)) && (
                    <div className="flex items-start gap-3">
                      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-tg-link/10 text-[12px] font-bold text-tg-link/70">
                        {lines.length + 1}
                      </span>
                      <p className="text-snippet leading-snug text-tg-text2">
                        {stripMarkdown(partial) || t('summary.generating')}
                        <span className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-tg-link align-middle" aria-hidden />
                      </p>
                    </div>
                  )}
                </>
              )}
            </div>

            <p className="mt-4 text-center text-[11px] text-tg-hint">
              {state?.fallback
                ? t('summary.fallbackNote')
                : t('summary.disclaimer')}
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
    </Portal>
  )
}
