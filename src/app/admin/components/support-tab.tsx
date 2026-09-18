'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  CheckCheck,
  ChevronLeft,
  Headset,
  MessageSquareOff,
  RefreshCw,
  Send,
  UserRound,
  Wrench,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  fetchSupportThread,
  fetchSupportThreads,
  fmtAgo,
  PanelError,
  replySupportThread,
  setSupportThreadStatus,
  supportUserName,
  type SupportMsg,
  type SupportThreadFull,
  type SupportThreadItem,
} from './api'

/**
 * Вкладка «Поддержка» — инбокс обращений пользователей, как в Telegram:
 * слева список чатов, справа открытый диалог. Ответ сотрудника приходит
 * пользователю в тот же чат мини-аппа; нейросеть можно вернуть кнопкой
 * «Вернуть ИИ», а обращение — закрыть.
 */

const SENDER_LABEL: Record<string, string> = {
  user: 'Пользователь',
  ai: 'Нейросеть',
  admin: 'Сотрудник',
}

function timeOf(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function statusBadge(status: string) {
  if (status === 'human')
    return <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">у сотрудника</span>
  if (status === 'closed')
    return <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">закрыт</span>
  return <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">нейросеть</span>
}

export function SupportTab({ tick, onSettled }: { tick: number; onSettled?: () => void }) {
  const [threads, setThreads] = useState<SupportThreadItem[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [thread, setThread] = useState<SupportThreadFull | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const loadList = useCallback(async () => {
    try {
      const items = await fetchSupportThreads()
      setThreads(items)
      setListError(null)
    } catch (e) {
      if (e instanceof PanelError && e.status === 401) return
      setListError(e instanceof Error ? e.message : 'Не удалось загрузить чаты')
    } finally {
      onSettled?.()
    }
  }, [onSettled])

  const loadThread = useCallback(async (id: string, quiet = false) => {
    if (!quiet) setThread(null)
    try {
      const data = await fetchSupportThread(id)
      setThread(data)
    } catch (e) {
      if (e instanceof PanelError && e.status === 401) return
      setThread(null)
    }
  }, [])

  useEffect(() => {
    void loadList()
  }, [loadList, tick])

  // Открытый диалог обновляется каждые 4с (тихо, без мигания) + список раз в 10с
  useEffect(() => {
    if (!selected) return
    void loadThread(selected, true)
    const t = setInterval(() => void loadThread(selected, true), 4_000)
    const l = setInterval(() => void loadList(), 10_000)
    return () => {
      clearInterval(t)
      clearInterval(l)
    }
  }, [selected, loadThread, loadList])

  // Новые сообщения — автоскролл вниз
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight })
  }, [thread?.messages.length, thread?.id])

  const select = useCallback(
    (id: string) => {
      setSelected(id)
      void loadThread(id)
    },
    [loadThread],
  )

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || !selected || sending) return
    setSending(true)
    setDraft('')
    try {
      const msg = await replySupportThread(selected, text)
      setThread((prev) =>
        prev ? { ...prev, messages: [...prev.messages, msg], status: 'human' } : prev,
      )
      void loadList()
    } catch (e) {
      setDraft(text)
      console.error(e)
    } finally {
      setSending(false)
    }
  }, [draft, selected, sending, loadList])

  const changeStatus = useCallback(
    async (status: 'ai' | 'human' | 'closed') => {
      if (!selected) return
      try {
        await setSupportThreadStatus(selected, status)
        void loadThread(selected, true)
        void loadList()
      } catch (e) {
        console.error(e)
      }
    },
    [selected, loadThread, loadList],
  )

  const unseenTotal = useMemo(
    () => (threads ?? []).reduce((acc, t) => acc + t.unreadAdmin, 0),
    [threads],
  )

  return (
    <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
      {/* ------- Список чатов ------- */}
      <div className={cn('rounded-xl border border-slate-200 bg-white', selected && 'hidden lg:block')}>
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
          <Headset className="size-4 text-emerald-600" aria-hidden />
          <h3 className="text-sm font-semibold text-slate-900">Обращения</h3>
          {unseenTotal > 0 && (
            <span className="ml-auto rounded-full bg-emerald-600 px-2 py-0.5 text-[11px] font-semibold text-white">
              {unseenTotal}
            </span>
          )}
        </div>
        <div className="max-h-[560px] overflow-y-auto lg:max-h-[calc(100vh-260px)]">
          {threads === null ? (
            <div className="flex items-center justify-center py-10">
              <div className="size-6 animate-spin rounded-full border-2 border-slate-200 border-t-emerald-600" />
            </div>
          ) : threads.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-slate-400">
              Обращений пока нет. Здесь появятся чаты пользователей из мини-аппа.
            </p>
          ) : (
            threads.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => select(t.id)}
                className={cn(
                  'flex w-full items-start gap-3 border-b border-slate-50 px-4 py-3 text-left transition hover:bg-slate-50',
                  selected === t.id && 'bg-emerald-50/70 hover:bg-emerald-50',
                )}
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500">
                  {t.user.isGuest ? <UserRound className="size-4" /> : <UserRound className="size-4" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-[13.5px] font-semibold text-slate-900">
                      {supportUserName(t.user)}
                    </span>
                    <span className="shrink-0 text-[11px] text-slate-400">{fmtAgo(t.lastMessageAt)}</span>
                  </span>
                  <span className="mt-0.5 flex items-center justify-between gap-2">
                    <span className="line-clamp-1 text-[12.5px] text-slate-500">
                      {t.lastMessage
                        ? `${t.lastMessage.sender === 'user' ? '' : `${SENDER_LABEL[t.lastMessage.sender] ?? t.lastMessage.sender}: `}${t.lastMessage.text}`
                        : '—'}
                    </span>
                    {t.unreadAdmin > 0 && (
                      <span className="shrink-0 rounded-full bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                        {t.unreadAdmin}
                      </span>
                    )}
                  </span>
                  <span className="mt-1 block">{statusBadge(t.status)}</span>
                </span>
              </button>
            ))
          )}
        </div>
        {listError && <p className="px-4 py-2 text-xs text-red-600">{listError}</p>}
      </div>

      {/* ------- Открытый диалог ------- */}
      <div className={cn('flex min-h-[420px] flex-col rounded-xl border border-slate-200 bg-white', !selected && 'hidden lg:flex')}>
        {!selected || !thread ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-slate-400">
            {selected ? (
              <>
                <RefreshCw className="size-6 animate-spin" aria-hidden />
                <p className="text-sm">Загружаем диалог…</p>
              </>
            ) : (
              <>
                <MessageSquareOff className="size-8" aria-hidden />
                <p className="text-sm">Выберите обращение слева</p>
              </>
            )}
          </div>
        ) : (
          <>
            {/* Шапка диалога */}
            <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3">
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="flex size-8 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 lg:hidden"
                aria-label="К списку чатов"
              >
                <ChevronLeft className="size-5" />
              </button>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-slate-900">{supportUserName(thread.user)}</p>
                <p className="truncate text-xs text-slate-400">
                  {thread.user.isGuest ? 'гость' : 'Telegram-аккаунт'}
                  {thread.user.username ? ` · @${thread.user.username}` : ''} · обращение {fmtAgo(thread.createdAt)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void changeStatus('ai')}
                disabled={thread.status === 'ai'}
                title="Вернуть диалог нейросети"
                className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
              >
                <Bot className="size-3.5" aria-hidden /> ИИ
              </button>
              <button
                type="button"
                onClick={() => void changeStatus('closed')}
                disabled={thread.status === 'closed'}
                title="Закрыть обращение"
                className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-red-50 hover:text-red-700 disabled:opacity-40"
              >
                <CheckCheck className="size-3.5" aria-hidden /> Закрыть
              </button>
            </div>

            {/* Сообщения */}
            <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto bg-[#eef1f5] px-4 py-4 lg:max-h-[calc(100vh-340px)]">
              {thread.messages.map((m: SupportMsg) => {
                if (m.sender === 'system') {
                  return (
                    <div key={m.id} className="flex justify-center">
                      <span className="rounded-full bg-white/80 px-3 py-1 text-[11px] font-medium text-slate-500 shadow-sm">
                        {m.text}
                      </span>
                    </div>
                  )
                }
                const mine = m.sender === 'admin'
                return (
                  <div key={m.id} className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
                    <div
                      className={cn(
                        'max-w-[75%] rounded-2xl px-3.5 py-2 text-[13.5px] leading-relaxed shadow-sm',
                        mine
                          ? 'rounded-br-sm bg-emerald-600 text-white'
                          : m.sender === 'user'
                            ? 'rounded-bl-sm bg-white text-slate-900'
                            : 'rounded-bl-sm bg-slate-100 text-slate-700',
                      )}
                    >
                      {!mine && (
                        <span
                          className={cn(
                            'mb-0.5 block text-[11px] font-semibold',
                            m.sender === 'user' ? 'text-sky-600' : 'text-violet-600',
                          )}
                        >
                          {SENDER_LABEL[m.sender] ?? m.sender}
                        </span>
                      )}
                      <span className="whitespace-pre-wrap break-words">{m.text}</span>
                      <span className={cn('mt-0.5 block text-right text-[10px]', mine ? 'text-white/60' : 'text-slate-400')}>
                        {timeOf(m.createdAt)}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Ответ сотрудника */}
            <div className="flex items-end gap-2 border-t border-slate-100 px-3 py-3">
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
                placeholder={thread.status === 'closed' ? 'Обращение закрыто' : 'Ответить пользователю…'}
                disabled={thread.status === 'closed'}
                className="max-h-28 min-h-[42px] flex-1 resize-none rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 disabled:bg-slate-50 disabled:text-slate-400"
              />
              <button
                type="button"
                onClick={() => void send()}
                disabled={!draft.trim() || sending || thread.status === 'closed'}
                aria-label="Отправить ответ"
                className="flex size-[42px] shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white transition hover:bg-emerald-700 disabled:opacity-40"
              >
                {sending ? <Wrench className="size-4 animate-spin" /> : <Send className="size-4" />}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
