'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowLeft, ArrowUp, Headset, ShieldCheck, Bot, UserRound } from 'lucide-react'

import { api } from '@/lib/api'
import { haptic } from '@/lib/tg'
import { useT } from '@/lib/i18n'
import { RichText } from '@/components/feed/RichText'
import { cn } from '@/lib/utils'

/**
 * Чат поддержки — стиль нативного Telegram.
 *
 * Слева — ответы поддержки (нейросеть или сотрудник), справа — сообщения
 * пользователя. Markdown в ответах рендерится тем же RichText'ом, что и посты.
 * Нейросеть дешёвая (gemini-2.5-flash-lite через OpenRouter) и знает
 * устройство приложения; сложные обращения эскалируются сотруднику в
 * админ-панель, ответ приходит в этот же чат (поллинг раз в 5с).
 */

type Msg = { id: string; sender: string; text: string; createdAt: string }
type ThreadState = { status: 'ai' | 'human' | 'closed' | null; messages: Msg[] }

const STATUS_KEY: Record<string, 'support.subtitle.ai' | 'support.subtitle.human' | 'support.subtitle.closed'> = {
  ai: 'support.subtitle.ai',
  human: 'support.subtitle.human',
  closed: 'support.subtitle.closed',
}

function timeOf(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Анимация «печатает…» — три подпрыгивающие точки */
function TypingDots({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 py-1" aria-label={label}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 animate-bounce rounded-full bg-tg-hint/70"
          style={{ animationDelay: `${i * 150}ms`, animationDuration: '0.9s' }}
        />
      ))}
    </span>
  )
}

