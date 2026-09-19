'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  CheckCheck,
  Lightbulb,
  ChevronLeft,
  EyeOff,
  Eye,
  Headset,
  Layers,
  Loader2,
  MessageSquareOff,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
  UserRound,
  Zap,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { ChatInput } from '@/components/ai/ChatInput'
import {
  fetchSupportThread,
  fetchSupportThreads,
  fetchUserInfo,
  fmtAgo,
  PanelError,
  replySupportThread,
  runOps,
  setSupportThreadStatus,
  supportUserName,
  type PanelUserInfo,
  type SupportMsg,
  type SupportThreadFull,
  type SupportThreadItem,
} from './api'
import { EmptyState } from './bits'

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

/** Шаблоны ответов: типовые ситуации поддержки — один клик вместо набора */
const CANNED_REPLIES: string[] = [
  'Спасибо за обращение! Проверяем ситуацию, ответ пришлём в этот чат.',
  'Проблему нашли и уже исправили — проверьте, пожалуйста, ещё раз.',
  'Канал скрыт из вашей ленты — он больше не будет попадаться. Хорошего дня!',
  'Данные канала обновлены: аватар и число подписчиков подтянуты из Telegram.',
  'Передал ваш вопрос профильному специалисту — ответ появится здесь.',
  'Не удалось воспроизвести проблему. Опишите, пожалуйста, шаги и пришлите скриншот.',
]

