'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  AlertTriangle,
  CircleCheck,
  Check,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

import {
  fmtAgo,
  isAuthOrNetworkError,
  panelFetch,
  PanelError,
  type CommentModItem,
  type CommentModResponse,
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
  inputDark,
  panelCard,
  staggerContainer,
  useDebouncedValue,
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
  const [confirmId, setConfirmId] = useState<string | null>(null)

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
    <motion.div variants={fadeUp} initial="hidden" animate="show" className="space-y-6">
      <Card className={panelCard}>
        <CardHeader>
          <CardTitle className="text-base text-slate-900">Модерация каналов</CardTitle>
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
                  className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-center"
                >
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <Avatar color={item.avatarColor} title={item.title} src={item.avatarUrl} />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="truncate text-sm font-semibold text-slate-900">
                          {item.title}
                        </span>
                        <span className="truncate text-xs text-slate-500">@{item.username}</span>
                      </div>
                      {item.description ? (
                        <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-slate-500">
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
                      className="border border-emerald-500/30 bg-emerald-100 text-emerald-700 hover:bg-emerald-500/25"
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
                        'border-red-500/30 bg-transparent text-red-700 hover:bg-red-50 hover:text-red-700',
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

      <CommentsCard />
    </motion.div>
  )
}

/* ===================== Модерация комментариев ===================== */

function CommentsCard() {
  const [rawQuery, setRawQuery] = useState('')
  const query = useDebouncedValue(rawQuery, 400)
  const [items, setItems] = useState<CommentModItem[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [localTick, setLocalTick] = useState(0)

  // Поиск в URL не пишем — q меняет ответ, перезапрос по debounce
  useEffect(() => {
    let alive = true
    const run = async () => {
      try {
        const qs = query ? `?q=${encodeURIComponent(query)}` : ''
        const d = await panelFetch<CommentModResponse>(`/api/panel/comments${qs}`)
        if (!alive) return
        setItems(d.items)
        setError(null)
        setLoading(false)
      } catch (e) {
        if (!alive || isAuthOrNetworkError(e)) return
        const msg = e instanceof PanelError ? e.message : 'Ошибка загрузки'
        if (items) toast.error(msg)
        else setError(msg)
        setLoading(false)
      }
    }
    void run()
    return () => {
      alive = false
    }
  }, [localTick, query])

  const remove = async (item: CommentModItem) => {
    setBusyId(item.id)
    try {
      await panelFetch('/api/panel/comments', { method: 'DELETE', json: { id: item.id } })
      setItems((prev) => (prev ?? []).filter((p) => p.id !== item.id))
      toast.success('Комментарий удалён')
    } catch (e) {
      if (!isAuthOrNetworkError(e) && e instanceof PanelError) toast.error(e.message)
    } finally {
      setBusyId(null)
      setConfirmId(null)
    }
  }

  return (
    <Card className={panelCard}>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base text-slate-900">
              <MessageSquare className="h-4 w-4 text-slate-500" aria-hidden />
              Комментарии
            </CardTitle>
            <CardDescription className="mt-1 text-xs text-slate-500">
              Последние комментарии под постами — спам и нарушения можно удалять
            </CardDescription>
          </div>
          <div className="relative w-full sm:w-64">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
              aria-hidden
            />
            <Input
              value={rawQuery}
              onChange={(e) => setRawQuery(e.target.value)}
              placeholder="Текст, имя или @username…"
              className={cn(inputDark, 'h-9 pl-9 text-sm')}
              aria-label="Поиск комментариев"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading && items === null ? (
          <SkeletonRows rows={4} />
        ) : error && items === null ? (
          <EmptyState
            icon={AlertTriangle}
            title="Не удалось загрузить комментарии"
            hint={error}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setLoading(true)
                  setLocalTick((t) => t + 1)
                }}
                className={btnOutlineDark}
              >
                <RefreshCw aria-hidden /> Повторить
              </Button>
            }
          />
        ) : items && items.length === 0 ? (
          <EmptyState
            icon={query ? MessageSquare : CircleCheck}
            title={query ? 'Ничего не найдено' : 'Комментариев пока нет'}
            hint={query ? 'Попробуйте другой запрос' : 'Как только появятся — они будут здесь'}
          />
        ) : items ? (
          <motion.div
            variants={staggerContainer}
            initial="hidden"
            animate="show"
            className="space-y-3"
          >
            {items.map((c) => (
              <motion.div
                key={c.id}
                variants={fadeUp}
                className="rounded-lg border border-slate-200 bg-slate-50 p-4"
              >
                <div className="flex items-start gap-3">
                  <Avatar
                    color="#e2e8f0"
                    title={c.author.name}
                    src={c.author.avatarUrl}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="truncate text-sm font-semibold text-slate-900">
                        {c.author.name}
                      </span>
                      {c.author.username ? (
                        <span className="truncate text-xs text-slate-500">
                          @{c.author.username}
                        </span>
                      ) : null}
                      {c.author.banned ? (
                        <span className="rounded-full border border-red-500/30 bg-red-50 px-1.5 py-px text-[10px] font-semibold text-red-600">
                          забанен
                        </span>
                      ) : null}
                      <span className="ml-auto whitespace-nowrap text-[11px] text-slate-400">
                        {fmtAgo(c.createdAt)}
                      </span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-snug text-slate-700">
                      {c.text}
                    </p>
                    <p className="mt-1.5 truncate text-[11px] text-slate-500">
                      Под постом «{c.post.excerpt || 'без текста'}» ·{' '}
                      <span className="font-medium">
                        {c.post.channelTitle}
                        {c.post.channelUsername ? ` (@${c.post.channelUsername})` : ''}
                      </span>
                    </p>
                  </div>
                  <div className="shrink-0">
                    {confirmId === c.id ? (
                      <div className="flex items-center gap-1.5">
                        <Button
                          size="sm"
                          disabled={busyId === c.id}
                          onClick={() => void remove(c)}
                          className="border border-red-500/30 bg-red-100 text-red-700 hover:bg-red-500/25"
                        >
                          {busyId === c.id ? (
                            <Loader2 className="animate-spin" aria-hidden />
                          ) : (
                            <Trash2 aria-hidden />
                          )}
                          Удалить
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busyId === c.id}
                          onClick={() => setConfirmId(null)}
                        >
                          <X aria-hidden />
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setConfirmId(c.id)}
                        className="border-red-500/30 bg-transparent text-red-700 hover:bg-red-50 hover:text-red-700"
                        aria-label="Удалить комментарий"
                      >
                        <Trash2 aria-hidden />
                        <span className="hidden sm:inline">Удалить</span>
                      </Button>
                    )}
                  </div>
                </div>
              </motion.div>
            ))}
          </motion.div>
        ) : null}
      </CardContent>
    </Card>
  )
}
