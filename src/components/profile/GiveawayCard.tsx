'use client'

import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, Copy, Gift, Loader2, RefreshCw, Ticket } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { haptic } from '@/lib/tg'

/**
 * Карточка активного розыгрыша в профиле (v5.46 — билетная система):
 *  • сколько билетов уже собрано (вес в розыгрыше);
 *  • задания с живым прогрессом (активность/рефералы) и чек-марками;
 *  • ввод секретного промокода;
 *  • кнопка проверки буста;
 *  • реферальная ссылка (копирование).
 * Активного розыгрыша нет (или гость) → не рендерится.
 */

type GiveawayTaskDTO = {
  kind: 'activity' | 'promo' | 'referral' | 'boost' | 'forward'
  tickets: number
  title: string
  swipeGoal: number | null
  referralGoal: number | null
  boostChannel: string | null
  done: boolean
}

/** v5.50: профиль источников «В один клик» (приходит всегда, даже без розыгрыша) */
type SourcesDTO = { count: number; goal: number; channels: string[] }

type GiveawayStatus = {
  giveaway: {
    id: string
    title: string
    endAt: string
    prizes: Array<{ label: string; winners: number }>
    tasks: GiveawayTaskDTO[]
  } | null
  entry: { ticketsCount: number; tasksDone: Array<{ task: string; tickets: number; at: string }> } | null
  progress: Record<string, number>
  referralLink: string | null
  sources?: SourcesDTO
  botUsername?: string | null
}

/** Иконки заданий — зеркально с серверной TASK_ICON (giveaway-tickets.ts) */
const TASK_ICON: Record<GiveawayTaskDTO['kind'], string> = {
  activity: '📱',
  promo: '🔑',
  referral: '🤝',
  boost: '🚀',
  forward: '📬',
}