function timeOf(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function statusBadge(status: string) {
  if (status === 'human')
    return <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">у сотрудника</span>
  if (status === 'closed')
    return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">закрыт</span>
  return <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">нейросеть</span>
}

export function SupportTab({
  tick,
  onSettled,
  kind = 'support',
}: {
  tick: number
  onSettled?: () => void
  /** support — чат поддержки (с нейросетью); feedback — предложка/баг (v5.11) */
  kind?: 'support' | 'feedback'
}) {
  const isFeedback = kind === 'feedback'
  const [threads, setThreads] = useState<SupportThreadItem[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [thread, setThread] = useState<SupportThreadFull | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Карточка пользователя (для жалоб «скройте канал», «кто это» и т.п.)
  const [userInfo, setUserInfo] = useState<PanelUserInfo | null>(null)
  const [userInfoOpen, setUserInfoOpen] = useState(false)
  // Быстрые операции: имя канала / ссылка на пост + результат последней операции
  const [opsTarget, setOpsTarget] = useState('')
  const [opsBusy, setOpsBusy] = useState<string | null>(null)
  const [opsResult, setOpsResult] = useState<{ ok: boolean; text: string } | null>(null)

  const loadList = useCallback(async () => {
    try {
      const items = await fetchSupportThreads(false, kind)
      setThreads(items)
      setListError(null)
    } catch (e) {
      if (e instanceof PanelError && e.status === 401) return
      setListError(e instanceof Error ? e.message : 'Не удалось загрузить чаты')
    } finally {
      onSettled?.()
    }
  }, [onSettled, kind])

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

  // Открытый диалог обновляется каждые 2с (тихо, без мигания) + список раз в 10с
  useEffect(() => {
    if (!selected) return
    void loadThread(selected, true)
    const t = setInterval(() => void loadThread(selected, true), 2_000)
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

  // Карточка пользователя подгружается при открытии диалога
  useEffect(() => {
    setUserInfo(null)
    setUserInfoOpen(false)
    if (!thread?.user.id) return
    let alive = true
    fetchUserInfo(thread.user.id)
      .then((info) => {
        if (alive) setUserInfo(info)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [thread?.user.id])

  /** Выполнить быструю операцию админа («решил за клик») */
  const runOp = useCallback(
    async (payload: Parameters<typeof runOps>[0]) => {
      if (opsBusy) return
      setOpsBusy(payload.action)
      setOpsResult(null)
      try {
        const message = await runOps(payload)
        setOpsResult({ ok: true, text: message })
        void loadList()
      } catch (e) {
        setOpsResult({ ok: false, text: e instanceof Error ? e.message : 'Операция не удалась' })
      } finally {
        setOpsBusy(null)
      }
    },
    [opsBusy, loadList],
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
    <div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
      {/* ------- Список чатов ------- */}
      <div
        className={cn(
          'flex min-w-0 flex-col rounded-xl border border-slate-200 bg-white lg:h-[calc(100vh-176px)]',
          selected && 'hidden lg:flex',
        )}
      >
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
          {isFeedback ? (
            <Lightbulb className="size-4 text-amber-500" aria-hidden />
          ) : (
            <Headset className="size-4 text-emerald-600" aria-hidden />
          )}
          <h3 className="text-sm font-semibold text-slate-900">
            {isFeedback ? 'Предложки и баги' : 'Обращения'}
          </h3>
          {unseenTotal > 0 && (
            <span className="ml-auto rounded-full bg-emerald-600 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-white">
              {unseenTotal}
            </span>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {threads === null ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="size-6 animate-spin text-slate-300" aria-hidden />
            </div>
          ) : threads.length === 0 ? (
            <EmptyState
              icon={isFeedback ? Lightbulb : Headset}
              title="Обращений пока нет"
              hint="Здесь появятся чаты пользователей из мини-аппа"
            />
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
                    <span className="truncate text-sm font-semibold text-slate-900">
                      {supportUserName(t.user)}
                    </span>
                    <span className="shrink-0 text-[11px] text-slate-400">{fmtAgo(t.lastMessageAt)}</span>
                  </span>
                  <span className="mt-0.5 flex items-center justify-between gap-2">
                    <span className="line-clamp-1 text-[13px] text-slate-500">
                      {t.lastMessage
                        ? `${t.lastMessage.sender === 'user' ? '' : `${SENDER_LABEL[t.lastMessage.sender] ?? t.lastMessage.sender}: `}${t.lastMessage.text}`
                        : '—'}
                    </span>
                    {t.unreadAdmin > 0 && (
                      <span className="shrink-0 rounded-full bg-emerald-600 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white">
                        {t.unreadAdmin}
                      </span>
                    )}
                  </span>
                  <span className="mt-1 flex items-center gap-1">
                    {statusBadge(t.status)}
                    {isFeedback && t.topic && (
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-[11px] font-semibold',
                          t.topic === 'bug' ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-700',
                        )}
                      >
                        {t.topic === 'bug' ? 'баг' : 'идея'}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
        {listError && <p className="px-4 py-2 text-xs text-red-600">{listError}</p>}
      </div>

      {/* ------- Открытый диалог ------- */}
      <div
        className={cn(
          'min-h-[420px] min-w-0 flex-col rounded-xl border border-slate-200 bg-white lg:h-[calc(100vh-176px)] lg:min-h-0',
          !selected ? 'hidden lg:flex' : 'flex',
        )}
      >
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
                <button
                  type="button"
                  onClick={() => setUserInfoOpen((v) => !v)}
                  className="block max-w-full text-left"
                  title="Показать карточку пользователя"
                >
                  <p className="truncate text-sm font-semibold text-slate-900 hover:text-emerald-700">{supportUserName(thread.user)}</p>
                  <p className="truncate text-xs text-slate-400">
                    {thread.user.isGuest ? 'гость' : 'Telegram-аккаунт'}
                    {thread.user.username ? ` · @${thread.user.username}` : ''} · обращение {fmtAgo(thread.createdAt)}
                    {userInfo ? ' · клик — карточка' : ''}
                  </p>
                </button>
              </div>
              <button
                type="button"
                onClick={() => void changeStatus('closed')}
                disabled={thread.status === 'closed'}
                title="Закрыть обращение"
                className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-red-50 hover:text-red-700 disabled:opacity-40"
              >
                <CheckCheck className="size-3.5" aria-hidden /> Закрыть
              </button>
              {!isFeedback && (
                <button
                  type="button"
                  onClick={() => void changeStatus('ai')}
                  disabled={thread.status === 'ai'}
                  title="Вернуть диалог нейросети"
                  className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
                >
                  <Bot className="size-3.5" aria-hidden /> ИИ
                </button>
              )}
            </div>

            {/* Карточка пользователя: кто пишет, его активность и подписки */}
            {userInfoOpen && (
              <div className="border-b border-slate-100 bg-emerald-50/50 px-4 py-3">
                {!userInfo ? (
                  <p className="text-xs text-slate-400">Загружаем карточку пользователя…</p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1 text-xs text-slate-600">
                      <p className="font-semibold text-slate-900">
                        {supportUserName(userInfo.user)}
                        {userInfo.user.isPremium && <span className="ml-1 text-amber-500">★ Premium</span>}
                      </p>
                      <p>ID: <span className="font-mono">{userInfo.user.id}</span></p>
                      <p>
                        С нами с {fmtAgo(userInfo.user.createdAt)} · просмотров {userInfo.stats.views} · лайков{' '}
                        {userInfo.stats.likes} · сохранено {userInfo.stats.bookmarks}
                      </p>
                      <p>Обращений в поддержку: {userInfo.threads.length}</p>
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-slate-700">Подписки ({userInfo.stats.subscriptions})</p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {userInfo.subscriptions.length === 0 ? (
                          <span className="text-xs text-slate-400">нет подписок</span>
                        ) : (
                          userInfo.subscriptions.slice(0, 10).map((s) => (
                            <button
                              key={s.username}
                              type="button"
                              title={`@${s.username}${s.status !== 'active' ? ' · канал скрыт' : ''}`}
                              onClick={() => setOpsTarget(`@${s.username}`)}
                              className={cn(
                                'rounded-full border px-2 py-0.5 text-[11px] transition hover:bg-white',
                                s.status !== 'active'
                                  ? 'border-red-200 bg-red-50 text-red-600 line-through'
                                  : 'border-slate-200 bg-white text-slate-600',
                              )}
                            >
                              {s.title}
                            </button>
                          ))
                        )}
                      </div>
                      <p className="mt-1 text-[11px] text-slate-400">Клик по каналу — подставит в быстрые операции</p>
                    </div>
                  </div>
                )}
              </div>
            )}
            {/* Сообщения */}
            <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-[#eef1f5] px-3 py-4 sm:px-4">
              {thread.messages.map((m: SupportMsg) => {
                if (m.sender === 'system') {
                  return (
                    <div key={m.id} className="flex justify-center">
                      <span className="rounded-full bg-white/80 px-3 py-1 text-[11px] font-medium text-slate-500">
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
                        'max-w-[78%] rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed',
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
                      {m.images && m.images.length > 0 && (
                        <div className="mb-1.5 flex flex-wrap gap-1.5">
                          {m.images.map((u) => (
                            <a key={u} href={u} target="_blank" rel="noopener noreferrer">
                              <img
                                src={u}
                                alt="вложение"
                                loading="lazy"
                                className="max-h-40 max-w-[220px] rounded-lg object-cover ring-1 ring-black/10 transition hover:opacity-90"
                              />
                            </a>
                          ))}
                        </div>
                      )}
                      <span className="whitespace-pre-wrap break-words">{m.text}</span>
                      <span
                        className={cn(
                          'mt-0.5 flex items-center justify-end gap-1 text-[11px]',
                          mine ? 'text-white/70' : 'text-slate-400',
                        )}
                      >
                        {timeOf(m.createdAt)}
                        {mine && <CheckCheck className="size-3" aria-hidden />}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Инструменты «решил за клик»: жалоба пользователя → операция админа */}
            <div className="border-t border-slate-100 bg-slate-50/70 px-3 py-2.5">
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-semibold text-slate-500 transition hover:text-slate-700">
                  <Zap className="size-3.5 text-amber-500" aria-hidden />
                  Быстрые операции
                  <span className="ml-auto text-[11px] text-slate-400 group-open:hidden">развернуть</span>
                </summary>
                <div className="mt-2 space-y-2">
                  <div className="flex gap-1.5">
                    <input
                      value={opsTarget}
                      onChange={(e) => setOpsTarget(e.target.value)}
                      placeholder="@канал или t.me/канал/12345"
                      className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs outline-none focus:border-emerald-400"
                    />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(
                      [
                        { act: 'hide_channel', label: 'Скрыть канал', icon: EyeOff, tone: 'text-amber-700 border-amber-200 hover:bg-amber-50' },
                        { act: 'show_channel', label: 'Вернуть', icon: Eye, tone: 'text-emerald-700 border-emerald-200 hover:bg-emerald-50' },
                        { act: 'refresh_card', label: 'Обновить карточку', icon: RefreshCw, tone: 'text-sky-700 border-sky-200 hover:bg-sky-50' },
                        { act: 'reclassify', label: 'Тема (ИИ)', icon: Layers, tone: 'text-violet-700 border-violet-200 hover:bg-violet-50' },
                        { act: 'delete_post', label: 'Удалить пост', icon: Trash2, tone: 'text-red-700 border-red-200 hover:bg-red-50' },
                      ] as const
                    ).map(({ act, label, icon: Icon, tone }) => (
                      <button
                        key={act}
                        type="button"
                        disabled={Boolean(opsBusy) || !opsTarget.trim()}
                        onClick={() => void runOp({ action: act, ...(act === 'delete_post' ? { target: opsTarget } : { username: opsTarget }) } as Parameters<typeof runOps>[0])}
                        className={cn(
                          'flex items-center gap-1 rounded-lg border bg-white px-2 py-1 text-[11px] font-medium transition disabled:opacity-40',
                          tone,
                        )}
                      >
                        <Icon className={cn('size-3', opsBusy === act && 'animate-spin')} aria-hidden />
                        {label}
                      </button>
                    ))}
                  </div>
                  {opsResult && (
                    <p className={cn('text-xs font-medium', opsResult.ok ? 'text-emerald-700' : 'text-red-600')}>
                      {opsResult.text}
                    </p>
                  )}
                </div>
              </details>
            </div>

            {/* Шаблоны ответов: типовые ситуации одним кликом */}
            <div className="flex min-w-0 gap-1.5 overflow-x-auto border-t border-slate-100 px-3 py-2 no-scrollbar">
              {CANNED_REPLIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setDraft(c)}
                  title={c}
                  className="shrink-0 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-slate-600 transition hover:border-emerald-300 hover:text-emerald-700"
                >
                  {c.length > 34 ? `${c.slice(0, 34)}…` : c}
                </button>
              ))}
            </div>

            {/* Ответ сотрудника — v5.21: слитое поле как в Telegram (микрофон ⇄ отправка) */}
            <div className="border-t border-slate-100 px-3 py-3">
              <ChatInput
                value={draft}
                onChange={setDraft}
                onSend={() => void send()}
                busy={sending}
                disabled={thread.status === 'closed'}
                maxLength={2000}
                placeholder={thread.status === 'closed' ? 'Обращение закрыто' : 'Ответить пользователю…'}
                sendLabel="Отправить ответ"
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
