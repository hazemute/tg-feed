'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  AlertTriangle,
  Ban,
  CalendarClock,
  Gem,
  Gift,
  Infinity as InfinityIcon,
  RefreshCw,
  Search,
  SearchX,
  Settings2,
  ShieldOff,
  Trash2,
  Wallet,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

import {
  fmtAgo,
  fmtNum,
  isAuthOrNetworkError,
  panelFetch,
  PanelError,
  userAction,
  type PanelUser,
  type UsersFilter,
  type UsersResponse,
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

const PAGE_SIZE = 20

/** Фильтры v5.18: тип аккаунта / бан / подписка */
const FILTERS: Array<{ key: UsersFilter; label: string }> = [
  { key: 'all', label: 'Все' },
  { key: 'tg', label: 'Telegram' },
  { key: 'guests', label: 'Гости' },
  { key: 'plus', label: 'Plus' },
  { key: 'pro', label: 'Pro' },
  { key: 'expiring', label: 'Истекают ≤7д' },
  { key: 'banned', label: 'Бан' },
]

const FILTER_ALL = 'all'

/** Бейдж подписки: Plus (изумруд) / Pro (золото) + срок, красным если истекает ≤3д */
export function TierBadge({ tier, until }: { tier: PanelUser['tier']; until?: string | null }) {
  if (tier !== 'plus' && tier !== 'pro') return null
  const daysLeft = until ? Math.ceil((new Date(until).getTime() - Date.now()) / 86_400_000) : null
  const soon = daysLeft !== null && daysLeft <= 3
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
        tier === 'pro'
          ? 'bg-amber-100 text-amber-700'
          : 'bg-emerald-100 text-emerald-700',
        soon && 'bg-red-100 text-red-700',
      )}
      title={until ? `Подписка до ${new Date(until).toLocaleDateString('ru-RU')}` : undefined}
    >
      <Gem className="size-3" aria-hidden />
      {tier === 'pro' ? 'Pro' : 'Plus'}
      {daysLeft !== null && (soon || daysLeft < 30) && (
        <span className="font-normal opacity-80">
          · {daysLeft <= 0 ? 'истекает' : `${daysLeft}д`}
        </span>
      )}
      {daysLeft === null && <InfinityIcon className="size-3 opacity-70" aria-hidden />}
    </span>
  )
}

