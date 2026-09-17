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
            <div key={i} className="h-[86px] rounded-lg border border-white/[0.06] bg-white/[0.02]" />
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
            { text: `TG ${fmtNum(c.usersTelegram)}`, className: 'bg-sky-500/15 text-sky-300' },
            { text: `Демо ${fmtNum(c.usersDemo)}`, className: 'bg-slate-500/20 text-slate-300' },
          ]}
        />
        <MetricCard icon={Newspaper} label="Посты" value={c.posts} />
        <MetricCard
          icon={Radio}
          label="Каналы · активных"
          value={c.channelsActive}
          badges={[
            { text: `модерация ${fmtNum(c.channelsModeration)}`, className: 'bg-amber-500/15 text-amber-300' },
            { text: `отклонено ${fmtNum(c.channelsRejected)}`, className: 'bg-red-500/15 text-red-300' },
          ]}
        />
        <MetricCard icon={Heart} label="Лайки" value={c.likes} />
        <MetricCard icon={UserPlus} label="Подписки" value={c.subscriptions} />
        <MetricCard icon={Bookmark} label="Закладки" value={c.bookmarks} />
        <MetricCard icon={Hash} label="Клики #хэштегов · 24ч" value={c.hashtagClicks24h} />
        <MetricCard icon={Megaphone} label="Реклама" value={c.ads} />
      </motion.div>

      {/* Push-уведомления — отдельная строка-карточка */}
      <motion.div
        variants={fadeUp}
        className="flex flex-wrap items-center gap-3 rounded-lg border border-white/[0.08] bg-[#131c26] px-4 py-3"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-300">
          <Bell className="size-4" aria-hidden />
        </span>
        <p className="text-sm text-slate-300">
          Push-уведомления 24ч:{' '}
          <b className="font-semibold tabular-nums text-slate-100">{fmtNum(data.notif.sent24h)}</b>
          <span className="text-slate-500"> · </span>бот:{' '}
          <span
            className={
              data.notif.botConfigured ? 'font-medium text-emerald-400' : 'font-medium text-red-400'
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
              <CardTitle className="text-base text-slate-100">Свежие посты</CardTitle>
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
                    className="flex items-start gap-3 rounded-md px-1 py-2 transition-colors hover:bg-white/[0.03]"
                  >
                    <Avatar color={p.avatarColor} title={p.channelTitle} className="size-8 text-xs" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-slate-200">
                          {p.channelTitle}
                        </span>
                        {p.mediaUrl ? <ImageIcon className="size-3 shrink-0 text-slate-500" aria-hidden /> : null}
                        <span className="ml-auto shrink-0 text-[11px] text-slate-500">
                          {fmtAgo(p.publishedAt)}
                        </span>
                      </div>
                      <div className="truncate text-xs text-slate-500">@{p.channelUsername}</div>
                      <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-slate-400">{p.text}</p>
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
              <CardTitle className="text-base text-slate-100">Топ каналов</CardTitle>
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
                    className="flex items-center gap-3 rounded-md px-1 py-2 transition-colors hover:bg-white/[0.03]"
                  >
                    <Avatar color={ch.avatarColor} title={ch.title} className="size-8 text-xs" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-slate-200">{ch.title}</div>
                      <div className="truncate text-xs text-slate-500">@{ch.username}</div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-sm font-semibold tabular-nums text-slate-200">
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
              <CardTitle className="text-base text-slate-100">Новые пользователи</CardTitle>
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
                    className="flex items-center gap-3 rounded-md px-1 py-2 transition-colors hover:bg-white/[0.03]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-slate-200">
                        {u.firstName || u.username || u.id}
                      </div>
                      {u.username ? (
                        <div className="truncate text-xs text-slate-500">@{u.username}</div>
                      ) : null}
                    </div>
                    <UserKindBadge isDemo={u.isDemo} />
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