export function SupportChat({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const [state, setState] = useState<ThreadState>({ status: null, messages: [] })
  const [loaded, setLoaded] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const scrollBottom = useCallback((smooth = true) => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  const load = useCallback(async () => {
    try {
      const data = await api<ThreadState>('/api/support')
      setState(data)
    } catch {
      // сеть/сессия — молча, чат покажет пустое состояние
    } finally {
      setLoaded(true)
    }
  }, [])

  // Открытие: загрузка + подписка на ответы сотрудника (поллинг)
  useEffect(() => {
    if (!open) return
    setLoaded(false)
    void load()
    const timer = setInterval(() => {
      if (!sending) void load()
    }, 5_000)
    return () => clearInterval(timer)
  }, [open])

  // Новые сообщения — вниз
  useEffect(() => {
    if (open) scrollBottom(false)
  }, [state.messages.length, open, scrollBottom])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setDraft('')
    haptic('light')
    // Оптимистичное сообщение: пользователь видит свой текст мгновенно
    const optimistic: Msg = { id: `tmp-${Date.now()}`, sender: 'user', text, createdAt: new Date().toISOString() }
    setState((s) => ({ ...s, messages: [...s.messages, optimistic] }))
    try {
      const res = await api<{ ok: boolean; status: ThreadState['status']; messages: Msg[] }>('/api/support', {
        method: 'POST',
        body: JSON.stringify({ text }),
      })
      setState((s) => ({
        status: res.status,
        // Оптимистичный пузырь заменяется настоящим (с id и серверным временем)
        messages: [...s.messages.filter((m) => m.id !== optimistic.id), ...res.messages],
      }))
      haptic('success')
    } catch {
      // Ошибка — возвращаем черновик, чтобы сообщение не потерялось
      setState((s) => ({ ...s, messages: s.messages.filter((m) => m.id !== optimistic.id) }))
      setDraft(text)
      haptic('error')
    } finally {
      setSending(false)
    }
  }, [draft, sending])

  if (!open) return null

  const waiting = sending && state.status !== 'human'

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 380, damping: 34 }}
      className="fixed inset-0 z-[60] flex flex-col bg-tg-bg"
      role="dialog"
      aria-label={t('support.dialog')}
    >
      {/* Шапка как в Telegram-чате */}
      <header className="flex shrink-0 items-center gap-3 border-b border-tg-sep/60 bg-tg-surface/80 px-2 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] backdrop-blur-md">
        <button
          type="button"
          onClick={onClose}
          aria-label={t('support.back')}
          className="flex h-10 w-10 items-center justify-center rounded-full text-tg-link active:bg-tg-sep/40"
        >
          <ArrowLeft className="h-[22px] w-[22px]" />
        </button>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-tg-link text-white">
          <Headset className="h-[18px] w-[18px]" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[16px] font-semibold text-tg-text">{t('support.title')}</span>
          <span className="block truncate text-[12.5px] text-tg-hint">
            {state.status ? t(STATUS_KEY[state.status]) : t('support.subtitle.idle')}
          </span>
        </span>
      </header>

      {/* Лента сообщений */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain px-3 py-3">
        {!loaded ? (
          <div className="flex h-full items-center justify-center">
            <div className="size-7 animate-spin rounded-full border-2 border-tg-sep border-t-tg-link" aria-label={t('support.loading')} />
          </div>
        ) : state.messages.length === 0 ? (
          <div className="mx-auto mt-10 max-w-[280px] text-center">
            <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-tg-link/10 text-tg-link">
              <Headset className="h-7 w-7" aria-hidden />
            </span>
            <p className="mt-3 text-[15px] font-semibold text-tg-text">{t('support.welcomeTitle')}</p>
            <p className="mt-1 text-[13.5px] leading-relaxed text-tg-hint">{t('support.welcomeText')}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {state.messages.map((m) => {
              if (m.sender === 'system') {
                return (
                  <div key={m.id} className="flex justify-center py-1">
                    <span className="flex items-center gap-1.5 rounded-full bg-tg-sep/40 px-3 py-1 text-[11.5px] font-medium text-tg-hint">
                      <ShieldCheck className="h-3 w-3" aria-hidden />
                      {m.text}
                    </span>
                  </div>
                )
              }
              const mine = m.sender === 'user'
              const isStaff = m.sender === 'admin'
              return (
                <motion.div
                  key={m.id}
                  initial={{ opacity: 0, y: 8, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ duration: 0.18 }}
                  className={cn('flex items-end gap-1.5', mine ? 'justify-end' : 'justify-start')}
                >
                  {!mine && (
                    <span
                      className={cn(
                        'flex size-6 shrink-0 items-center justify-center rounded-full text-white',
                        isStaff ? 'bg-emerald-600' : 'bg-tg-link',
                      )}
                      aria-hidden
                    >
                      {isStaff ? <UserRound className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
                    </span>
                  )}
                  <div
                    className={cn(
                      'max-w-[82%] rounded-2xl px-3 py-2 text-snippet',
                      mine
                        ? 'rounded-br-md bg-tg-link text-white'
                        : 'rounded-bl-md bg-tg-surface text-tg-text shadow-sm',
                    )}
                  >
                    {isStaff && (
                      <span className="mb-0.5 block text-[11px] font-semibold text-emerald-500">{t('support.staff')}</span>
                    )}
                    {!mine && <RichText text={m.text} className="[&_a]:text-tg-link" />}
                    {mine && <span className="whitespace-pre-wrap break-words">{m.text}</span>}
                    <span
                      className={cn(
                        'mt-0.5 block text-right text-[10.5px]',
                        mine ? 'text-white/60' : 'text-tg-hint',
                      )}
                    >
                      {timeOf(m.createdAt)}
                    </span>
                  </div>
                </motion.div>
              )
            })}
            {waiting && (
              <div className="flex items-end gap-1.5">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-tg-link text-white" aria-hidden>
                  <Bot className="h-3.5 w-3.5" />
                </span>
                <div className="rounded-2xl rounded-bl-md bg-tg-surface px-3 shadow-sm">
                  <TypingDots label={t('support.typing')} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Поле ввода как в Telegram */}
      <footer className="shrink-0 border-t border-tg-sep/60 bg-tg-surface/80 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1.5 backdrop-blur-md">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            rows={1}
            maxLength={2000}
            placeholder={t('support.input')}
            aria-label={t('support.input')}
            className="max-h-28 min-h-[40px] flex-1 resize-none rounded-[20px] bg-tg-bg px-4 py-2.5 text-snippet text-tg-text outline-none placeholder:text-tg-hint focus:ring-1 focus:ring-tg-link/40"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={!draft.trim() || sending}
            aria-label={t('support.send')}
            className="flex size-[42px] shrink-0 items-center justify-center rounded-full bg-tg-link text-white transition disabled:opacity-35 active:scale-90"
          >
            <ArrowUp className="h-5 w-5" />
          </button>
        </div>
      </footer>
    </motion.div>
  )
}