export function UsersTab({ tick, onSettled }: TabProps) {
  const [q, setQ] = useState('')
  const debouncedQ = useDebouncedValue(q, 400)
  const [filter, setFilter] = useState<UsersFilter>(FILTER_ALL)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<UsersResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [localTick, setLocalTick] = useState(0)
  const [bypassBusy, setBypassBusy] = useState<string | null>(null)
  // v5.11: модалка действий над пользователем (бан/баланс/премиум)
  const [actionUser, setActionUser] = useState<PanelUser | null>(null)
  const [banReason, setBanReason] = useState('')
  const [swipesInput, setSwipesInput] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  // v5.18: выдача подписки в модалке
  const [tierPlan, setTierPlan] = useState<'plus' | 'pro'>('plus')
  const [tierDays, setTierDays] = useState('30')
  const [tierForever, setTierForever] = useState(false)
  const [tierReason, setTierReason] = useState('')

  // Модалка закрывается по Esc (как AlertDialog) — кроме момента выполнения действия
  useEffect(() => {
    if (!actionUser) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !actionBusy) setActionUser(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actionUser, actionBusy])

  useEffect(() => {
    let alive = true
    const run = async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
      if (debouncedQ.trim()) params.set('q', debouncedQ.trim())
      if (filter !== FILTER_ALL) params.set('filter', filter)
      try {
        const d = await panelFetch<UsersResponse>(`/api/panel/users?${params.toString()}`)
        if (!alive) return
        setData(d)
        setError(null)
        setLoading(false)
      } catch (e) {
        if (!alive || isAuthOrNetworkError(e)) return
        const msg = e instanceof PanelError ? e.message : 'Ошибка загрузки'
        if (data) toast.error(msg)
        else setError(msg)
        setLoading(false)
      } finally {
        if (alive) onSettled()
      }
    }
    void run()
    return () => {
      alive = false
    }
     
  }, [debouncedQ, page, filter, tick, localTick])

  /** Переключить допуск пользователя мимо техработ (PATCH + оптимистичный апдейт) */
  const toggleBypass = async (u: PanelUser, next: boolean) => {
    setBypassBusy(u.id)
    const prev = data
    if (data) {
      setData({
        ...data,
        items: data.items.map((x) => (x.id === u.id ? { ...x, bypassMaintenance: next } : x)),
      })
    }
    try {
      await panelFetch('/api/panel/users', {
        method: 'PATCH',
        json: { userId: u.id, bypassMaintenance: next },
      })
      toast.success(next ? 'Допуск выдан' : 'Допуск отозван')
    } catch (e) {
      if (prev) setData(prev) // откат
      if (!isAuthOrNetworkError(e)) {
        const msg = e instanceof PanelError ? e.message : 'Не получилось'
        toast.error(msg)
      }
    } finally {
      setBypassBusy(null)
    }
  }

  const displayName = (u: PanelUser) =>
    [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || u.id

  /** Действие v5.11/v5.18 с оптимистичным апдейтом */
  const runUserAction = async (
    u: PanelUser,
    payload: Parameters<typeof userAction>[0],
    okText: string,
    patch: Partial<PanelUser>,
  ) => {
    setActionBusy(true)
    const prev = data
    if (data) {
      setData({ ...data, items: data.items.map((x) => (x.id === u.id ? { ...x, ...patch } : x)) })
    }
    try {
      await userAction(payload)
      toast.success(okText)
      setActionUser(null)
      setBanReason('')
      setTierReason('')
    } catch (e) {
      if (prev) setData(prev)
      if (!isAuthOrNetworkError(e)) {
        toast.error(e instanceof PanelError ? e.message : 'Не получилось')
      }
    } finally {
      setActionBusy(false)
    }
  }

  const openAction = (u: PanelUser) => {
    setBanReason(u.banReason ?? '')
    setSwipesInput(u.swipes != null ? String(u.swipes) : '')
    // Подписка: план/срок прематчиваем по текущему состоянию
    setTierPlan(u.tier === 'pro' ? 'pro' : 'plus')
    setTierDays('30')
    setTierForever(false)
    setTierReason('')
    setActionUser(u)
  }

  const grantDays = tierForever ? 36_500 : Math.max(1, Math.min(36_500, Math.round(Number(tierDays) || 0)))

  return (
    <motion.div variants={fadeUp} initial="hidden" animate="show">
      <Card className={panelCard}>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base text-slate-900">Пользователи</CardTitle>
              <CardDescription className="text-xs text-slate-500">
                Подписки, баны, балансы · «Действия» — выдача Plus/Pro на любой срок
              </CardDescription>
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
                aria-label="Поиск пользователей"
                className={cn('h-8 w-64 pl-8 text-sm', inputDark)}
              />
            </div>
          </div>
          {/* Фильтры */}
          <div className="flex flex-wrap gap-1.5 pt-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => {
                  setFilter(f.key)
                  setPage(1)
                }}
                aria-pressed={filter === f.key}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                  filter === f.key
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {loading && !data ? (
            <SkeletonRows rows={8} />
          ) : error && !data ? (
            <EmptyState
              icon={AlertTriangle}
              title="Не удалось загрузить пользователей"
              hint={error}
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setLocalTick((t) => t + 1)}
                  className={btnOutlineDark}
                >
                  <RefreshCw aria-hidden /> Повторить
                </Button>
              }
            />
          ) : data && data.items.length === 0 ? (
            <EmptyState
              icon={SearchX}
              title="Пользователи не найдены"
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setQ('')
                    setFilter(FILTER_ALL)
                    setPage(1)
                  }}
                  className={btnOutlineDark}
                >
                  Сбросить фильтры
                </Button>
              }
            />
          ) : data ? (
            <>
              {/* Десктоп: таблица */}
              <div className="hidden md:block">
                <div className="admin-scroll max-h-[560px] overflow-auto rounded-md border border-slate-200">
                  <Table className="min-w-[980px]">
                    <TableHeader>
                      <TableRow className="border-slate-200 hover:bg-transparent">
                        <TableHead className="text-xs text-slate-500">ID</TableHead>
                        <TableHead className="text-xs text-slate-500">Имя</TableHead>
                        <TableHead className="text-xs text-slate-500">Username</TableHead>
                        <TableHead className="text-xs text-slate-500">Тип</TableHead>
                        <TableHead className="text-xs text-slate-500">Подписка</TableHead>
                        <TableHead className="text-right text-xs text-slate-500">Лайки</TableHead>
                        <TableHead className="text-right text-xs text-slate-500">Закладки</TableHead>
                        <TableHead className="text-right text-xs text-slate-500">Просмотры</TableHead>
                        <TableHead className="text-right text-xs text-slate-500">Свайпы</TableHead>
                        <TableHead className="text-center text-xs text-slate-500">Статус</TableHead>
                        <TableHead className="text-center text-xs text-slate-500">Допуск</TableHead>
                        <TableHead className="text-center text-xs text-slate-500">Действия</TableHead>
                        <TableHead className="text-xs text-slate-500">Регистрация</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.items.map((u) => (
                        <TableRow key={u.id} className="border-slate-200 hover:bg-slate-50">
                          <TableCell className="max-w-[140px]">
                            <span title={u.id} className="block truncate font-mono text-xs text-slate-500">
                              {u.id}
                            </span>
                          </TableCell>
                          <TableCell className="max-w-[160px] truncate text-sm text-slate-800">
                            {displayName(u)}
                          </TableCell>
                          <TableCell className="max-w-[140px] truncate text-xs text-slate-500">
                            {u.username ? `@${u.username}` : '—'}
                          </TableCell>
                          <TableCell>
                            <UserKindBadge isGuest={u.isGuest} />
                          </TableCell>
                          <TableCell>
                            <TierBadge tier={u.tier} until={u.tierUntil} />
                            {(!u.tier || u.tier === 'free') && (
                              <span className="text-xs text-slate-400">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-slate-700">{fmtNum(u.likes)}</TableCell>
                          <TableCell className="text-right tabular-nums text-slate-700">
                            {fmtNum(u.bookmarks)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-slate-700">
                            {fmtNum(u.views)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-slate-700">
                            {u.swipes != null ? fmtNum(u.swipes) : '—'}
                          </TableCell>
                          <TableCell className="text-center">
                            {u.bannedAt ? (
                              <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700">бан</span>
                            ) : (
                              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">ок</span>
                            )}
                          </TableCell>
                          <TableCell className="text-center">
                            <Switch
                              checked={u.bypassMaintenance}
                              onCheckedChange={(v) => void toggleBypass(u, v)}
                              disabled={bypassBusy === u.id}
                              aria-label={`Допуск мимо техработ: ${displayName(u)}`}
                              className="mx-auto"
                            />
                          </TableCell>
                          <TableCell className="text-center">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openAction(u)}
                              aria-label={`Действия: ${displayName(u)}`}
                              className={cn('h-7 gap-1 px-2 text-xs', btnOutlineDark)}
                            >
                              <Settings2 className="size-3.5" aria-hidden /> Действия
                            </Button>
                          </TableCell>
                          <TableCell className="text-sm text-slate-500">{fmtAgo(u.createdAt)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>

              {/* Мобильные: карточки */}
              <div className="space-y-2 md:hidden">
                {data.items.map((u) => (
                  <div key={u.id} className="rounded-xl border border-slate-200 bg-white p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-sm font-medium text-slate-900">{displayName(u)}</span>
                          <UserKindBadge isGuest={u.isGuest} />
                          <TierBadge tier={u.tier} until={u.tierUntil} />
                        </div>
                        <span className="block truncate font-mono text-[11px] text-slate-500">{u.id}</span>
                      </div>
                      <Switch
                        checked={u.bypassMaintenance}
                        onCheckedChange={(v) => void toggleBypass(u, v)}
                        disabled={bypassBusy === u.id}
                        aria-label={`Допуск мимо техработ: ${displayName(u)}`}
                      />
                    </div>
                    <div className="mt-2 grid grid-cols-4 gap-1 text-center">
                      {(
                        [
                          ['Лайки', u.likes],
                          ['Закл.', u.bookmarks],
                          ['Взгл.', u.views],
                          ['Свайпы', u.swipes ?? 0],
                        ] as const
                      ).map(([label, v]) => (
                        <div key={label} className="rounded-lg bg-slate-50 py-1">
                          <div className="text-sm font-semibold tabular-nums text-slate-800">{fmtNum(v)}</div>
                          <div className="text-[11px] text-slate-500">{label}</div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-1.5 text-[11px] text-slate-400">
                      {u.username ? `@${u.username} · ` : ''}регистрация {fmtAgo(u.createdAt)}
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openAction(u)}
                        className={cn('h-7 px-2 text-xs', btnOutlineDark)}
                      >
                        Действия{u.bannedAt ? ' (бан)' : ''}
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

      {/* Модалка действий: подписка / баланс / премиум / бан */}
      {actionUser && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Действия: ${displayName(actionUser)}`}
          onClick={() => !actionBusy && setActionUser(null)}
        >
          <div
            className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-xl border border-slate-200 bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-base font-semibold text-slate-900">{displayName(actionUser)}</p>
                <p className="truncate font-mono text-[11px] text-slate-400">{actionUser.id}</p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                <TierBadge tier={actionUser.tier} until={actionUser.tierUntil} />
                {actionUser.isPremium && (
                  <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-700">
                    TG Premium
                  </span>
                )}
              </div>
            </div>
            {actionUser.bannedAt && actionUser.banReason && (
              <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                Забанен: {actionUser.banReason}
              </p>
            )}

            {/* ===== v5.18: Подписка Snap Plus/Pro ===== */}
            <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-emerald-800">
                <Gift className="size-4" aria-hidden /> Подписка Snap
                {actionUser.tier && actionUser.tier !== 'free' && actionUser.tierUntil && (
                  <span className="ml-auto font-normal text-emerald-700">
                    до {new Date(actionUser.tierUntil).toLocaleDateString('ru-RU')}
                  </span>
                )}
              </p>

              {/* План: Plus / Pro */}
              <div className="mt-2.5 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Тариф подписки">
                {(['plus', 'pro'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={tierPlan === p}
                    disabled={actionBusy}
                    onClick={() => setTierPlan(p)}
                    className={cn(
                      'rounded-lg border px-3 py-2 text-left transition',
                      tierPlan === p
                        ? p === 'pro'
                          ? 'border-amber-300 bg-amber-50 ring-1 ring-amber-300'
                          : 'border-emerald-300 bg-white ring-1 ring-emerald-300'
                        : 'border-slate-200 bg-white hover:border-slate-300',
                    )}
                  >
                    <span className={cn('flex items-center gap-1.5 text-sm font-semibold', p === 'pro' ? 'text-amber-700' : 'text-emerald-700')}>
                      <Gem className="size-3.5" aria-hidden /> {p === 'pro' ? 'Snap Pro' : 'Snap Plus'}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-slate-500">
                      {p === 'pro' ? 'ИИ-контентщик, продвижение' : 'Безлимит ИИ-поиск, инкогнито'}
                    </span>
                  </button>
                ))}
              </div>

              {/* Срок */}
              <div className="mt-2.5">
                <label className="text-xs font-semibold text-slate-700" htmlFor="tier-days">
                  <CalendarClock className="mr-1 inline size-3.5" aria-hidden /> Срок, дней
                </label>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {[1, 7, 30, 90, 180, 365].map((d) => (
                    <button
                      key={d}
                      type="button"
                      disabled={actionBusy || tierForever}
                      onClick={() => {
                        setTierDays(String(d))
                        setTierForever(false)
                      }}
                      className={cn(
                        'rounded-full border px-2.5 py-1 text-xs font-medium transition',
                        !tierForever && Number(tierDays) === d
                          ? 'border-emerald-300 bg-emerald-100 text-emerald-800'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                        tierForever && 'opacity-40',
                      )}
                    >
                      {d === 1 ? 'сутки' : `${d}д`}
                    </button>
                  ))}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <Input
                    id="tier-days"
                    type="number"
                    min={1}
                    max={36500}
                    value={tierForever ? '' : tierDays}
                    disabled={actionBusy || tierForever}
                    onChange={(e) => setTierDays(e.target.value)}
                    className={cn('h-8 w-24 text-sm', inputDark)}
                    aria-label="Срок подписки в днях"
                  />
                  <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={tierForever}
                      disabled={actionBusy}
                      onChange={(e) => setTierForever(e.target.checked)}
                      className="size-3.5 accent-emerald-600"
                    />
                    навсегда
                  </label>
                </div>
              </div>

              {/* Причина (необязательно) */}
              <Input
                value={tierReason}
                onChange={(e) => setTierReason(e.target.value)}
                placeholder="Заметка: бонус, компенсация…"
                maxLength={200}
                disabled={actionBusy}
                className={cn('mt-2 h-8 text-sm', inputDark)}
                aria-label="Заметка к выдаче подписки"
              />

              <div className="mt-2.5 grid grid-cols-2 gap-2">
                <Button
                  size="sm"
                  disabled={actionBusy || (!tierForever && (Number(tierDays) || 0) < 1)}
                  onClick={() =>
                    actionUser &&
                    void runUserAction(
                      actionUser,
                      { action: 'tier', userId: actionUser.id, tier: tierPlan, days: grantDays, mode: 'grant' },
                      `${tierPlan === 'pro' ? 'Snap Pro' : 'Snap Plus'} выдан на ${tierForever ? 'всё время' : `${grantDays} дн.`}`,
                      {
                        tier: tierPlan,
                        tierUntil: new Date(
                          Math.max(Date.now(), actionUser.tierUntil ? new Date(actionUser.tierUntil).getTime() : 0) +
                            grantDays * 86_400_000,
                        ).toISOString(),
                      },
                    )
                  }
                  className="h-9 bg-emerald-600 text-white hover:bg-emerald-700"
                >
                  <Gift className="size-4" aria-hidden />
                  {actionUser.tier === tierPlan && actionUser.tierUntil ? 'Продлить' : 'Выдать'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={actionBusy || !actionUser.tier || actionUser.tier === 'free'}
                  onClick={() =>
                    actionUser &&
                    void runUserAction(
                      actionUser,
                      { action: 'tier', userId: actionUser.id, mode: 'revoke' },
                      'Подписка отозвана',
                      { tier: 'free', tierUntil: null },
                    )
                  }
                  className={cn('h-9 hover:bg-red-50 hover:text-red-700', btnOutlineDark)}
                >
                  <Trash2 className="size-4" aria-hidden /> Отозвать
                </Button>
              </div>
              <p className="mt-1.5 text-[11px] leading-snug text-slate-500">
                Продление того же тарифа суммируется с текущим сроком. Отзыв сбрасывает тир в free.
              </p>
            </div>

            {/* Баланс свайпов */}
            <div className="mt-4">
              <label className="text-xs font-semibold text-slate-700" htmlFor="swipes-input">
                <Wallet className="mr-1 inline size-3.5" aria-hidden /> Баланс свайпов (сейчас{' '}
                {fmtNum(actionUser.swipes ?? 0)})
              </label>
              <div className="mt-1.5 flex gap-2">
                <Input
                  id="swipes-input"
                  type="number"
                  min={0}
                  max={10000000}
                  value={swipesInput}
                  onChange={(e) => setSwipesInput(e.target.value)}
                  className={cn('h-9 flex-1 text-sm', inputDark)}
                  aria-label="Новый баланс свайпов"
                />
                <Button
                  size="sm"
                  disabled={actionBusy || swipesInput === '' || Number(swipesInput) === actionUser.swipes}
                  onClick={() =>
                    actionUser &&
                    void runUserAction(
                      actionUser,
                      { action: 'swipes', userId: actionUser.id, swipes: Number(swipesInput) },
                      `Баланс изменён на ${fmtNum(Number(swipesInput))} свайпов`,
                      { swipes: Number(swipesInput) },
                    )
                  }
                  className="h-9 bg-slate-800 text-white hover:bg-slate-900"
                >
                  Сохранить
                </Button>
              </div>
            </div>

            {/* Telegram Premium (флаг) */}
            <div className="mt-3">
              <Button
                variant="outline"
                size="sm"
                disabled={actionBusy}
                onClick={() =>
                  actionUser &&
                  void runUserAction(
                    actionUser,
                    { action: 'premium', userId: actionUser.id },
                    actionUser.isPremium ? 'TG Premium снят' : 'TG Premium выдан',
                    { isPremium: !actionUser.isPremium },
                  )
                }
                className={cn('w-full', btnOutlineDark)}
              >
                <Gem className="size-4" aria-hidden />
                {actionUser.isPremium ? 'Снять флаг TG Premium' : 'Поставить флаг TG Premium'}
              </Button>
            </div>

            {/* Бан/разбан */}
            <div className="mt-4 border-t border-slate-100 pt-4">
              {!actionUser.bannedAt ? (
                <>
                  <label className="text-xs font-semibold text-slate-700" htmlFor="ban-reason">
                    <Ban className="mr-1 inline size-3.5 text-red-500" aria-hidden /> Причина бана
                  </label>
                  <Input
                    id="ban-reason"
                    value={banReason}
                    onChange={(e) => setBanReason(e.target.value)}
                    placeholder="спам, абьюз…"
                    maxLength={200}
                    className={cn('mt-1.5 h-9 text-sm', inputDark)}
                  />
                  <Button
                    size="sm"
                    disabled={actionBusy || banReason.trim().length === 0}
                    onClick={() =>
                      actionUser &&
                      void runUserAction(
                        actionUser,
                        { action: 'ban', userId: actionUser.id, reason: banReason.trim() },
                        'Пользователь забанен — API отвечает ему 403',
                        { bannedAt: new Date().toISOString(), banReason: banReason.trim() },
                      )
                    }
                    className="mt-2 w-full bg-red-600 text-white hover:bg-red-700"
                  >
                    <Ban className="size-4" aria-hidden /> Забанить пользователя
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={actionBusy}
                  onClick={() =>
                    actionUser &&
                    void runUserAction(
                      actionUser,
                      { action: 'unban', userId: actionUser.id },
                      'Пользователь разбанен',
                      { bannedAt: null, banReason: null },
                    )
                  }
                  className={cn('w-full', btnOutlineDark)}
                >
                  <ShieldOff className="size-4" aria-hidden /> Разбанить
                </Button>
              )}
              <p className="mt-2 text-[11px] leading-snug text-slate-400">
                Бан блокирует весь API (лента, комментарии, платежи) через Edge-зеркало;
                вход в миниапп остаётся, чтобы пользователь видел бан.
              </p>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  )
}
