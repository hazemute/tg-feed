'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  AlertTriangle,
  Bell,
  Bookmark,
  Hash,
  Heart,
  Image as ImageIcon,
  Megaphone,
  Newspaper,
  Radio,
  RefreshCw,
  UserPlus,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

import { useAdminSSE } from './admin-sse'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

import {
  fmtAgo,
  fmtNum,
  panelFetch,
  PanelError,
  type Overview,
  type OverviewCounts,
} from './api'
import {
  Avatar,
  EmptyState,
  MetricCard,
  SkeletonRows,
  UserKindBadge,
  btnOutlineDark,
  fadeUp,
  panelCard,
  staggerContainer,
} from './bits'

/** Спарклайн SVG: посты по дням, область + линия (светлая палитра) */
function PostsSparkline({ values }: { values: number[] }) {
  const w = 560
  const h = 72
  const pad = 6
  const max = Math.max(1, ...values)
  const n = values.length
  const px = (i: number) => pad + (i * (w - pad * 2)) / Math.max(1, n - 1)
  const py = (v: number) => h - pad - (v / max) * (h - pad * 2)
  const line = values.map((v, i) => `${px(i)},${py(v)}`).join(' ')
  const area = `${pad},${h - pad} ${line} ${px(n - 1)},${h - pad}`
  const last = values[n - 1] ?? 0

  return (
    <div className="flex items-end justify-between gap-4">
      <div>
        <div className="text-2xl font-semibold tabular-nums text-slate-900">{fmtNum(last)}</div>
        <div className="mt-0.5 text-xs text-slate-500">публикаций сегодня</div>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="h-16 w-full max-w-[420px]"
        preserveAspectRatio="none"
        role="img"
        aria-label="Публикации по дням за 14 дней"
      >
        <polygon points={area} fill="rgb(16 185 129 / 0.12)" />
        <polyline
          points={line}
          fill="none"
          stroke="rgb(5 150 105)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle cx={px(n - 1)} cy={py(last)} r="3" fill="rgb(5 150 105)" />
      </svg>
    </div>
  )
}

