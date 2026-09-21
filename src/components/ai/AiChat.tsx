'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, Bot, CalendarClock, Check, Copy, Loader2, Rocket, Send, Sparkles, Trash2 } from 'lucide-react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api, getSessionToken } from '@/lib/api'
import { useApp } from '@/lib/store'
import { haptic, useBackButton } from '@/lib/tg'
import { stripMarkdown } from '@/lib/markdown'
import { timeAgo, timeAgoRu, pluralRu } from '@/lib/format'
import type { PostDTO } from '@/lib/types'
import { RichText } from '@/components/feed/RichText'
import { Avatar } from '@/components/tg/Avatar'
import { VerifiedBadge } from '@/components/tg/VerifiedBadge'
import { ChatInput } from '@/components/ai/ChatInput'

/**
 * ОТДЕЛЬНЫЙ ИИ-ЧАТ (v5.21): полноэкранная поверхность для ассистента канала
 * и ИИ-поиска — как чат в Telegram.
 *
 *  • пузыри: свои справа (tg-link), бот слева с КРАСИВЫМ MARKDOWN (RichText);
 *  • статусы «думаю»: мигающие точки + человекочитаемый этап инструмента
 *    («Смотрю тренды ленты…», «Рисую картинку…») — приходят по SSE;
 *  • картинки бота рендерятся под сообщением (инструмент generate_image);
 *  • ИНЛАЙН-КНОПКИ в цветах Telegram: filled-синие primary / серые secondary
 *    («Опубликовать в канал», «Нарисовать картинку»);
 *  • источники поиска — карточки постов (тап — экран канала);
 *  • ввод — ChatInput: слитая капсула, микрофон ⇄ отправка, голосовой ввод;
 *  • история живёт в localStorage отдельно для каждого чата.
 */

export type AiChatKind = 'assistant' | 'search'

type AiMsg = {
  id: string
  role: 'user' | 'assistant'
  text: string
  at: string
  imageUrl?: string
  imagePending?: boolean
  draftText?: string
  draftTopic?: string
  publishedLink?: string
  inviteLink?: string // v5.64: созданная пригласительная ссылка
  scheduledAt?: string // v5.64: время отложенной публикации (ISO)
  sources?: PostDTO[]
  steps?: Array<{ label: string; ok: boolean }>
  failed?: boolean
}

const MAX_HISTORY = 24
const uid = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

function storeKey(kind: AiChatKind, channelId?: string): string {
  return `snap_ai_chat_${kind}${channelId ? `_${channelId}` : ''}`
}

function loadHistory(kind: AiChatKind, channelId?: string): AiMsg[] {
  try {
    const raw = localStorage.getItem(storeKey(kind, channelId))
    if (!raw) return []
    const arr = JSON.parse(raw) as AiMsg[]
    return Array.isArray(arr) ? arr.slice(-MAX_HISTORY) : []
  } catch {
    return []
  }
}

function saveHistory(kind: AiChatKind, channelId: string | undefined, msgs: AiMsg[]): void {
  try {
    localStorage.setItem(storeKey(kind, channelId), JSON.stringify(msgs.slice(-MAX_HISTORY)))
  } catch {
    /* приватный режим — история просто не сохранится */
  }
}

const SUGGESTIONS: Record<AiChatKind, string[]> = {
  assistant: [
    'Оцени мой канал: дай аудит и план роста',
    'Напиши пост на актуальную тему',
    'Когда лучше публиковать посты?',
    'Опубликуй пост завтра в 18:00',
    'Поменяй описание канала',
    'Создай пригласительную ссылку',
  ],
  search: [
    'Что нового в ленте за сутки?',
    'Найди посты про нейросети',
    'О чём сейчас пишут каналы?',
    'Кратко: главные темы недели',
  ],
}

/**
 * v5.40: нормализация ChatGPT-маркдауна под наш RichText.
 * Модели пишут курсив одиночными *звёздочками* и _подчёркиваниями —
 * markdown-lite их не знает. Конвертируем в __парные__ только внутри строки
 * (буллеты «* пункт» и жирный ** не трогаем), одиночный _ — только слово-обёртка.
 */
