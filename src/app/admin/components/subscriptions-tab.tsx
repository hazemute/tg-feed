'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  AlarmClock,
  CalendarClock,
  Gem,
  Gift,
  Infinity as InfinityIcon,
  RotateCcw,
  ScrollText,
  Search,
  SearchX,
  Sparkles,
  Trash2,
  UserSearch,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

import {
  fetchSubscriptions,
  fmtAgo,
  fmtNum,
  grantSubscription,
  isAuthOrNetworkError,
  PanelError,
  userAction,
  type SubscriberItem,
  type SubscriptionsResponse,
} from './api'
import {
  EmptyState,
  Pagination,
  SkeletonRows,
  TabProps,
  UserKindBadge,
  btnOutlineDark,
  fadeUp,
  inputDark,
  panelCard,
  useDebouncedValue,
} from './bits'

const DAY_MS = 86_400_000

function TierPill({ tier }: { tier: 'plus' | 'pro' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
        tier === 'pro' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700',
      )}
    >
      <Gem className="size-3" aria-hidden /> {tier === 'pro' ? 'Snap Pro' : 'Snap Plus'}
    </span>
  )
}

function daysLeft(until: string | null): number | null {
  if (!until) return null // навсегда
  return Math.ceil((new Date(until).getTime() - Date.now()) / DAY_MS)
}

function UntilLabel({ until }: { until: string | null }) {
  const d = daysLeft(until)
  if (d === null)
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
        <InfinityIcon className="size-3.5" aria-hidden /> навсегда
      </span>
    )
  const soon = d <= 3
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs tabular-nums',
        soon ? 'font-semibold text-red-600' : d <= 30 ? 'text-amber-600' : 'text-slate-600',
      )}
      title={until ? new Date(until).toLocaleString('ru-RU') : undefined}
    >
      {soon && <AlarmClock className="size-3.5" aria-hidden />}
      {new Date(until!).toLocaleDateString('ru-RU')} · {d <= 0 ? 'истекает' : `${d}д`}
    </span>
  )
}