export function GiveawayCard() {
  const user = useApp((s) => s.user)
  const [data, setData] = useState<GiveawayStatus | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [promo, setPromo] = useState('')
  const [reload, setReload] = useState(0)

  const load = useCallback(async () => {
    if (!user || user.isGuest) return
    try {
      const r = await api<GiveawayStatus>('/api/giveaway')
      setData(r)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [user])

  useEffect(() => {
    void load()
  }, [load, reload])

  if (!user || user.isGuest) return null
  if (failed) return null
  if (data === null) return null
  const g = data.giveaway
  if (!g) return null

  const tickets = data.entry?.ticketsCount ?? 0

  const withBusy = async (fn: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  const redeemPromo = () =>
    withBusy(async () => {
      const code = promo.trim()
      if (code.length < 3) {
        toast.error('Введи промокод')
        return
      }
      try {
        const r = await api<{ ok: boolean; message: string }>('/api/giveaway', {
          method: 'POST',
          body: JSON.stringify({ action: 'promo', giveawayId: g.id, code }),
        })
        if (r.ok) {
          haptic('success')
          toast.success(r.message)
          setPromo('')
          setReload((n) => n + 1)
        } else {
          toast.error(r.message)
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Не получилось')
      }
    })

  const checkBoost = () =>
    withBusy(async () => {
      try {
        const r = await api<{ ok: boolean; message: string }>('/api/giveaway', {
          method: 'POST',
          body: JSON.stringify({ action: 'boost', giveawayId: g.id }),
        })
        if (r.ok) {
          haptic('success')
          toast.success(r.message)
          setReload((n) => n + 1)
        } else {
          toast.error(r.message)
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Не получилось')
      }
    })

  const copyReferral = () => {
    if (!data.referralLink) return
    haptic('light')
    void navigator.clipboard
      .writeText(data.referralLink)
      .then(() => toast.success('Ссылка скопирована — отправь друзьям'))
      .catch(() => toast.error('Не удалось скопировать'))
  }

  const hoursLeft = Math.max(0, Math.floor((new Date(g.endAt).getTime() - Date.now()) / 3600_000))
  // Абсолютное время итогов в ЧАСОВОМ ПОЯСЕ устройства (ISO с сервера → Date →
  // toLocaleString) — сдвига на 3 часа нет ни у московского, ни у любого другого юзера
  const endAtLocal = new Date(g.endAt).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <section className="pt-7" aria-label="Розыгрыш">
      <div className="px-4">
        <h2 className="text-[19px] font-bold text-tg-text">Розыгрыш</h2>
      </div>

      <div className="mx-4 mt-3 overflow-hidden rounded-2xl border border-amber-200/70 bg-gradient-to-br from-amber-50 to-orange-50 dark:border-amber-500/20 dark:from-amber-500/10 dark:to-orange-500/5">
        {/* Шапка: название + билеты */}
        <div className="flex items-center gap-3 px-4 pt-3.5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-500/15">
            <Gift className="h-5 w-5 text-amber-600 dark:text-amber-400" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15.5px] font-bold leading-tight text-tg-text">{g.title}</p>
            <p className="text-[12.5px] text-tg-hint">
              итоги через {hoursLeft >= 24 ? `${Math.floor(hoursLeft / 24)} дн. ${hoursLeft % 24} ч` : `${hoursLeft} ч`}
              {' · '}{endAtLocal}
            </p>
          </div>
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-[13px] font-bold text-amber-800 tabular-nums dark:bg-amber-500/15 dark:text-amber-300">
            <Ticket className="h-3.5 w-3.5" aria-hidden />
            {tickets}
          </span>
        </div>

        {/* Пояснение механики: без ≥1 билета юзер пока не участвует в выборе */}
        {tickets === 0 && (
          <p className="mt-2.5 px-4 text-[12px] leading-snug text-amber-700/90 dark:text-amber-300/90">
            Вы в списке заявок, но билетов пока 0 — в розыгрыше участвуют те, кто выполнил хотя бы одно задание. Выполните любое ниже — появится шанс!
          </p>
        )}

        {/* Задания */}
        {g.tasks.length > 0 && (
          <ul className="mt-3 space-y-1.5 px-4">
            {g.tasks.map((t) => {
              const progress =
                t.kind === 'activity' && t.swipeGoal
                  ? data.progress.activity
                  : t.kind === 'referral' && t.referralGoal
                    ? data.progress.referral
                    : t.kind === 'forward' && data.sources
                      ? Math.min(data.sources.count, data.sources.goal)
                      : null
              const goal =
                t.kind === 'forward' && data.sources
                  ? data.sources.goal
                  : (t.swipeGoal ?? t.referralGoal ?? null)
              const pct = progress != null && goal ? Math.min(100, Math.round((progress / goal) * 100)) : null
              const openBot =
                t.kind === 'forward' && !t.done && data.botUsername
                  ? () => {
                      haptic('light')
                      window.open(`https://t.me/${data.botUsername}`, '_blank', 'noopener')
                    }
                  : undefined
              return (
                <li key={t.kind} className="rounded-xl bg-white/70 px-3 py-2 dark:bg-white/5">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold',
                        t.done ? 'bg-emerald-500 text-white' : 'bg-tg-surface text-tg-hint',
                      )}
                      aria-hidden
                    >
                      {t.done ? '✓' : ''}
                    </span>
                    <p className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-tg-text">
                      <span className="mr-1" aria-hidden>{TASK_ICON[t.kind]}</span>
                      {t.title}
                    </p>
                    <span className="shrink-0 text-[12px] font-bold text-amber-700 tabular-nums dark:text-amber-300">
                      +{t.tickets} 🎫
                    </span>
                  </div>
                  {pct !== null && !t.done && (
                    <div className="mt-1.5 flex items-center gap-2 pl-7">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-tg-surface">
                        <div className="h-full rounded-full bg-amber-500 transition-all" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-[11px] font-medium text-tg-hint tabular-nums">
                        {Math.min(progress ?? 0, goal ?? 0)}/{goal}
                      </span>
                    </div>
                  )}
                  {openBot && (
                    <button
                      type="button"
                      onClick={openBot}
                      className="mt-1.5 ml-7 flex h-8 items-center gap-1.5 rounded-lg bg-amber-500/10 px-3 text-[12.5px] font-semibold text-amber-700 transition active:scale-95 dark:bg-amber-500/15 dark:text-amber-300"
                    >
                      📨 Открыть чат с ботом и переслать
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {/* Промокод */}
        {g.tasks.some((t) => t.kind === 'promo') && (
          <div className="mt-3 flex items-center gap-2 px-4">
            <input
              value={promo}
              onChange={(e) => setPromo(e.target.value)}
              placeholder="Секретный промокод"
              aria-label="Секретный промокод"
              maxLength={32}
              className="h-10 min-w-0 flex-1 rounded-xl border border-amber-200 bg-white/80 px-3 text-[14px] font-medium text-tg-text outline-none placeholder:text-tg-hint focus:border-amber-400 dark:border-amber-500/25 dark:bg-white/5"
            />
            <button
              type="button"
              onClick={() => void redeemPromo()}
              disabled={busy}
              className="flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-amber-500 px-4 text-[13.5px] font-bold text-white transition active:scale-95 disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              ОК
            </button>
          </div>
        )}

        {/* Реферальная ссылка */}
        {data.referralLink && (
          <div className="mt-3 px-4">
            <button
              type="button"
              onClick={copyReferral}
              className="flex h-10 w-full items-center gap-2 rounded-xl border border-amber-200 bg-white/70 px-3 text-[13.5px] font-semibold text-tg-text transition active:scale-[0.99] dark:border-amber-500/25 dark:bg-white/5"
            >
              <Copy className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-left">Пригласить друзей за билеты</span>
              <ChevronRight className="h-4 w-4 shrink-0 text-tg-hint" aria-hidden />
            </button>
          </div>
        )}

        {/* Футер: обновить + буст */}
        <div className="flex items-center gap-2 px-4 pb-3.5 pt-3">
          <button
            type="button"
            onClick={() => setReload((n) => n + 1)}
            aria-label="Обновить прогресс"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white/70 text-tg-hint transition active:scale-90 dark:bg-white/5"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} aria-hidden />
          </button>
          {g.tasks.some((t) => t.kind === 'boost') && (
            <button
              type="button"
              onClick={() => void checkBoost()}
              disabled={busy}
              className="flex h-8 items-center gap-1.5 rounded-full bg-white/70 px-3 text-[12.5px] font-semibold text-amber-700 transition active:scale-95 disabled:opacity-60 dark:bg-white/5 dark:text-amber-300"
            >
              🚀 Я бустнул канал — проверить
            </button>
          )}
          <span className="ml-auto text-[11.5px] text-tg-hint">шанс = кол-во билетов</span>
        </div>
      </div>
    </section>
  )
}