export function aiNormalize(text: string): string {
  return text
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?![*\w])/g, '$1__$2__')
    .replace(/(^|[\s(>«"'])_([^_\n]+)_(?=[\s).,!?;:»"'<]|$)/g, '$1__$2__')
}

/* ============================ Typing-индикатор ============================ */

function ThinkingBubble({ label }: { label: string | null }) {
  return (
    <div className="flex items-end gap-1.5">
      <div className="flex items-center gap-2 rounded-2xl bg-tg-surface px-3.5 py-2.5 shadow-sm">
        <span className="flex gap-1" aria-hidden>
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="h-1.5 w-1.5 rounded-full bg-tg-hint"
              animate={{ opacity: [0.35, 1, 0.35], y: [0, -2, 0] }}
              transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.18 }}
            />
          ))}
        </span>
        <span className="text-[12.5px] font-medium text-tg-hint">{label ?? 'Думаю…'}</span>
      </div>
    </div>
  )
}

/* ============================ Инлайн-кнопки (цвета Telegram) ============================ */

/** Маленькая стрелка для строк-примеров (строгий маркер) */
function ArrowUpRightIcon() {
  return (
    <svg
      className="h-3.5 w-3.5 shrink-0 text-tg-hint"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </svg>
  )
}

function InlineButtons({
  msg,
  onPublish,
  onAskImage,
  publishing,
}: {
  msg: AiMsg
  onPublish: (m: AiMsg) => void
  onAskImage: (m: AiMsg) => void
  publishing: boolean
}) {
  const buttons: Array<{ label: string; onClick: () => void; kind: 'primary' | 'secondary'; icon: React.ReactNode; disabled?: boolean }> = []
  if (msg.draftText && !msg.publishedLink) {
    buttons.push({
      label: publishing ? 'Публикую…' : 'Опубликовать в канал',
      onClick: () => onPublish(msg),
      kind: 'primary',
      icon: publishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />,
      disabled: publishing,
    })
  }
  if (msg.draftText && !msg.imageUrl) {
    buttons.push({
      label: 'Нарисовать картинку',
      onClick: () => onAskImage(msg),
      kind: 'secondary',
      icon: <Sparkles className="h-4 w-4" />,
    })
  }
  if (msg.publishedLink) {
    return (
      <a
        href={msg.publishedLink}
        target="_blank"
        rel="noreferrer"
        className="press mt-2 inline-flex h-10 items-center gap-1.5 rounded-xl bg-tg-link px-4 text-[13.5px] font-semibold text-white"
      >
        <Rocket className="h-4 w-4" />
        Открыть пост в Telegram
      </a>
    )
  }
  if (buttons.length === 0) return null
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {buttons.map((b) => (
        <button
          key={b.label}
          type="button"
          data-noswipe
          onClick={b.onClick}
          disabled={b.disabled}
          className={cn(
            'flex h-10 items-center gap-1.5 rounded-xl px-3.5 text-[13.5px] font-semibold press',
            b.kind === 'primary'
              ? 'bg-tg-link text-white shadow-sm' // Telegram: filled primary
              : 'bg-tg-surface text-tg-link', // Telegram: secondary tint
            b.disabled && 'opacity-60',
          )}
        >
          {b.icon}
          {b.label}
        </button>
      ))}
    </div>
  )
}

/* ============================ Карточка источника (поиск) ============================ */

