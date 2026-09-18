'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle, Ban, Gem, RefreshCw, Search, SearchX, ShieldOff, Wallet } from 'lucide-react'
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

export function UsersTab({ tick, onSettled }: TabProps) {
  const [q, setQ] = useState('')
  const debouncedQ = useDebouncedValue(q, 400)
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

  useEffect(() => {
    let alive = true
    const run = async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
      if (debouncedQ.trim()) params.set('q', debouncedQ.trim())
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
  }, [debouncedQ, page, tick, localTick])

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

  /** Действие v5.11: бан/разбан/баланс/премиум с оптимистичным апдейтом */
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
    setActionUser(u)
  }

  return (
    <motion.div variants={fadeUp} initial="hidden" animate="show">
      <Card className={panelCard}>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base text-slate-900">Пользователи</CardTitle>
              <CardDescription className="text-xs text-slate-500">
                Поиск по ID и username · «Допуск» — проход мимо техработ
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
                    setPage(1)
                  }}
                  className={btnOutlineDark}
                >
                  Сбросить поиск
                </Button>
              }
            />
          ) : data ? (
            <>
              {/* Десктоп: таблица */}
              <div className="hidden md:block">
                <div className="admin-scroll max-h-[560px] overflow-auto rounded-md border border-slate-200">
                  <Table className="min-w-[880px]">
                    <TableHeader>
                      <TableRow className="border-slate-200 hover:bg-transparent">
                        <TableHead className="text-xs text-slate-500">ID</TableHead>
                        <TableHead className="text-xs text-slate-500">Имя</TableHead>
                        <TableHead className="text-xs text-slate-500">Username</TableHead>
                        <TableHead className="text-xs text-slate-500">Тип</TableHead>
                        <TableHead className="text-right text-xs text-slate-500">Лайки</TableHead>
                        <TableHead className="text-right text-xs text-slate-500">Подписки</TableHead>
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
                          <TableCell className="text-right tabular-nums text-slate-700">{fmtNum(u.likes)}</TableCell>
                          <TableCell className="text-right tabular-nums text-slate-700">
                            {fmtNum(u.subscriptions)}
                          </TableCell>
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
                              <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">бан</span>
                            ) : (
                              <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">ок</span>
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
                              className={cn('h-7 px-2 text-xs', btnOutlineDark)}
                            >
                              ⚙ Действия
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
                  <div key={u.id} className="rounded-lg border border-slate-200 bg-white p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-sm font-medium text-slate-900">{displayName(u)}</span>
                          <UserKindBadge isGuest={u.isGuest} />
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
                          ['Подп.', u.subscriptions],
                          ['Закл.', u.bookmarks],
                          ['Взгл.', u.views],
                        ] as const
                      ).map(([label, v]) => (
                        <div key={label} className="rounded bg-slate-50 py-1">
                          <div className="text-sm font-semibold tabular-nums text-slate-800">{fmtNum(v)}</div>
                          <div className="text-[10px] text-slate-500">{label}</div>
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
                      {u.swipes != null && (
                        <span className="text-[11px] tabular-nums text-slate-500">{fmtNum(u.swipes)} свайпов</span>
                      )}
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

      {/* Модалка действий: бан / баланс свайпов / премиум (v5.11) */}
      {actionUser && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Действия: ${displayName(actionUser)}`}
          onClick={() => !actionBusy && setActionUser(null)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-base font-semibold text-slate-900">{displayName(actionUser)}</p>
                <p className="truncate font-mono text-[11px] text-slate-400">{actionUser.id}</p>
              </div>
              {actionUser.isPremium && (
                <span className="flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10.5px] font-semibold text-amber-700">
                  <Gem className="size-3" aria-hidden /> Premium
                </span>
              )}
            </div>
            {actionUser.bannedAt && actionUser.banReason && (
              <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                Забанен: {actionUser.banReason}
              </p>
            )}

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
                  className="h-9 bg-emerald-600 text-white hover:bg-emerald-700"
                >
                  Сохранить
                </Button>
              </div>
            </div>

            {/* Премиум */}
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
                    actionUser.isPremium ? 'Premium снят' : 'Premium выдан',
                    { isPremium: !actionUser.isPremium },
                  )
                }
                className={cn('w-full', btnOutlineDark)}
              >
                <Gem className="size-4" aria-hidden />
                {actionUser.isPremium ? 'Снять Premium' : 'Выдать Premium'}
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
