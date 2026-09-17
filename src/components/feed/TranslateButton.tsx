'use client'

import { useState } from 'react'
import { Languages, Loader2, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { haptic } from '@/lib/tg'
import { RichText } from '@/components/feed/RichText'

/**
 * Кнопка «Перевести» под постом — как в Twitter: появляется, если текст
 * явно не на русском; тап переводит пост на родной язык пользователя
 * (OpenRouter, самая дешёвая модель) и показывает перевод под оригиналом.
 * Перевод кэшируется на сервере — повторное открытие мгновенно.
 */

function isForeign(text: string): boolean {
  if (text.trim().length < 24) return false
  const letters = text.match(/[a-zA-Zа-яёА-ЯЁ]/g)
  if (!letters || letters.length < 8) return false
  const cyr = text.match(/[а-яёА-ЯЁ]/g)
  return (cyr?.length ?? 0) / letters.length < 0.15
}

export function TranslateButton({ postId, text }: { postId: string; text: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done'>('idle')
  const [translated, setTranslated] = useState<string | null>(null)
  const [showOriginal, setShowOriginal] = useState(false)

  if (!isForeign(text)) return null

  const translate = () => {
    if (state === 'loading') return
    haptic('light')
    if (translated) {
      setState('done')
      setShowOriginal(false)
      return
    }
    setState('loading')
    api<{ ok: boolean; text?: string; reason?: string }>('/api/translate', {
      method: 'POST',
      body: JSON.stringify({ postId }),
    })
      .then((r) => {
        if (r.ok && r.text) {
          setTranslated(r.text)
          setState('done')
        } else {
          setState('idle')
          if (r.reason === 'russian') {
            // текст уже на русском — просто прячем кнопку в следующий раз
            setTranslated(null)
          } else {
            toast.error('Перевод недоступен, попробуйте позже')
          }
        }
      })
      .catch(() => {
        setState('idle')
        toast.error('Перевод недоступен, попробуйте позже')
      })
  }

  if (state === 'done' && translated) {
    return (
      <div className="mt-2.5" data-noswipe>
        <div className="rounded-xl border-l-[3px] border-tg-link/50 bg-tg-surface/70 px-3.5 py-3">
          <div className="text-[11.5px] font-semibold uppercase tracking-wide text-tg-hint">
            Перевод · автоматически
          </div>
          {showOriginal ? (
            <RichText text={text} className="mt-1.5 text-[14.5px]" />
          ) : (
            <RichText text={translated} className="mt-1.5 text-[14.5px]" />
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            haptic('light')
            setShowOriginal((v) => !v)
          }}
          className="mt-1.5 inline-flex items-center gap-1.5 text-[13px] font-medium text-tg-hint active:opacity-60"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          {showOriginal ? 'Показать перевод' : 'Показать оригинал'}
        </button>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={translate}
      className="mt-2.5 inline-flex items-center gap-1.5 text-[14px] font-semibold text-tg-link active:opacity-60"
      data-noswipe
    >
      {state === 'loading' ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        <Languages className="h-4 w-4" aria-hidden />
      )}
      {state === 'loading' ? 'Переводим…' : 'Перевести'}
    </button>
  )
}
