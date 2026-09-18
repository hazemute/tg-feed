'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle, RefreshCw, Search, SearchX } from 'lucide-react'
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
                        <TableHead className="text-center text-xs text-slate-500">Допуск</TableHead>
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
                          <TableCell className="text-center">
                            <Switch
                              checked={u.bypassMaintenance}
                              onCheckedChange={(v) => void toggleBypass(u, v)}
                              disabled={bypassBusy === u.id}
                              aria-label={`Допуск мимо техработ: ${displayName(u)}`}
                              className="mx-auto"
                            />
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
    </motion.div>
  )
}
