'use client'

import { useCallback, useRef, useState } from 'react'
import { Languages, Loader2, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { apiStream } from '@/lib/api'
import { haptic } from '@/lib/tg'
import { useT } from '@/lib/i18n'

/**
 * Перевод поста на родной язык читателя — как в Twitter: переведённый текст
 * ЗАМЕЩАЕТ оригинал на месте, внизу остаётся компактная строка-контрол
 * («Показать оригинал» / «Показать перевод»).
 *
 * СКОРОСТЬ: перевод СТРИМИТСЯ (SSE /api/translate/stream) — переведённый текст
 * печатается на месте прямо во время генерации: первый кусок виден через ~1с,
 * а не весь ответ через 5–15с. Кэш на сервере — повторное открытие мгновенно.
 */

function isForeign(text: string): boolean {
  if (text.trim().length < 24) return false
  const letters = text.match(/[a-zA-Zа-яёА-ЯЁ]/g)
  if (!letters || letters.length < 8) return false
  const cyr = text.match(/[а-яёА-ЯЁ]/g)
  return (cyr?.length ?? 0) / letters.length < 0.15
}

export type TranslationState = {
  /** Текст явно не на русском — кнопка «Перевести» показывается */
  foreign: boolean
  busy: boolean
  /** Переведённый текст (null — ещё не переводили); при стриминге приходит кусками */
  translated: string | null
  showOriginal: boolean
  translate: () => void
  setShowOriginal: (v: boolean) => void
}

export function useTranslation(postId: string, text: string): TranslationState {
  const t = useT()
  const [foreign] = useState(() => isForeign(text))
  const [busy, setBusy] = useState(false)
  const [translated, setTranslated] = useState<string | null>(null)
  const [showOriginal, setShowOriginal] = useState(false)
  // Аккумулятор в ref: дельты приходят часто, setState только на текст
  const accRef = useRef('')

  const translate = useCallback(() => {
    if (busy) return
    if (translated) {
      haptic('light')
      setShowOriginal(false)
      return
    }
    haptic('light')
    setBusy(true)
    accRef.current = ''
    let first = true
    apiStream('/api/translate/stream', { postId }, (type, data) => {
      if (type === 'delta') {
        accRef.current += String(data.v ?? '')
        if (first) {
          first = false
          setBusy(false) // текст уже печатается — спиннер больше не нужен
        }
        setTranslated(accRef.current)
      } else if (type === 'fail') {
        const reason = data.reason
        if (reason !== 'russian' && reason !== 'short') toast.error(t('translate.error'))
      }
    })
      .catch(() => {
        if (!accRef.current) toast.error(t('translate.error'))
      })
      .finally(() => setBusy(false))
  }, [busy, postId, translated, t])

  if (!foreign) {
    return {
      foreign: false,
      busy: false,
      translated: null,
      showOriginal: false,
      translate: () => {},
      setShowOriginal: () => {},
    }
  }
  return { foreign, busy, translated, showOriginal, translate, setShowOriginal }
}

/** Какой текст показывать: переведённый замещает оригинал (Twitter-style) */
export function translatedText(tr: TranslationState, original: string): string {
  if (tr.translated && !tr.showOriginal) return tr.translated
  return original
}

/**
 * Строка-контрол перевода под постом: до перевода — кнопка «Перевести»,
 * после — «Показать оригинал / Показать перевод» + пометка об автопереводе.
 */
export function TranslateControl({ tr }: { tr: TranslationState }) {
  const t = useT()
  if (!tr.foreign) return null

  if (!tr.translated) {
    return (
      <button
        type="button"
        onClick={tr.translate}
        className="mt-2 flex w-fit items-center gap-1.5 text-[14px] font-semibold text-tg-link active:opacity-60"
        data-noswipe
      >
        {tr.busy ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <Languages className="h-4 w-4" aria-hidden />
        )}
        {tr.busy ? t('translate.doing') : t('translate.do')}
      </button>
    )
  }

  return (
    <div className="mt-2 flex items-center gap-2" data-noswipe>
      {!tr.showOriginal && (
        <span className="text-[12.5px] text-tg-hint">{t('translate.auto')}</span>
      )}
      <button
        type="button"
        onClick={() => {
          haptic('light')
          tr.setShowOriginal(!tr.showOriginal)
        }}
        className="inline-flex items-center gap-1.5 text-[13px] font-medium text-tg-link active:opacity-60"
      >
        <RotateCcw className="h-3.5 w-3.5" aria-hidden />
        {tr.showOriginal ? t('translate.showTranslation') : t('translate.showOriginal')}
      </button>
    </div>
  )
}
