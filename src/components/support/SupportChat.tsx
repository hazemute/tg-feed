'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowLeft, ArrowUp, Headset, ShieldCheck, Bot, UserRound, Lightbulb, Bug, Paperclip, X, Trash2, Check } from 'lucide-react'

import { api } from '@/lib/api'
import { haptic } from '@/lib/tg'
import { useT } from '@/lib/i18n'
import { uploadImage } from '@/lib/upload'
import { RichText } from '@/components/feed/RichText'
import { cn } from '@/lib/utils'

/**
 * Чат поддержки / ПРЕДЛОЖКА (v5.11) — стиль нативного Telegram.
 *
 * kind='support': слева — ответы (нейросеть или сотрудник), справа —
 * пользователь. Нейросеть эскалирует сложное сотруднику (админ-панель).
 *
 * kind='feedback' (приказ владельца «Предложка/баг»): сообщения БЕЗ нейронки
 * сразу уходят админу в админ-панель (вкладка «Предложки»); выбор темы
 * «Идея / Баг»; ответ админа приходит в этот же чат + колокольчиком.
 *
 * В обоих чатах можно прикрепить до 3 картинок: клиент сжимает их
 * (canvas → WebP ≤350КБ) и грузит на /api/upload.
 */

type Msg = { id: string; sender: string; text: string; images: string[]; createdAt: string }
type ThreadState = { status: 'ai' | 'human' | 'closed' | null; topic?: string | null; messages: Msg[] }

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