function SourceRow({ post, index, onOpen }: { post: PostDTO; index: number; onOpen: () => void }) {
  return (
    <button
      type="button"
      data-noswipe
      onClick={onOpen}
      aria-label={`Открыть канал ${post.channel.title}`}
      className={cn(
        'flex w-full items-start gap-2.5 px-3.5 py-2.5 text-left transition active:bg-tg-surface2/50',
        index > 0 && 'border-t border-tg-sep/60',
      )}
    >
      <Avatar name={post.channel.title} color={post.channel.avatarColor} src={post.channel.avatarUrl} size={34} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate text-[13.5px] font-semibold text-tg-text">{post.channel.title}</span>
            {post.channel.verified && <VerifiedBadge size={12} />}
          </span>
          <span className="shrink-0 text-[11px] text-tg-hint">{timeAgoRu(post.publishedAt)}</span>
        </span>
        <span className="mt-0.5 line-clamp-2 block text-[12.5px] leading-snug text-tg-hint">
          {post.text ? stripMarkdown(post.text) || 'медиа-пост' : 'медиа-пост'}
        </span>
      </span>
    </button>
  )
}

/* ============================ Основной компонент ============================ */

export function AiChat({
  kind,
  open,
  onClose,
  channelId,
  channelTitle,
  seedQuery,
  onSeedConsumed,
}: {
  kind: AiChatKind
  open: boolean
  onClose: () => void
  /** Канал ассистента (только kind=assistant) */
  channelId?: string
  channelTitle?: string
  /** Внешний запрос (из SearchTab) — отправляется автоматически один раз */
  seedQuery?: string | null
  onSeedConsumed?: () => void
}) {
  const openAuthGate = useApp((s) => s.openAuthGate)
  const openChannel = useApp((s) => s.openChannel)
  const user = useApp((s) => s.user)
  const lang = useApp((s) => s.lang)
  useBackButton(open, onClose)

  const [messages, setMessages] = useState<AiMsg[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [streamText, setStreamText] = useState<string | null>(null) // v5.40: realtime-печать
  const [publishing, setPublishing] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const busyRef = useRef(false)
  busyRef.current = busy

  // Загрузка истории при открытии
  useEffect(() => {
    if (!open) return
    setMessages(loadHistory(kind, channelId))
    setLoaded(true)
  }, [open, kind, channelId])

  // Автоскролл вниз при новых сообщениях/статусах
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, status, busy])

  const persist = useCallback(
    (next: AiMsg[]) => {
      setMessages(next)
      saveHistory(kind, channelId, next)
    },
    [kind, channelId],
  )

  /** Отправка сообщения: SSE-поток статусов/ответа */
  const send = useCallback(
    async (text: string) => {
      const clean = text.trim()
      if (!clean || busyRef.current) return
      if (kind === 'assistant' && !channelId) return
      if (!user) {
        openAuthGate('ai')
        return
      }
      haptic('light')
      const userMsg: AiMsg = { id: uid(), role: 'user', text: clean, at: new Date().toISOString() }
      const history = [...messages, userMsg]
      persist(history)
      setBusy(true)
      setStatus(null)
      setStreamText(null)

      // v5.55: копим дельты в локальную переменную — если соединение оборвётся
      // до done/error, частичный ответ сохраняется в историю, а не выбрасывается
      let acc = ''
      let settled = false
      const onEvent = (type: string, data: Record<string, unknown>) => {
        if (type === 'status') {
          setStatus((data.label as string) ?? null)
        } else if (type === 'delta') {
          // v5.40: realtime-стриминг токенов — печатаем ответ по мере генерации
          setStatus(null)
          acc += (data.text as string) ?? ''
          setStreamText((prev) => (prev ?? '') + ((data.text as string) ?? ''))
        } else if (type === 'paid') {
          // v5.39: тарификация по токенам — сервер вернул фактическую списанную сумму
          const sw = Number(data.swipes ?? 0)
          if (sw > 0) {
            toast(`−${sw.toLocaleString('ru-RU')} ${pluralRu(sw, 'свайп', 'свайпа', 'свайпов')} за запрос к ИИ`, { icon: '⚡' })
            // v5.54: баланс в общем сторе синхронизируется мгновенно (кошелёк не устаревает)
            const cur = useApp.getState().balance
            useApp.getState().patchBalance({ swipes: Math.max(0, (cur?.swipes ?? 0) - sw) })
          }
        } else if (type === 'done') {
          settled = true
          const stepsRaw = (data.steps as Array<{ label: string; ok: boolean }> | undefined) ?? []
          const botMsg: AiMsg = {
            id: uid(),
            role: 'assistant',
            text: (data.reply as string) ?? '',
            at: new Date().toISOString(),
            imageUrl: (data.imageUrl as string | undefined) ?? undefined,
            imagePending: Boolean(data.imagePending),
            draftText: (data.draftText as string | undefined) ?? undefined,
            draftTopic: (data.draftTopic as string | undefined) ?? undefined,
            publishedLink: (data.publishedLink as string | undefined) ?? undefined,
            inviteLink: (data.inviteLink as string | undefined) ?? undefined,
            scheduledAt: (data.scheduledAt as string | undefined) ?? undefined,
            sources: (data.sources as PostDTO[] | undefined) ?? undefined,
            steps: stepsRaw.map((s) => ({ label: s.label, ok: s.ok })),
          }
          persist([...history, botMsg])
          setBusy(false)
          setStatus(null)
          setStreamText(null)
          haptic(botMsg.text ? 'success' : 'error')
        } else if (type === 'error') {
          settled = true
          const errMsg: AiMsg = {
            id: uid(),
            role: 'assistant',
            text: (data.message as string) ?? 'Ошибка — попробуйте ещё раз',
            at: new Date().toISOString(),
            failed: true,
          }
          persist([...history, errMsg])
          setBusy(false)
          setStatus(null)
          setStreamText(null)
          haptic('error')
        }
      }

      try {
        const token = getSessionToken()
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (token) headers.Authorization = `Bearer ${token}`
        const res = await fetch(kind === 'assistant' ? '/api/ai/assistant' : '/api/ai/search', {
          method: 'POST',
          headers,
          body: JSON.stringify(
            kind === 'assistant'
              ? {
                  action: 'chat',
                  channelId,
                  messages: history.slice(-MAX_HISTORY).map((m) => ({ role: m.role, content: m.text })),
                }
              : {
                  action: 'chat',
                  messages: history.slice(-MAX_HISTORY).map((m) => ({ role: m.role, content: m.text })),
                },
          ),
          cache: 'no-store',
          signal: AbortSignal.timeout(180_000),
        })
        if (res.status === 401) {
          openAuthGate('ai')
          setBusy(false)
          return
        }
        if (res.status === 402) {
          const j = (await res.json().catch(() => ({}))) as { message?: string }
          toast.error(j.message ?? 'Лимит исчерпан')
          setBusy(false)
          return
        }
        if (!res.ok || !res.body) {
          const j = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
          throw new Error(j.message || j.error || `HTTP ${res.status}`)
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const parts = buf.split('\n\n')
          buf = parts.pop() ?? ''
          for (const part of parts) {
            let type = 'message'
            let payload: Record<string, unknown> = {}
            for (const line of part.split('\n')) {
              if (line.startsWith('event:')) type = line.slice(6).trim()
              else if (line.startsWith('data:')) {
                try {
                  payload = JSON.parse(line.slice(5).trim()) as Record<string, unknown>
                } catch {
                  /* битый json */
                }
              }
            }
            onEvent(type, payload)
          }
        }
        // v5.55: поток кончился без done/error — соединение оборвалось.
        // Раньше частичный ответ молча выбрасывался (обрез чата); теперь
        // сохраняем накопленное с пометкой failed + тост вместо тишины
        if (!settled && acc.trim().length > 0) {
          persist([
            ...history,
            { id: uid(), role: 'assistant', text: acc, at: new Date().toISOString(), failed: true },
          ])
          toast.error('Ответ получен не полностью — соединение оборвалось')
        }
        setBusy(false)
        setStatus(null)
        setStreamText(null)
      } catch (e) {
        setBusy(false)
        setStatus(null)
        setStreamText(null)
        const msg = (e as Error).message || 'Нейросеть не ответила'
        if (/войдите/i.test(msg)) openAuthGate('ai')
        else {
          toast.error(msg)
          persist([
            ...history,
            { id: uid(), role: 'assistant', text: msg, at: new Date().toISOString(), failed: true },
          ])
        }
        haptic('error')
      }
    },
    [messages, persist, kind, channelId, openAuthGate, user],
  )

  // Seed-запрос из SearchTab: автоотправка один раз
  useEffect(() => {
    if (!open || !loaded || !seedQuery) return
    onSeedConsumed?.()
    if (!busyRef.current) void send(seedQuery)
     
  }, [open, loaded, seedQuery])

  /** Публикация черновика (инлайн-кнопка) */
  const doPublish = async (m: AiMsg) => {
    if (!channelId || !m.draftText || publishing) return
    setPublishing(true)
    try {
      const r = await api<{ ok: boolean; link?: string; error?: string }>('/api/ai/assistant', {
        method: 'POST',
        body: JSON.stringify({ action: 'publish', channelId, text: m.draftText, imageUrl: m.imageUrl ?? null }),
      })
      if (r.ok) {
        haptic('success')
        toast.success('Опубликовано в Telegram')
        persist(messages.map((x) => (x.id === m.id ? { ...x, publishedLink: r.link ?? 'ok' } : x)))
      } else {
        toast.error(r.error || 'Не удалось опубликовать')
        haptic('error')
      }
    } catch (e) {
      toast.error((e as Error).message || 'Не удалось опубликовать')
      haptic('error')
    } finally {
      setPublishing(false)
    }
  }

  /** Просьба нарисовать картинку к черновику (инлайн-кнопка) */
  const askImage = (m: AiMsg) => {
    const topic = m.draftTopic || m.draftText?.slice(0, 80) || ''
    void send(`Нарисуй картинку${topic ? ` к посту про ${topic}` : ' к последнему посту'}`)
  }

  const clearChat = () => {
    haptic('light')
    persist([])
  }

  if (typeof document === 'undefined') return null

  const title =
    kind === 'assistant'
      ? lang === 'en'
        ? 'Snap Assistant'
        : 'Snap Ассистент'
      : 'Snap Search'
  const subtitle =
    kind === 'assistant'
      ? `«${channelTitle ?? ''}» · пишет, рисует, публикует`
      : lang === 'en'
        ? 'Answers from feed posts with sources'
        : 'Отвечает по постам ленты'

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key={`ai-chat-${kind}`}
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%' }}
          transition={{ type: 'spring', damping: 32, stiffness: 330 }}
          className="fixed inset-0 z-[75] mx-auto flex w-full max-w-[680px] flex-col overflow-hidden bg-tg-bg lg:bottom-auto lg:top-[4vh] lg:h-[92vh] lg:rounded-3xl lg:border lg:border-tg-sep lg:shadow-[0_24px_90px_rgba(0,0,0,0.35)]"
          role="dialog"
          aria-modal="true"
          aria-label={title}
          data-noswipe
        >
          {/* Шапка */}
          <header className="flex shrink-0 items-center gap-2.5 border-b border-tg-sep/60 bg-tg-bg px-2 py-2">
            <button
              type="button"
              onClick={onClose}
              aria-label="Назад"
              className="flex h-11 w-11 items-center justify-center rounded-full text-tg-text active:bg-tg-surface"
            >
              <ArrowLeft className="h-5.5 w-5.5" />
            </button>
            <span
              className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white shadow-sm',
                kind === 'assistant' ? 'bg-tg-link' : 'border border-tg-sep bg-tg-text',
              )}
              aria-hidden
            >
              <Bot className="h-4.5 w-4.5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[16px] font-bold leading-tight text-tg-text">{title}</span>
              <span className="block truncate text-[12.5px] leading-tight text-tg-hint">{subtitle}</span>
            </span>
            {messages.length > 0 && (
              <button
                type="button"
                onClick={clearChat}
                aria-label="Очистить чат"
                title="Очистить чат"
                className="flex h-10 w-10 items-center justify-center rounded-full text-tg-hint active:bg-tg-surface"
              >
                <Trash2 className="h-4.5 w-4.5" />
              </button>
            )}
          </header>

          {/* Лента сообщений */}
          <div ref={listRef} className="no-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-3 py-3">
            {loaded && messages.length === 0 && !busy && (
              <div className="flex h-full flex-col justify-center gap-5 px-5 py-6">
                {/* Строгий welcome-блок: монохром, чёткие строки, без градиентов */}
                <div className="flex items-start gap-3">
                  <span
                    className={cn(
                      'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-white',
                      kind === 'assistant' ? 'bg-tg-link' : 'border border-tg-sep bg-tg-text',
                    )}
                    aria-hidden
                  >
                    <Bot className="h-5.5 w-5.5" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[16px] font-bold leading-tight text-tg-text">
                      {kind === 'assistant'
                        ? lang === 'en'
                          ? 'Your channel’s AI co-writer'
                          : 'ИИ-контентщик канала'
                        : 'Snap Search'}
                    </p>
                    <p className="mt-1 text-[13px] leading-snug text-tg-hint">
                      {kind === 'assistant'
                        ? 'Знает статистику канала, пишет посты в вашем стиле, рисует обложки и публикует — просто попросите'
                        : 'Отвечает по свежим постам ленты со ссылками на источники — без выдумок'}
                    </p>
                  </div>
                </div>
                <div>
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-tg-hint">
                    {kind === 'assistant' ? 'Быстрый старт' : 'Примеры запросов'}
                  </p>
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {SUGGESTIONS[kind].map((s) => (
                      <button
                        key={s}
                        type="button"
                        data-noswipe
                        onClick={() => void send(s)}
                        className="flex min-h-11 items-center gap-2 rounded-xl border border-tg-sep bg-tg-surface/50 px-3.5 py-2.5 text-left text-[13px] font-medium text-tg-text transition active:scale-[0.98] active:bg-tg-surface2"
                      >
                        <ArrowUpRightIcon />
                        <span className="min-w-0 flex-1">{s}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {messages.map((m) => (
              <motion.div
                key={m.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18 }}
                className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}
              >
                <div className={cn('max-w-[88%] min-w-0', m.role === 'user' && 'max-w-[80%]')}>
                  {/* Этапы инструментов (мелкие чипы над ответом) */}
                  {m.steps && m.steps.length > 0 && m.role === 'assistant' && (
                    <div className="mb-1 flex flex-wrap gap-1">
                      {m.steps.map((s, i) => (
                        <span
                          key={i}
                          className={cn(
                            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium',
                            s.ok ? 'bg-tg-surface text-tg-hint' : 'bg-destructive/10 text-destructive',
                          )}
                        >
                          {s.ok ? <Check className="h-2.5 w-2.5" /> : <AlertCircle className="h-2.5 w-2.5" />}
                          {s.label.replace(/…$/, '')}
                        </span>
                      ))}
                    </div>
                  )}
                  {/* v5.40: у ИИ — чистый текст без пузыря и аватарки (как ChatGPT),
                      пузырь остаётся только у пользователя */}
                  <div
                    className={cn(
                      m.role === 'user'
                        ? 'rounded-2xl rounded-br-md px-3.5 py-2.5 shadow-sm bg-tg-link text-white'
                        : m.failed
                          ? 'rounded-2xl px-3.5 py-2.5 text-destructive'
                          : '',
                    )}
                  >
                    {m.role === 'assistant' ? (
                      <RichText
                        text={aiNormalize(m.text)}
                        className="text-[14.5px] leading-relaxed [&_a]:text-tg-link"
                      />
                    ) : (
                      <span className="whitespace-pre-wrap break-words text-[14.5px] leading-relaxed">{m.text}</span>
                    )}
                  </div>
                  {/* Картинка (generate_image) */}
                  {m.imageUrl && (
                    <button
                      type="button"
                      data-noswipe
                      onClick={() => window.open(m.imageUrl, '_blank')}
                      className="mt-1.5 block w-full overflow-hidden rounded-2xl border border-tg-sep"
                      aria-label="Открыть картинку"
                    >
                      { }
                      <img src={m.imageUrl} alt="Сгенерированная иллюстрация" className="max-h-80 w-full object-cover" loading="lazy" />
                    </button>
                  )}
                  {m.imagePending && (
                    <div className="mt-1 rounded-xl bg-tg-star/[0.08] px-3 py-1.5 text-[11.5px] text-tg-hint">
                      Картинка досоздаётся — откройте через минуту
                    </div>
                  )}
                  {/* v5.64: чипы результата — отложенный пост и пригласительная ссылка */}
                  {m.scheduledAt && (
                    <div className="mt-1.5 flex items-center gap-1.5 rounded-xl bg-tg-surface px-3 py-1.5 text-[11.5px] font-medium text-tg-hint" data-noswipe>
                      <CalendarClock className="h-3.5 w-3.5 shrink-0 text-tg-link" />
                      Публикация отложена: {new Date(m.scheduledAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} (UTC)
                    </div>
                  )}
                  {m.inviteLink && (
                    <button
                      type="button"
                      data-noswipe
                      onClick={() => {
                        void navigator.clipboard.writeText(m.inviteLink!).then(() => toast('Ссылка скопирована'))
                      }}
                      className="mt-1.5 flex w-full items-center gap-1.5 rounded-xl bg-tg-surface px-3 py-2 text-left transition active:bg-tg-surface2"
                      aria-label="Скопировать пригласительную ссылку"
                    >
                      <Copy className="h-3.5 w-3.5 shrink-0 text-tg-link" />
                      <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-tg-text2">{m.inviteLink}</span>
                      <span className="shrink-0 text-[10.5px] font-semibold text-tg-link">Скопировать</span>
                    </button>
                  )}
                  {/* Инлайн-кнопки + публикация */}
                  {m.role === 'assistant' && channelId && (
                    <InlineButtons msg={m} onPublish={(x) => void doPublish(x)} onAskImage={askImage} publishing={publishing} />
                  )}
                  {/* Источники (поиск) */}
                  {m.sources && m.sources.length > 0 && (
                    <div className="mt-1.5 overflow-hidden rounded-2xl border border-tg-sep bg-tg-surface">
                      <div className="border-b border-tg-sep/60 px-3.5 pb-1 pt-2 text-[10.5px] font-bold uppercase tracking-wide text-tg-hint">
                        Источники
                      </div>
                      {m.sources.slice(0, 6).map((p, i) => (
                        <SourceRow
                          key={p.id}
                          post={p}
                          index={i}
                          onOpen={() => {
                            onClose()
                            openChannel(p.channel.username)
                          }}
                        />
                      ))}
                    </div>
                  )}
                  <span className={cn('mt-0.5 block text-[10px]', m.role === 'user' ? 'text-right text-white/55' : 'text-tg-hint/70')}>
                    {timeAgo(m.at, lang)}
                  </span>
                </div>
              </motion.div>
            ))}

            {/* v5.40: realtime-стриминг — ответ печатается на глазах, чистым текстом без пузыря */}
            {streamText !== null && streamText.length > 0 && (
              <div className="flex justify-start">
                <div className="max-w-[88%] min-w-0">
                  <RichText
                    text={aiNormalize(streamText)}
                    className="text-[14.5px] leading-relaxed text-tg-text [&_a]:text-tg-link"
                  />
                </div>
              </div>
            )}

            {busy && streamText === null && <ThinkingBubble label={status} />}
          </div>

          {/* Ввод: слитая капсула + микрофон/отправка */}
          <div className="shrink-0 border-t border-tg-sep/60 bg-tg-surface/60 px-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur-md">
            <ChatInput
              value={draft}
              onChange={setDraft}
              onSend={(t) => {
                setDraft('')
                void send(t)
              }}
              busy={busy}
              disabled={kind === 'assistant' && !channelId}
              maxLength={2000}
              placeholder={kind === 'assistant' ? 'Опишите пост или задайте вопрос…' : 'Спросите про ленту…'}
              sendLabel="Отправить ИИ"
              micLabel="Голосовой ввод"
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