export function SubscriptionsTab({ tick, onSettled }: TabProps) {
  const [q, setQ] = useState('')
  const debouncedQ = useDebouncedValue(q, 400)
  const [view, setView] = useState<'active' | 'expiring'>('active')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<SubscriptionsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [localTick, setLocalTick] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)

  // Быстрая выдача
  const [handle, setHandle] = useState('')
  const [plan, setPlan] = useState<'plus' | 'pro'>('plus')
  const [days, setDays] = useState('30')
  const [forever, setForever] = useState(false)
  const [reason, setReason] = useState('')
  const [grantBusy, setGrantBusy] = useState(false)

  const load = async () => {
    try {
      const d = await fetchSubscriptions({ q: debouncedQ, page, view })
      setData(d)
      setError(null)
      setLoading(false)
    } catch (e) {
      if (isAuthOrNetworkError(e)) return
      const msg = e instanceof PanelError ? e.message : 'Ошибка загрузки'
      if (data) toast.error(msg)
      else setError(msg)
      setLoading(false)
    } finally {
      onSettled()
    }
  }

  useEffect(() => {
    let alive = true
    if (!alive) return
    void load()
    return () => {
      alive = false
    }
     
  }, [debouncedQ, page, view, tick, localTick])

  const patchItem = (
    id: string,
    patch: Omit<Partial<SubscriberItem>, 'tier'> & { tier?: SubscriberItem['tier'] | 'free' },
  ) => {
    if (!data) return
    // при отзыве строка исчезает из «активных»; точные метрики подтянутся при следующем обновлении
    const removing = patch.tier === 'free'
    const { tier, ...rest } = patch
    const items: SubscriberItem[] = removing
      ? data.items.filter((x) => x.id !== id)
      : data.items.map((x) =>
          x.id === id
            ? { ...x, ...rest, ...(tier && tier !== 'free' ? { tier } : {}) }
            : x,
        )
    setData({ ...data, items, total: removing ? Math.max(0, data.total - 1) : data.total })
  }

  /** Продлить/отозвать прямо из списка */
  const rowAction = async (
    u: SubscriberItem,
    payload: Parameters<typeof userAction>[0],
    okText: string,
    patch: Omit<Partial<SubscriberItem>, 'tier'> & { tier?: SubscriberItem['tier'] | 'free' },
  ) => {
    setBusy(u.id)
    try {
      await userAction(payload as Parameters<typeof userAction>[0])
      toast.success(okText)
      patchItem(u.id, patch)
    } catch (e) {
      if (!isAuthOrNetworkError(e)) {
        toast.error(e instanceof PanelError ? e.message : 'Не получилось')
      }
    } finally {
      setBusy(null)
    }
  }

  /** Быстрая выдача по @username/ID */
  const grant = async () => {
    const d = forever ? 36_500 : Math.max(1, Math.min(36_500, Math.round(Number(days) || 0)))
    if (!forever && (Number(days) || 0) < 1) return
    setGrantBusy(true)
    try {
      const res = await grantSubscription({
        ...(handle.startsWith('guest_') || handle.startsWith('tg_') ? { userId: handle } : { handle }),
        tier: plan,
        days: d,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      })
      toast.success(
        `${res.tier === 'pro' ? 'Snap Pro' : 'Snap Plus'} → ${res.userId.slice(0, 18)}… до ${res.tierUntil ? new Date(res.tierUntil).toLocaleDateString('ru-RU') : '∞'}`,
      )
      setHandle('')
      setReason('')
      setLocalTick((t) => t + 1)
    } catch (e) {
      if (!isAuthOrNetworkError(e)) {
        toast.error(e instanceof PanelError ? e.message : 'Не получилось')
      }
    } finally {
      setGrantBusy(false)
    }
  }

  const displayName = (u: SubscriberItem) =>
    [u.firstName, u.lastName].filter(Boolean).join(' ') || (u.username ? `@${u.username}` : u.id)

  return (
    <motion.div variants={fadeUp} initial="hidden" animate="show" className="space-y-4">
      {/* Метрики */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {(
          [
            { label: 'Snap Plus', value: data?.metrics.activePlus ?? 0, cls: 'text-emerald-700', icon: Gem },
            { label: 'Snap Pro', value: data?.metrics.activePro ?? 0, cls: 'text-amber-600', icon: Sparkles },
            { label: 'Истекают ≤3д', value: data?.metrics.expiring3d ?? 0, cls: 'text-red-600', icon: AlarmClock },
            { label: 'Истекают ≤7д', value: data?.metrics.expiring7d ?? 0, cls: 'text-amber-600', icon: CalendarClock },
            { label: 'Выдано', value: data?.metrics.granted ?? 0, cls: 'text-slate-700', icon: Gift },
            { label: 'Продлено', value: data?.metrics.extended ?? 0, cls: 'text-slate-700', icon: RotateCcw },
            { label: 'Отозвано', value: data?.metrics.revoked ?? 0, cls: 'text-slate-500', icon: Trash2 },
          ] as const
        ).map(({ label, value, cls, icon: Icon }) => (
          <div key={label} className="relative py-2 pl-3">
            <div className={cn('text-lg font-semibold tabular-nums', cls)}>{fmtNum(value)}</div>
            <div className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-500">
              <Icon className="size-3" aria-hidden /> {label}
            </div>
          </div>
        ))}
      </div>

      {/* Быстрая выдача по @username / ID */}
      <Card className={panelCard}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base text-slate-900">
            <UserSearch className="size-4 text-emerald-600" aria-hidden /> Быстрая выдача подписки
          </CardTitle>
          <CardDescription className="text-xs text-slate-500">
            Укажите @username или ID пользователя (tg_… / guest_…) — подписка активируется сразу
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="@username или ID"
              disabled={grantBusy}
              className={cn('h-9 w-full text-sm sm:w-64', inputDark)}
              aria-label="Пользователь для выдачи подписки"
            />
            <div className="flex gap-1.5" role="radiogroup" aria-label="Тариф">
              {(['plus', 'pro'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={plan === p}
                  disabled={grantBusy}
                  onClick={() => setPlan(p)}
                  className={cn(
                    'rounded-lg border px-3 py-1.5 text-xs font-semibold transition',
                    plan === p
                      ? p === 'pro'
                        ? 'border-amber-300 bg-amber-50 text-amber-700'
                        : 'border-emerald-300 bg-emerald-50 text-emerald-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                  )}
                >
                  {p === 'pro' ? 'Snap Pro' : 'Snap Plus'}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {[1, 7, 30, 90, 180, 365].map((d) => (
              <button
                key={d}
                type="button"
                disabled={grantBusy || forever}
                onClick={() => {
                  setDays(String(d))
                  setForever(false)
                }}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-xs font-medium transition',
                  !forever && Number(days) === d
                    ? 'border-emerald-300 bg-emerald-100 text-emerald-800'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                  forever && 'opacity-40',
                )}
              >
                {d === 1 ? 'сутки' : `${d}д`}
              </button>
            ))}
            <Input
              type="number"
              min={1}
              max={36500}
              value={forever ? '' : days}
              disabled={grantBusy || forever}
              onChange={(e) => setDays(e.target.value)}
              className={cn('h-7 w-20 text-xs', inputDark)}
              aria-label="Срок в днях"
            />
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={forever}
                disabled={grantBusy}
                onChange={(e) => setForever(e.target.checked)}
                className="size-3.5 accent-emerald-600"
              />
              навсегда
            </label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Заметка (необязательно)"
              maxLength={200}
              disabled={grantBusy}
              className={cn('h-8 w-full text-xs sm:w-52', inputDark)}
              aria-label="Заметка"
            />
            <Button
              size="sm"
              disabled={grantBusy || !handle.trim() || (!forever && (Number(days) || 0) < 1)}
              onClick={() => void grant()}
              className="h-8 bg-emerald-600 px-4 text-white hover:bg-emerald-700"
            >
              <Gift className="size-4" aria-hidden /> Выдать
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Список подписчиков */}
      <Card className={panelCard}>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base text-slate-900">Подписчики Snap</CardTitle>
              <CardDescription className="text-xs text-slate-500">
                Действующие подписки · продление того же тарифа суммируется со сроком
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex gap-1.5" role="group" aria-label="Режим списка">
                {(
                  [
                    ['active', 'Активные'],
                    ['expiring', 'Истекающие ≤7д'],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setView(key)
                      setPage(1)
                    }}
                    aria-pressed={view === key}
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                      view === key
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-slate-500"
                  aria-hidden
                />
                <Input
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value)
                    setPage(1)
                  }}
                  placeholder="ID или @username"
                  aria-label="Поиск подписчиков"
                  className={cn('h-8 w-56 pl-8 text-sm', inputDark)}
                />
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading && !data ? (
            <SkeletonRows rows={6} />
          ) : error && !data ? (
            <EmptyState icon={SearchX} title="Не удалось загрузить подписки" hint={error} />
          ) : data && data.items.length === 0 ? (
            <EmptyState
              icon={SearchX}
              title={view === 'expiring' ? 'Скоро истекающих нет' : 'Подписчиков пока нет'}
              hint={view === 'active' ? 'Выдайте первую подписку формой выше' : undefined}
            />
          ) : data ? (
            <>
              <div className="space-y-2">
                {data.items.map((u) => (
                  <div
                    key={u.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 px-1 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-slate-900">{displayName(u)}</span>
                        <TierPill tier={u.tier} />
                        <UserKindBadge isGuest={u.isGuest} />
                      </div>
                      <span className="block truncate font-mono text-[11px] text-slate-400">{u.id}</span>
                    </div>
                    <div className="text-right">
                      <div className="text-[11px] text-slate-400">до</div>
                      <UntilLabel until={u.tierUntil} />
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy === u.id || u.tierUntil === null}
                        title={u.tierUntil === null ? 'Бессрочная подписка не продлевается' : 'Продлить на 30 дней'}
                        onClick={() =>
                          void rowAction(
                            u,
                            { action: 'tier', userId: u.id, tier: u.tier, days: 30, mode: 'grant' },
                            'Продлено на 30 дней',
                            { tierUntil: new Date((u.tierUntil ? new Date(u.tierUntil).getTime() : Date.now()) + 30 * DAY_MS).toISOString() },
                          )
                        }
                        className={cn('h-7 gap-1 px-2 text-xs', btnOutlineDark)}
                      >
                        <RotateCcw className="size-3.5" aria-hidden /> +30д
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy === u.id}
                        onClick={() =>
                          void rowAction(
                            u,
                            { action: 'tier', userId: u.id, mode: 'revoke' },
                            'Подписка отозвана',
                            { tier: 'free' },
                          )
                        }
                        className={cn('h-7 gap-1 px-2 text-xs hover:bg-red-50 hover:text-red-700', btnOutlineDark)}
                      >
                        <Trash2 className="size-3.5" aria-hidden /> Отозвать
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-4">
                <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onChange={setPage} />
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      {/* Последние тарифные платежи */}
      {data && data.recentPayments.length > 0 && (
        <Card className={panelCard}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-slate-900">
              <ScrollText className="size-4 text-slate-500" aria-hidden /> Последние оплаченные тарифы
            </CardTitle>
            <CardDescription className="text-xs text-slate-500">
              Успешные платежи ЮKassa / Stars / TON по подпискам
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-1.5">
              {data.recentPayments.map((p) => (
                <div
                  key={`${p.userId}-${p.createdAt}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2 text-xs"
                >
                  <span className="font-medium text-slate-800">
                    {[p.firstName, p.lastName].filter(Boolean).join(' ') ||
                      (p.username ? `@${p.username}` : p.userId.slice(0, 16))}
                  </span>
                  <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                    {p.purpose}
                  </span>
                  <span className="font-semibold tabular-nums text-emerald-700">
                    {(p.amountKop / 100).toLocaleString('ru-RU', { style: 'currency', currency: 'RUB' })}
                  </span>
                  <span className="ml-auto text-slate-400">{fmtAgo(p.createdAt)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </motion.div>
  )
}