export function SupportChat({
  open,
  onClose,
  kind = 'support',
}: {
  open: boolean
  onClose: () => void
  /** support — чат с ассистентом; feedback — предложка/баг напрямую админу */
  kind?: 'support' | 'feedback'
}) {
  const t = useT()
  const isFeedback = kind === 'feedback'
  const [state, setState] = useState<ThreadState>({ status: null, topic: null, messages: [] })
  const [loaded, setLoaded] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [topic, setTopic] = useState<'idea' | 'bug' | null>(null)
  const [pending, setPending] = useState<string[]>([]) // url загруженных картинок перед отправкой
  const [uploading, setUploading] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false) // подтверждение «Очистить историю»
  const fileRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const endpoint = isFeedback ? '/api/feedback' : '/api/support'

  /** «Очистить историю»: удаляет свои нити этого чата и возвращает приветствие */
  const clearChat = useCallback(async () => {
    try {
      await api<{ ok: boolean }>(endpoint, { method: 'DELETE' })
      setState({ status: null, topic: null, messages: [] })
      if (isFeedback) setTopic(null)
      haptic('success')
    } catch {
      haptic('error')
    }
  }, [endpoint, isFeedback])

  const scrollBottom = useCallback((smooth = true) => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  const load = useCallback(async () => {
    try {
      const data = await api<ThreadState>(endpoint)
      setState(data)
      if (isFeedback && data.topic) setTopic(data.topic as 'idea' | 'bug')
    } catch {
      // сеть/сессия — молча, чат покажет пустое состояние
    } finally {
      setLoaded(true)
    }
  }, [endpoint, isFeedback])

  // Открытие: загрузка + подписка на ответы сотрудника (быстрый поллинг 1.5с —
  // ответы почти мгновенные; запрос лёгкий: один тред по индексу)
  useEffect(() => {
    if (!open) return
    setLoaded(false)
    setConfirmClear(false)
    void load()
    const timer = setInterval(() => {
      if (!sending) void load()
    }, 1_500)
    return () => clearInterval(timer)
  }, [open])

  // Новые сообщения — вниз
  useEffect(() => {
    if (open) scrollBottom(false)
  }, [state.messages.length, open, scrollBottom])

  const onPick = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return
      const free = 3 - pending.length
      if (free <= 0) return
      setUploading(true)
      for (const f of Array.from(files).slice(0, free)) {
        try {
          const url = await uploadImage(f)
          setPending((p) => (p.length < 3 ? [...p, url] : p))
          haptic('light')
        } catch {
          // превышен лимит/не картинка — тихо пропускаем
        }
      }
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    },
    [pending.length],
  )

  const send = useCallback(async () => {
    const text = draft.trim()
    if ((!text && pending.length === 0) || sending) return
    setSending(true)
    setDraft('')
    haptic('light')
    // Оптимистичное сообщение: пользователь видит свой текст мгновенно
    const optimistic: Msg = {
      id: `tmp-${Date.now()}`,
      sender: 'user',
      text: text || '📷',
      images: [...pending],
      createdAt: new Date().toISOString(),
    }
    setState((s) => ({ ...s, messages: [...s.messages, optimistic] }))
    setPending([])
    try {
      const res = await api<{ ok: boolean; status?: ThreadState['status']; messages: Msg[] }>(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          text: text || '📷',
          ...(isFeedback && topic ? { topic } : {}),
          ...(optimistic.images.length > 0 ? { images: optimistic.images } : {}),
        }),
      })
      setState((s) => ({
        status: (res.status ?? s.status) as ThreadState['status'],
        // Оптимистичный пузырь заменяется настоящим (с id и серверным временем)
        messages: [...s.messages.filter((m) => m.id !== optimistic.id), ...res.messages],
      }))
      haptic('success')
    } catch {
      // Ошибка — возвращаем черновик, чтобы сообщение не потерялось
      setState((s) => ({ ...s, messages: s.messages.filter((m) => m.id !== optimistic.id) }))
      setDraft(text)
      setPending(optimistic.images)
      haptic('error')
    } finally {
      setSending(false)
    }
  }, [draft, sending, pending, endpoint, isFeedback, topic])

  if (!open) return null

  const waiting = sending && !isFeedback && state.status !== 'human'

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 380, damping: 34 }}
      className="fixed inset-0 z-[60] mx-auto flex w-full flex-col overflow-hidden bg-tg-bg lg:bottom-auto lg:top-[6vh] lg:h-[88vh] lg:max-w-[680px] lg:rounded-3xl lg:border lg:border-tg-sep lg:shadow-[0_24px_90px_rgba(0,0,0,0.30)]"
      role="dialog"
      aria-label={isFeedback ? t('feedback.dialog') : t('support.dialog')}
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
        <span
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white',
            isFeedback ? 'bg-gradient-to-tr from-tg-star to-tg-link' : 'bg-tg-link',
          )}
        >
          {isFeedback ? <Lightbulb className="h-[18px] w-[18px]" aria-hidden /> : <Headset className="h-[18px] w-[18px]" aria-hidden />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[16px] font-semibold text-tg-text">
            {isFeedback ? t('feedback.title') : t('support.title')}
          </span>
          <span className="block truncate text-[12.5px] text-tg-hint">
            {isFeedback
              ? state.status
                ? t('feedback.subtitle')
                : t('feedback.subtitleIdle')
              : state.status
                ? t(STATUS_KEY[state.status])
                : t('support.subtitle.idle')}
          </span>
        </span>
        {/* Очистка истории: тестовый мусор убирается одним тапом, без админа */}
        {loaded && state.messages.length > 0 && (
          <div className="ml-auto flex shrink-0 items-center" data-noswipe>
            {confirmClear ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmClear(false)
                    void clearChat()
                  }}
                  aria-label={t('support.clearYes')}
                  title={t('support.clearYes')}
                  className="flex h-9 w-9 items-center justify-center rounded-full text-red-500 active:bg-tg-sep/40"
                >
                  <Check className="h-[18px] w-[18px]" />
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmClear(false)}
                  aria-label={t('support.clearNo')}
                  title={t('support.clearNo')}
                  className="flex h-9 w-9 items-center justify-center rounded-full text-tg-hint active:bg-tg-sep/40"
                >
                  <X className="h-[18px] w-[18px]" />
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  haptic('light')
                  setConfirmClear(true)
                  window.setTimeout(() => setConfirmClear(false), 3500)
                }}
                aria-label={t('support.clear')}
                title={t('support.clear')}
                className="flex h-9 w-9 items-center justify-center rounded-full text-tg-hint active:bg-tg-sep/40"
              >
                <Trash2 className="h-[18px] w-[18px]" />
              </button>
            )}
          </div>
        )}
      </header>

      {/* Тема предложки: идея или баг (до первого сообщения) */}
      {isFeedback && !topic && state.messages.length === 0 && (
        <div className="flex shrink-0 gap-2 px-3 pt-3">
          {(
            [
              { key: 'idea', icon: Lightbulb, label: t('feedback.topicIdea') },
              { key: 'bug', icon: Bug, label: t('feedback.topicBug') },
            ] as const
          ).map(({ key, icon: Icon, label }) => (
            <button
              key={key}
              type="button"
              data-noswipe
              onClick={() => {
                haptic('light')
                setTopic(key)
              }}
              className={cn(
                'flex h-11 flex-1 items-center justify-center gap-2 rounded-xl text-[14px] font-semibold transition active:scale-[0.98]',
                'bg-tg-surface text-tg-text2 ring-1 ring-tg-sep/60',
              )}
            >
              <Icon className={cn('h-4.5 w-4.5', key === 'idea' ? 'text-amber-500' : 'text-red-500')} aria-hidden />
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Лента сообщений */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain px-3 py-3">
        {!loaded ? (
          <div className="flex h-full items-center justify-center">
            <div className="size-7 animate-spin rounded-full border-2 border-tg-sep border-t-tg-link" aria-label={t('support.loading')} />
          </div>
        ) : state.messages.length === 0 ? (
          <div className="mx-auto mt-10 max-w-[280px] text-center">
            <span
              className={cn(
                'mx-auto flex size-14 items-center justify-center rounded-full',
                isFeedback ? 'bg-tg-star/10 text-tg-star' : 'bg-tg-link/10 text-tg-link',
              )}
            >
              {isFeedback ? <Lightbulb className="h-7 w-7" aria-hidden /> : <Headset className="h-7 w-7" aria-hidden />}
            </span>
            <p className="mt-3 text-[15px] font-semibold text-tg-text">
              {isFeedback ? t('feedback.welcomeTitle') : t('support.welcomeTitle')}
            </p>
            <p className="mt-1 text-[13.5px] leading-relaxed text-tg-hint">
              {isFeedback ? t('feedback.welcomeText') : t('support.welcomeText')}
            </p>
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
                    {m.images.length > 0 && (
                      <div className={cn('mb-1 flex flex-wrap gap-1.5', !m.text && 'mb-0')}>
                        {m.images.map((u) => (
                          <img
                            key={u}
                            src={u}
                            alt={t('feedback.imageAlt')}
                            loading="lazy"
                            className="max-h-44 max-w-[180px] rounded-xl object-cover ring-1 ring-black/10"
                          />
                        ))}
                      </div>
                    )}
                    {m.text !== '📷' && !mine && <RichText text={m.text} className="[&_a]:text-tg-link" />}
                    {m.text !== '📷' && mine && <span className="whitespace-pre-wrap break-words">{m.text}</span>}
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

      {/* Превью прикреплённых картинок */}
      {pending.length > 0 && (
        <div className="flex shrink-0 gap-2 px-3 pb-1">
          {pending.map((u) => (
            <span key={u} className="relative">
              <img src={u} alt="" className="h-14 w-14 rounded-lg object-cover ring-1 ring-tg-sep" />
              <button
                type="button"
                data-noswipe
                onClick={() => setPending((p) => p.filter((x) => x !== u))}
                aria-label={t('feedback.removeImage')}
                className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-tg-text text-tg-bg shadow"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {uploading && (
            <span className="flex h-14 w-14 items-center justify-center rounded-lg bg-tg-surface" aria-label={t('feedback.uploading')}>
              <span className="size-4 animate-spin rounded-full border-2 border-tg-sep border-t-tg-link" />
            </span>
          )}
        </div>
      )}

      {/* Поле ввода как в Telegram */}
      <footer className="shrink-0 border-t border-tg-sep/60 bg-tg-surface/80 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1.5 backdrop-blur-md">
        <div className="flex items-end gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => void onPick(e.target.files)}
            aria-hidden
            tabIndex={-1}
          />
          <button
            type="button"
            data-noswipe
            onClick={() => fileRef.current?.click()}
            disabled={pending.length >= 3 || uploading}
            aria-label={t('feedback.attach')}
            title={t('feedback.attach')}
            className="flex size-[42px] shrink-0 items-center justify-center rounded-full bg-tg-bg text-tg-hint transition active:scale-90 disabled:opacity-35"
          >
            <Paperclip className="h-5 w-5" />
          </button>
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
            placeholder={isFeedback ? t('feedback.input') : t('support.input')}
            aria-label={isFeedback ? t('feedback.input') : t('support.input')}
            className="max-h-28 min-h-[40px] flex-1 resize-none rounded-[20px] bg-tg-bg px-4 py-2.5 text-snippet text-tg-text outline-none placeholder:text-tg-hint focus:ring-1 focus:ring-tg-link/40"
          />
          <button
            type="button"
            data-noswipe
            onClick={() => void send()}
            disabled={(!draft.trim() && pending.length === 0) || sending}
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
