'use client'

import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Loader2, Mic, Square, X } from 'lucide-react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

/**
 * Поле ввода в стиле Telegram (v5.21): слитая капсула — textarea растёт по
 * высоте, справа иконка МИКРОФОНА, когда поле пусто, и КНОПКА ОТПРАВКИ,
 * когда есть текст. Голосовой ввод — Web Speech API (ru-RU): промежуточные
 * результаты печатаются в поле, повторный тап останавливает запись.
 */

/* Минимальные типы Web Speech API (не в lib.dom) */
type SpeechRecognitionAlternativeLike = { transcript: string }
type SpeechRecognitionResultLike = { isFinal: boolean; 0: SpeechRecognitionAlternativeLike; length: number }
type SpeechRecognitionEventLike = { resultIndex: number; results: { length: number; [i: number]: SpeechRecognitionResultLike } }
type RecognitionLike = {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onerror: ((e: { error?: string }) => void) | null
  onend: (() => void) | null
}
type RecognitionCtor = new () => RecognitionLike

function getRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor
    webkitSpeechRecognition?: RecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function ChatInput({
  value,
  onChange,
  onSend,
  placeholder,
  disabled,
  busy,
  maxLength = 4000,
  lang = 'ru-RU',
  className,
  sendLabel = 'Отправить',
  micLabel = 'Голосовой ввод',
}: {
  value: string
  onChange: (v: string) => void
  onSend: (text: string) => void
  placeholder: string
  disabled?: boolean
  /** Сервер занят — отправка и микрофон неактивны */
  busy?: boolean
  maxLength?: number
  /** Язык распознавания (BCP-47) */
  lang?: string
  className?: string
  sendLabel?: string
  micLabel?: string
}) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const recRef = useRef<RecognitionLike | null>(null)
  const [listening, setListening] = useState(false)
  const [recUnsupported, setRecUnsupported] = useState(false)

  // Автовысота: 1 строка → до 120px
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [value])

  const canSend = value.trim().length > 0 && !disabled && !busy

  const stopListening = () => {
    try {
      recRef.current?.stop()
    } catch {
      /* уже остановлен */
    }
    recRef.current = null
    setListening(false)
  }

  const startListening = () => {
    const Ctor = getRecognitionCtor()
    if (!Ctor) {
      setRecUnsupported(true)
      toast.info('Голосовой ввод не поддерживается этим браузером')
      return
    }
    if (listening) {
      stopListening()
      return
    }
    try {
      const rec = new Ctor()
      rec.lang = lang
      rec.continuous = true
      rec.interimResults = true
      let base = value.trim() ? `${value.trim()} ` : ''
      rec.onresult = (e) => {
        let interim = ''
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i]
          if (r.isFinal) base += `${r[0].transcript} `
          else interim += r[0].transcript
        }
        onChange((base + interim).trimStart().slice(0, maxLength))
      }
      rec.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          toast.error('Нет доступа к микрофону — разрешите его в настройках')
        } else if (e.error === 'no-speech') {
          toast.info('Речь не распознана — попробуйте ещё раз')
        }
        recRef.current = null
        setListening(false)
      }
      rec.onend = () => {
        recRef.current = null
        setListening(false)
      }
      rec.start()
      recRef.current = rec
      setListening(true)
    } catch {
      recRef.current = null
      setListening(false)
      toast.error('Не удалось запустить микрофон')
    }
  }

  // Размонтирование: остановить запись
  useEffect(() => () => stopListening(), [])  

  return (
    <div className={cn('flex items-end gap-2', className)}>
      {/* Слитая капсула ввода (как в Telegram) */}
      <div
        className={cn(
          'relative flex min-h-[42px] flex-1 items-end rounded-[21px] border bg-tg-surface transition-colors',
          listening ? 'border-tg-like/60' : 'border-transparent focus-within:border-tg-link/40',
        )}
      >
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (canSend) onSend(value.trim())
            }
          }}
          rows={1}
          maxLength={maxLength}
          disabled={disabled}
          placeholder={placeholder}
          aria-label={placeholder}
          className="max-h-[120px] w-full resize-none bg-transparent px-4 py-2.5 text-[15px] leading-snug text-tg-text outline-none placeholder:text-tg-hint"
        />
        {listening && (
          <span className="pointer-events-none absolute -top-7 left-3 inline-flex items-center gap-1.5 rounded-full bg-tg-like px-2.5 py-1 text-[11px] font-semibold text-white shadow-md">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
            Слушаю…
          </span>
        )}
      </div>

      {/* Правая кнопка: микрофон (пусто) ⇄ отправка (есть текст) — как в Telegram */}
      {value.trim() || busy ? (
        <motion.button
          type="button"
          data-noswipe
          whileTap={{ scale: 0.88 }}
          onClick={() => {
            if (canSend) onSend(value.trim())
          }}
          disabled={!canSend}
          aria-label={sendLabel}
          className={cn(
            'flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full bg-tg-link text-white transition active:scale-90',
            !canSend && 'opacity-40',
          )}
        >
          {busy ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : <ArrowUp className="h-5 w-5" strokeWidth={2.4} aria-hidden />}
        </motion.button>
      ) : (
        <motion.button
          type="button"
          data-noswipe
          whileTap={{ scale: 0.88 }}
          onClick={startListening}
          disabled={disabled}
          aria-label={micLabel}
          aria-pressed={listening}
          className={cn(
            'flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full transition active:scale-90',
            listening ? 'bg-tg-like text-white' : 'bg-tg-surface text-tg-hint',
            disabled && 'opacity-40',
          )}
        >
          {listening ? <Square className="h-4 w-4 fill-current" aria-hidden /> : <Mic className="h-5 w-5" strokeWidth={1.9} aria-hidden />}
        </motion.button>
      )}

      {recUnsupported && <span className="sr-only">Голосовой ввод не поддерживается</span>}
    </div>
  )
}
