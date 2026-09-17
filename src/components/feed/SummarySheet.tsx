'use client'

import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Sparkles } from 'lucide-react'
import { api } from '@/lib/api'
import { useBackButton } from '@/lib/tg'
import type { PostDTO, SummaryResponse } from '@/lib/types'

/**
 * AI-саммари: полупрозрачный bottom sheet с выжимкой лонгрида в 3 пункта.
 * Результат кэшируется на бэке (Post.aiSummary).
 */
export function SummarySheet({ post, onClose }: { post: PostDTO | null; onClose: () => void }) {
  const [data, setData] = useState<{ postId: string; items?: string[]; note?: string } | null>(null)

  // Нативная кнопка «назад» Telegram закрывает шит
  useBackButton(!!post, onClose)

  useEffect(() => {
    if (!post) return
    let cancelled = false
    const pid = post.id
    api<SummaryResponse>('/api/summary', {
      method: 'POST',
      body: JSON.stringify({ postId: pid }),
    })
      .then((r) => {
        if (cancelled) return
        if (r.tooShort || r.items.length === 0) {
          setData({
            postId: pid,
            note: 'Пост короткий — саммари не требуется, просто прочитайте его целиком',
          })
        } else {
          setData({ postId: pid, items: r.items })
        }
      })
      .catch((e) => {
        if (!cancelled)
          setData({
            postId: pid,
            note: (e as Error).message || 'Не удалось сгенерировать саммари',
          })
      })
    return () => {
      cancelled = true
    }
  }, [post?.id])  

  const loading = !!post && (!data || data.postId !== post.id)
  const items = data && post && data.postId === post.id ? (data.items ?? []) : []
  const note = data && post && data.postId === post.id ? (data.note ?? null) : null

  return (
    <AnimatePresence>
      {post && (
        <motion.div
          className="fixed inset-0 z-[60] flex flex-col justify-end"
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
            aria-label="AI-саммари поста"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 320 }}
            className="relative mx-auto w-full max-w-[520px] rounded-t-3xl bg-tg-bg p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-[0_-8px_40px_rgba(0,0,0,0.18)]"
          >
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-tg-sep" aria-hidden />

            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-tg-link/10">
                <Sparkles className="h-[18px] w-[18px] text-tg-link" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-semibold text-tg-text">Краткое содержание</div>
                <div className="truncate text-[12px] text-tg-hint">
                  {post.channel.title} · выжимка в 3 пунктах
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-full bg-tg-surface px-3 py-1.5 text-[12px] font-medium text-tg-text2"
              >
                Закрыть
              </button>
            </div>

            <div className="mt-4 space-y-3">
              {loading ? (
                [0, 1, 2].map((i) => (
                  <div key={i} className="flex items-start gap-3">
                    <div className="h-6 w-6 shrink-0 animate-pulse rounded-full bg-tg-surface" />
                    <div className="h-4 flex-1 animate-pulse rounded bg-tg-surface" />
                  </div>
                ))
              ) : note ? (
                <p className="text-snippet text-tg-text2">{note}</p>
              ) : (
                items.map((b, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.08 * i }}
                    className="flex items-start gap-3"
                  >
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-tg-link/10 text-[12px] font-bold text-tg-link">
                      {i + 1}
                    </span>
                    <p className="text-snippet leading-snug text-tg-text">{b}</p>
                  </motion.div>
                ))
              )}
            </div>

            <p className="mt-4 text-center text-[11px] text-tg-hint">
              Сгенерировано нейросетью · может ошибаться в деталях
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
