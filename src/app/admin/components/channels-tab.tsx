'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle, Loader2, RefreshCw, Search, SearchX, Star, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
  type ChannelStatus,
  type ChannelStatusFilter,
  type ChannelsResponse,
  type PanelChannel,
} from './api'
import {
  Avatar,
  EmptyState,
  Pagination,
  SkeletonRows,
  StatusBadge,
  btnOutlineDark,
  fadeUp,
  inputDark,
  panelCard,
  statusLabel,
  useDebouncedValue,
} from './bits'
import type { TabProps } from './bits'

const PAGE_SIZE = 20

const STATUS_OPTIONS: { value: ChannelStatusFilter; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'active', label: 'Активные' },
  { value: 'moderation', label: 'На модерации' },
  { value: 'rejected', label: 'Отклонённые' },
]

// В строке — те же подписи, что и в бейдже статуса.
const ROW_STATUS_OPTIONS: { value: ChannelStatus; label: string }[] = [
  { value: 'active', label: 'активен' },
  { value: 'moderation', label: 'модерация' },
  { value: 'rejected', label: 'отклонён' },
]

export function ChannelsTab({ tick, onSettled }: TabProps) {
  const [status, setStatus] = useState<ChannelStatusFilter>('all')
  const [q, setQ] = useState('')
  const debouncedQ = useDebouncedValue(q, 400)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<ChannelsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [localTick, setLocalTick] = useState(0)

  useEffect(() => {
    let alive = true
    const run = async () => {
      const params = new URLSearchParams({
        status,
        page: String(page),
        pageSize: String(PAGE_SIZE),
      })
      if (debouncedQ.trim()) params.set('q', debouncedQ.trim())
      try {
        const d = await panelFetch<ChannelsResponse>(`/api/panel/channels?${params.toString()}`)
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
  }, [status, debouncedQ, page, tick, localTick])

  /** Оптимистичный PATCH статуса/премиума с откатом при ошибке. */
  const patch = async (ch: PanelChannel, body: { status?: ChannelStatus; isPremium?: boolean }) => {
    const snapshot = data
    setSavingId(ch.id)
    setData((prev) =>
      prev ? { ...prev, items: prev.items.map((i) => (i.id === ch.id ? { ...i, ...body } : i)) } : prev,
    )
    try {
      await panelFetch('/api/panel/channels', { method: 'PATCH', json: { id: ch.id, ...body } })
      if (body.status) toast.success(`«${ch.title}» — ${statusLabel(body.status)}`)
      if (body.isPremium !== undefined)
        toast.success(`Премиум ${body.isPremium ? 'включён' : 'выключен'} — «${ch.title}»`)
    } catch (e) {
      setData(snapshot)
      if (!isAuthOrNetworkError(e) && e instanceof PanelError) toast.error(e.message)
    } finally {
      setSavingId(null)
    }
  }

  const remove = async (ch: PanelChannel) => {
    const snapshot = data
    setData((prev) =>
      prev
        ? { ...prev, items: prev.items.filter((i) => i.id !== ch.id), total: Math.max(0, prev.total - 1) }
        : prev,
    )
    try {
      await panelFetch(`/api/panel/channels?id=${encodeURIComponent(ch.id)}`, { method: 'DELETE' })
      toast.success(`Канал «${ch.title}» удалён`)
    } catch (e) {
      setData(snapshot)
      if (!isAuthOrNetworkError(e) && e instanceof PanelError) toast.error(e.message)
    }
  }

  const resetFilters = () => {
    setQ('')
    setStatus('all')
    setPage(1)
  }

  return (
    <motion.div variants={fadeUp} initial="hidden" animate="show">
      <Card className={panelCard}>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base text-slate-100">Каналы</CardTitle>
              <CardDescription className="text-xs text-slate-500">
                Статусы, премиум и модерация каталога
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={status}
                onValueChange={(v) => {
                  setStatus(v as ChannelStatusFilter)
                  setPage(1)
                }}
              >
                <SelectTrigger
                  size="sm"
                  aria-label="Статус каналов"
                  className="w-[168px] border-white/10 bg-white/[0.04] text-slate-300"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-white/10 bg-[#16202b] text-slate-200">
                  {STATUS_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value} className="text-slate-300">
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
                  placeholder="Поиск по названию / @username"
                  aria-label="Поиск каналов"
                  className={cn('h-8 w-64 pl-8 text-sm', inputDark)}
                />
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading && !data ? (
            <SkeletonRows rows={8} />
          ) : error && !data ? (
            <EmptyState
              icon={AlertTriangle}
              title="Не удалось загрузить каналы"
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
              title="Каналы не найдены"
              hint="Попробуйте изменить статус или поисковый запрос"
              action={
                <Button variant="outline" size="sm" onClick={resetFilters} className={btnOutlineDark}>
                  Сбросить фильтры
                </Button>
              }
            />
          ) : data ? (
            <>
              <div className="admin-scroll max-h-[600px] overflow-auto rounded-md border border-white/[0.06]">
              <Table className="min-w-[900px]">
                <TableHeader>
                  <TableRow className="border-white/[0.06] hover:bg-transparent">
                    <TableHead className="text-xs text-slate-500">Канал</TableHead>
                    <TableHead className="text-xs text-slate-500">Категория</TableHead>
                    <TableHead className="text-xs text-slate-500">Статус</TableHead>
                    <TableHead className="text-xs text-slate-500">Премиум</TableHead>
                    <TableHead className="text-right text-xs text-slate-500">Подписчики</TableHead>
                    <TableHead className="text-right text-xs text-slate-500">Посты</TableHead>
                    <TableHead className="text-xs text-slate-500">Создан</TableHead>
                    <TableHead className="text-right text-xs text-slate-500">Действия</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((ch) => (
                    <TableRow key={ch.id} className="border-white/[0.06] hover:bg-white/[0.03]">
                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          <Avatar color={ch.avatarColor} title={ch.title} src={ch.avatarUrl} className="size-8 text-xs" />
                          <div className="max-w-[220px]">
                            <div className="flex items-center gap-1 truncate text-sm font-medium text-slate-200">
                              <span className="truncate">{ch.title}</span>
                              {ch.isPremium ? (
                                <Star className="size-3 shrink-0 fill-amber-400 text-amber-400" aria-hidden />
                              ) : null}
                            </div>
                            <div className="truncate text-xs text-slate-500">@{ch.username}</div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-slate-400">
                        {ch.categoryTitle ?? '—'}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={ch.status} />
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={ch.isPremium}
                          disabled={savingId === ch.id}
                          onCheckedChange={(v) => void patch(ch, { isPremium: v })}
                          aria-label={`Премиум: ${ch.title}`}
                          className="data-[state=checked]:bg-emerald-500"
                        />
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-slate-300">
                        {fmtNum(ch.subscribersCount)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-slate-300">
                        {fmtNum(ch.postsCount)}
                      </TableCell>
                      <TableCell className="text-sm text-slate-400">{fmtAgo(ch.createdAt)}</TableCell>
                      <TableCell>
                        <motion.div
                          whileHover={{ y: -1 }}
                          className="flex items-center justify-end gap-2"
                        >
                          <Select
                            value={ch.status}
                            onValueChange={(v) => void patch(ch, { status: v as ChannelStatus })}
                          >
                            <SelectTrigger
                              size="sm"
                              aria-label={`Статус канала ${ch.title}`}
                              disabled={savingId === ch.id}
                              className="h-8 w-[126px] border-white/10 bg-white/[0.04] text-xs text-slate-300"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="border-white/10 bg-[#16202b] text-slate-200">
                              {ROW_STATUS_OPTIONS.map((o) => (
                                <SelectItem key={o.value} value={o.value} className="text-slate-300">
                                  {o.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Удалить канал ${ch.title}`}
                                className="size-8 text-slate-500 hover:bg-red-500/10 hover:text-red-300"
                              >
                                {savingId === ch.id ? (
                                  <Loader2 className="size-4 animate-spin" aria-hidden />
                                ) : (
                                  <Trash2 className="size-4" aria-hidden />
                                )}
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent className="border-white/10 bg-[#131c26] text-slate-200">
                              <AlertDialogHeader>
                                <AlertDialogTitle className="text-slate-100">
                                  Удалить канал?
                                </AlertDialogTitle>
                                <AlertDialogDescription className="text-slate-400">
                                  Канал «{ch.title}» и все его посты будут удалены. Действие
                                  необратимо.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel
                                  className={cn(
                                    'border-white/10 bg-transparent text-slate-300 hover:bg-white/[0.06] hover:text-slate-100',
                                  )}
                                >
                                  Отмена
                                </AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() => void remove(ch)}
                                  className="bg-red-500/90 text-white hover:bg-red-500"
                                >
                                  Удалить
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </motion.div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              </div>
              <div className="mt-4">
                <Pagination
                  page={data.page}
                  pageSize={data.pageSize}
                  total={data.total}
                  onChange={setPage}
                />
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>
    </motion.div>
  )
}