export function OverviewTab({
  tick,
  onSettled,
  onCounts,
}: {
  tick: number
  onSettled: () => void
  onCounts: (counts: OverviewCounts) => void
}) {
  const [data, setData] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [localTick, setLocalTick] = useState(0)
  const [botLive, setBotLive] = useState<boolean | null>(null)

  // Live-статус: подключение к общей SSE-шине панели + флаг бота из heartbeat
  const { connected } = useAdminSSE((e) => {
    if (e.name === 'status') setBotLive(e.data.bot)
  })

  useEffect(() => {
    let alive = true
    const run = async () => {
      try {
        const d = await panelFetch<Overview>('/api/panel/overview')
        if (!alive) return
        setData(d)
        setError(null)
        setLoading(false)
        onCounts(d.counts)
      } catch (e) {
        if (!alive) return
        // 401 обрабатывает страница (переключит на логин), 0 — уже показан тост о сети.
        if (e instanceof PanelError && (e.status === 401 || e.status === 0)) return
        const msg = e instanceof PanelError ? e.message : 'Ошибка загрузки'
        if (data) toast(msg)
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

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="h-[86px] rounded-lg border border-slate-200 bg-slate-50" />
          ))}
        </div>
        <Card className={panelCard}>
          <CardContent className="pt-6">
            <SkeletonRows rows={5} />
          </CardContent>
        </Card>
      </div>
    )
  }

  if (error && !data) {
    return (
      <Card className={panelCard}>
        <EmptyState
          icon={AlertTriangle}
          title="Не удалось загрузить обзор"
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
      </Card>
    )
  }

  if (!data) return null

  const c = data.counts

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="space-y-4">
      {/* Live-статус панели (SSE) */}
      <motion.div
        variants={fadeUp}
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-2.5"
        role="status"
        aria-live="off"
      >
        <span className="flex items-center gap-2 text-xs text-slate-700">
          <span
            aria-hidden
            className={cn(
              'size-2 rounded-full',
              connected ? 'animate-pulse bg-emerald-400' : 'bg-slate-600',
            )}
          />
          {connected ? 'Live-поток подключён' : 'Live-поток недоступен'}
        </span>
        {botLive !== null && (
          <span className={cn('text-xs', botLive ? 'text-emerald-600' : 'text-slate-500')}>
            бот: {botLive ? 'вкл' : 'выкл'}
          </span>
        )}
      </motion.div>

      {/* Метрики */}
      <motion.div
        variants={staggerContainer}
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4"
      >
        <MetricCard
          icon={Users}
          label="Пользователи"
          value={c.users}
          badges={[
            { text: `+${fmtNum(data.deltas24h.users)} за 24ч`, className: 'bg-emerald-50 text-emerald-700' },
            { text: `TG ${fmtNum(c.usersTelegram)}`, className: 'bg-sky-100 text-sky-700' },
            { text: `Гости ${fmtNum(c.usersGuest)}`, className: "bg-slate-100 text-slate-700" },
          ]}
        />
        <MetricCard
          icon={Newspaper}
          label="Посты"
          value={c.posts}
          badges={[{ text: `+${fmtNum(data.deltas24h.posts)} за 24ч`, className: 'bg-emerald-50 text-emerald-700' }]}
        />
        <MetricCard
          icon={Radio}
          label="Каналы · активных"
          value={c.channelsActive}
          badges={[
            { text: `модерация ${fmtNum(c.channelsModeration)}`, className: 'bg-amber-100 text-amber-700' },
            { text: `отклонено ${fmtNum(c.channelsRejected)}`, className: 'bg-red-100 text-red-700' },
          ]}
        />
        <MetricCard
          icon={Heart}
          label="Лайки"
          value={c.likes}
          badges={[{ text: `+${fmtNum(data.deltas24h.likes)} за 24ч`, className: 'bg-emerald-50 text-emerald-700' }]}
        />
        <MetricCard
          icon={UserPlus}
          label="Подписки"
          value={c.subscriptions}
          badges={[{ text: `+${fmtNum(data.deltas24h.subscriptions)} за 24ч`, className: 'bg-emerald-50 text-emerald-700' }]}
        />
        <MetricCard icon={Bookmark} label="Закладки" value={c.bookmarks} />
        <MetricCard icon={Hash} label="Клики #хэштегов · 24ч" value={c.hashtagClicks24h} />
        <MetricCard icon={Megaphone} label="Реклама" value={c.ads} />
      </motion.div>

      {/* Спарклайн публикаций + просмотры за сутки */}
      <motion.div variants={fadeUp} className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="mb-3 text-sm font-medium text-slate-800">Публикации · 14 дней</p>
          <PostsSparkline
            values={
              data.postsPerDay?.length
                ? data.postsPerDay
                : [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
            }
          />
        </div>
        <div className="flex flex-col justify-center gap-2 rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-sm font-medium text-slate-800">Просмотры · 24 часа</p>
          <div className="text-2xl font-semibold tabular-nums text-slate-900">
            {fmtNum(data.deltas24h.views)}
          </div>
          <p className="text-xs leading-relaxed text-slate-500">
            Открытия постов пользователями за последние сутки. Рост — лента цепляет, спад — пора
            обновить каналы.
          </p>
        </div>
      </motion.div>

      {/* Push-уведомления — отдельная строка-карточка */}
      <motion.div
        variants={fadeUp}
        className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-emerald-50 text-emerald-700">
          <Bell className="size-4" aria-hidden />
        </span>
        <p className="text-sm text-slate-700">
          Push-уведомления 24ч:{' '}
          <b className="font-semibold tabular-nums text-slate-900">{fmtNum(data.notif.sent24h)}</b>
          <span className="text-slate-500"> · </span>бот:{' '}
          <span
            className={
              data.notif.botConfigured ? 'font-medium text-emerald-600' : 'font-medium text-red-600'
            }
          >
            {data.notif.botConfigured ? 'вкл' : 'выкл'}
          </span>
        </p>
      </motion.div>

      {/* Списки */}
      <motion.div variants={staggerContainer} className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <motion.div variants={fadeUp}>
          <Card className={panelCard}>
            <CardHeader>
              <CardTitle className="text-base text-slate-900">Свежие посты</CardTitle>
              <CardDescription className="text-xs text-slate-500">
                Последние публикации в ленте
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-1">
              {data.freshPosts.length === 0 ? (
                <EmptyState icon={Newspaper} title="Постов пока нет" />
              ) : (
                data.freshPosts.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-start gap-3 rounded-md px-1 py-2 transition-colors hover:bg-slate-50"
                  >
                    <Avatar color={p.avatarColor} title={p.channelTitle} src={p.avatarUrl} className="size-8 text-xs" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-slate-800">
                          {p.channelTitle}
                        </span>
                        {p.mediaUrl ? <ImageIcon className="size-3 shrink-0 text-slate-500" aria-hidden /> : null}
                        <span className="ml-auto shrink-0 text-[11px] text-slate-500">
                          {fmtAgo(p.publishedAt)}
                        </span>
                      </div>
                      <div className="truncate text-xs text-slate-500">@{p.channelUsername}</div>
                      <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-slate-500">{p.text}</p>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </motion.div>

        <motion.div variants={fadeUp}>
          <Card className={panelCard}>
            <CardHeader>
              <CardTitle className="text-base text-slate-900">Топ каналов</CardTitle>
              <CardDescription className="text-xs text-slate-500">
                По числу подписчиков
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-1">
              {data.topChannels.length === 0 ? (
                <EmptyState icon={Radio} title="Каналов пока нет" />
              ) : (
                data.topChannels.map((ch) => (
                  <div
                    key={ch.username}
                    className="flex items-center gap-3 rounded-md px-1 py-2 transition-colors hover:bg-slate-50"
                  >
                    <Avatar color={ch.avatarColor} title={ch.title} src={ch.avatarUrl} className="size-8 text-xs" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-slate-800">{ch.title}</div>
                      <div className="truncate text-xs text-slate-500">@{ch.username}</div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-sm font-semibold tabular-nums text-slate-800">
                        {fmtNum(ch.subscribersCount)}
                      </div>
                      <div className="text-[11px] text-slate-500">{fmtNum(ch.postsCount)} постов</div>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </motion.div>

        <motion.div variants={fadeUp}>
          <Card className={`${panelCard} lg:col-span-2 xl:col-span-1`}>
            <CardHeader>
              <CardTitle className="text-base text-slate-900">Новые пользователи</CardTitle>
              <CardDescription className="text-xs text-slate-500">
                Последние 8 регистраций
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-1">
              {data.recentUsers.length === 0 ? (
                <EmptyState icon={Users} title="Пользователей пока нет" />
              ) : (
                data.recentUsers.map((u) => (
                  <div
                    key={u.id}
                    className="flex items-center gap-3 rounded-md px-1 py-2 transition-colors hover:bg-slate-50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-slate-800">
                        {u.firstName || u.username || u.id}
                      </div>
                      {u.username ? (
                        <div className="truncate text-xs text-slate-500">@{u.username}</div>
                      ) : null}
                    </div>
                    <UserKindBadge isGuest={u.isGuest} />
                    <span className="w-16 shrink-0 text-right text-[11px] text-slate-500">
                      {fmtAgo(u.createdAt)}
                    </span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </motion.div>
      </motion.div>
    </motion.div>
  )
}
