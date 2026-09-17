'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle, CircleCheck, Check, Loader2, RefreshCw, X } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

import {
  fmtAgo,
  isAuthOrNetworkError,
  panelFetch,
  PanelError,
  type ModerationItem,
  type ModerationResponse,
} from './api'
import {
  Avatar,
  EmptyState,
  SkeletonRows,
  TabProps,
  btnOutlineDark,
  fadeUp,
  panelCard,
  staggerContainer,
} from './bits'
import { cn } from '@/lib/utils'

export function ModerationTab({
  tick,
  onSettled,
  onCount,
}: TabProps & { onCount: (count: number) => void }) {
  const [items, setItems] = useState<ModerationItem[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [localTick, setLocalTick] = useState(0)

  useEffect(() => {
    let alive = true
    const run = async () => {
      try {
        const d = await panelFetch<ModerationResponse>('/api/panel/moderation')
        if (!alive) return
        setItems(d.items)
        setError(null)
        setLoading(false)
        onCount(d.items.length)
      } catch (e) {
        if (!alive || isAuthOrNetworkError(e)) return
        const msg = e instanceof PanelError ? e.message : 'Ошибка загрузки'
        if (items) toast.error(msg)
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
  }, [tick, localTick])

  const act = async (item: ModerationItem, action: 'approve' | 'reject') => {
    setBusyId(item.id)
    try {
      await panelFetch('/api/panel/moderation', { json: { channelId: item.id, action } })
      // Новый список считаем вне state-updater'а: вызов onCount (setState родителя)
      // внутри updater'а React расценивает как setState во время рендера.
      const next = (items ?? []).filter((p) => p.id !== item.id)
      setItems(next)
      onCount(next.length)
      toast.success(action === 'approve' ? `«${item.title}» одобрен` : `«${item.title}» отклонён`)
    } catch (e) {
      if (!isAuthOrNetworkError(e) && e instanceof PanelError) toast.error(e.message)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <motion.div variants={fadeUp} initial="hidden" animate="show">
      <Card className={panelCard}>
        <CardHeader>
          <CardTitle className="text-base text-slate-100">Модерация каналов</CardTitle>
          <CardDescription className="text-xs text-slate-500">
            Заявки, добавленные пользователями через мини-апп
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading && items === null ? (
            <SkeletonRows rows={4} />
          ) : error && items === null ? (
            <EmptyState
              icon={AlertTriangle}
              title="Не удалось загрузить очередь"
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
          ) : items && items.length === 0 ? (
            <EmptyState
              icon={CircleCheck}
              title="Очередь пуста"
              hint="Все каналы обработаны"
            />
          ) : items ? (
            <motion.div
              variants={staggerContainer}
              initial="hidden"
              animate="show"
              className="space-y-3"
            >
              {items.map((item) => (
                <motion.div
                  key={item.id}
                  variants={fadeUp}
                  whileHover={{ y: -1 }}
                  className="flex flex-col gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] p-4 sm:flex-row sm:items-center"
                >
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <Avatar color={item.avatarColor} title={item.title} src={item.avatarUrl} />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="truncate text-sm font-semibold text-slate-100">
                          {item.title}
                        </span>
                        <span className="truncate text-xs text-slate-500">@{item.username}</span>
                      </div>
                      {item.description ? (
                        <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-slate-400">
                          {item.description}
                        </p>
                      ) : null}
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
                        <span>Категория: {item.categoryTitle ?? '—'}</span>
                        <span>Постов: {item.postsCount}</span>
                        <span>Добавлен: {fmtAgo(item.createdAt)}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      size="sm"
                      disabled={busyId === item.id}
                      onClick={() => void act(item, 'approve')}
                      className="border border-emerald-500/30 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
                    >
                      {busyId === item.id ? (
                        <Loader2 className="animate-spin" aria-hidden />
                      ) : (
                        <Check aria-hidden />
                      )}
                      Одобрить
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId === item.id}
                      onClick={() => void act(item, 'reject')}
                      className={cn(
                        'border-red-500/30 bg-transparent text-red-300 hover:bg-red-500/10 hover:text-red-200',
                      )}
                    >
                      <X aria-hidden /> Отклонить
                    </Button>
                  </div>
                </motion.div>
              ))}
            </motion.div>
          ) : null}
        </CardContent>
      </Card>
    </motion.div>
  )
}
