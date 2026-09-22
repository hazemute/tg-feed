'use client'

import { useEffect, useRef, useState } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { BarChart3, Camera, Eye, Flame, Heart, Image as ImageIcon, TrendingUp, Users } from 'lucide-react'
import { api } from '@/lib/api'
import { haptic, sharePostToStory } from '@/lib/tg'
import { formatCount, pluralRu, timeAgoRu } from '@/lib/format'
import { toast } from 'sonner'
import type { ChannelStatsDTO, TopPostDTO } from '@/lib/types'

/**
 * Кабинет канала — большая аналитическая страница вместо карточек.
 *
 * ПЛОСКИЙ стиль (без карточек): секции с волосяными разделителями, крупные
 * цифры, графики recharts в цветах темы Telegram. Все числа — точные
 * SQL-агрегаты из БД (см. /api/channel/stats).
 */

const DOW_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']
const DOW_FULL = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота']
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0] // Пн → Вс

const fmtDate = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short' })
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`

/* ---------- Каркас секции: плоско, с волосяной линией сверху ---------- */

function Section({
  title,
  hint,
  children,
  icon: Icon,
}: {
  title: string
  hint?: string
  children: React.ReactNode
  icon?: typeof Eye
}) {
  return (
    <section className="border-t border-tg-sep/60 px-4 pb-5 pt-4" aria-label={title}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-tg-hint">
          {Icon && <Icon className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />}
          {title}
        </h3>
        {hint && <span className="text-[12px] text-tg-hint">{hint}</span>}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  )
}

/* ---------- Полоса крупных цифр (2×N, волосяные разделители) ---------- */

function BigCell({
  label,
  value,
  sub,
}: {
  label: string
  value: string
  sub?: string
}) {
  return (
    <div className="border-tg-sep/60 px-4 py-3 odd:border-r sm:odd:border-r-0 [&:nth-child(n+3)]:border-t sm:[&:nth-child(n+3)]:border-t-0">
      <div className="text-[22px] font-bold leading-none tracking-tight text-tg-text tabular-nums">
        {value}
      </div>
      <div className="mt-1.5 text-[12.5px] font-medium text-tg-hint">{label}</div>
      {sub && <div className="mt-0.5 text-[11.5px] text-tg-hint/80">{sub}</div>}
    </div>
  )
}

/* ---------- Минималистичный тултип графиков ---------- */

function ChartTip({
  active,
  payload,
  label,
  suffix,
}: {
  active?: boolean
  payload?: Array<{ name?: string; value?: number | string; color?: string }>
  label?: string | number
  suffix?: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg bg-tg-bg px-2.5 py-1.5 text-[12px] shadow-lg ring-1 ring-tg-sep">
      {label !== undefined && <div className="mb-0.5 font-medium text-tg-hint">{label}</div>}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5 font-semibold text-tg-text tabular-nums">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} aria-hidden />
          {typeof p.value === 'number' ? formatCount(p.value) : p.value}
          {suffix ?? ''}
        </div>
      ))}
    </div>
  )
}

const AXIS_TICK = { fontSize: 10.5, fill: 'var(--tg-hint)' }

/* ---------- Топ постов: нумерованный плоский список ---------- */

function TopList({
  items,
  channelTitle,
}: {
  items: TopPostDTO[]
  channelTitle: string
}) {
  if (items.length === 0) return <p className="text-[13.5px] text-tg-hint">Постов пока нет</p>
  return (
    <ol className="divide-y divide-tg-sep/50">
      {items.map((p, i) => (
        <li key={p.id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
          <span className="w-5 shrink-0 pt-0.5 text-right text-[17px] font-bold leading-none text-tg-hint/60 tabular-nums">
            {i + 1}
          </span>
          {p.mediaUrl && p.mediaType === 'image' ? (
            <img
              src={p.mediaUrl}
              alt=""
              loading="lazy"
              className="h-11 w-11 shrink-0 rounded-lg object-cover ring-1 ring-tg-sep/60"
            />
          ) : (
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-tg-surface text-tg-hint ring-1 ring-tg-sep/60">
              <ImageIcon className="h-4.5 w-4.5" aria-hidden />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-[13.5px] leading-snug text-tg-text">
              {p.text || 'Без текста'}
            </p>
            <p className="mt-1 flex items-center gap-2.5 text-[12px] text-tg-hint tabular-nums">
              <span className="flex items-center gap-1">
                <Eye className="h-3 w-3" aria-hidden />
                {formatCount(p.views)}
              </span>
              {p.reactions > 0 && (
                <span className="flex items-center gap-1">
                  <Flame className="h-3 w-3" aria-hidden />
                  {formatCount(p.reactions)}
                </span>
              )}
              <span>{timeAgoRu(p.publishedAt)}</span>
            </p>
          </div>
          {/* Приказ владельца: истории из ВСЕХ своих постов — кнопка прямо в топе кабинета */}
          <button
            type="button"
            onClick={() => {
              haptic('light')
              toast.success('Открываю редактор историй…')
              void sharePostToStory(p.id, channelTitle)
            }}
            aria-label="Опубликовать пост в историю"
            className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-tg-surface text-tg-hint transition active:scale-90 hover:text-tg-link"
          >
            <Camera className="h-4 w-4" aria-hidden />
          </button>
        </li>
      ))}
    </ol>
  )
}

/* ---------- Основной кабинет ---------- */

export function ChannelCabinet({ username, title }: { username: string; title: string }) {
  const [stats, setStats] = useState<ChannelStatsDTO | null>(null)
  const [failed, setFailed] = useState(false)
  const statsRef = useRef<ChannelStatsDTO | null>(null)

  useEffect(() => {
    let alive = true
    // состояние сбрасывается ремонтом по key={username} (см. ChannelSheet) —
    // здесь только загрузка; setState — асинхронные колбэки
    const fetchStats = () =>
      api<ChannelStatsDTO>(`/api/channel/stats?username=${encodeURIComponent(username)}`)
        .then((d) => {
          if (alive) {
            statsRef.current = d
            setStats(d)
            setFailed(false)
          }
        })
        .catch(() => {
          if (alive && !statsRef.current) setFailed(true) // фоновые сбои не убивают экран
        })
    void fetchStats()
    /* v5.80: живой дашборд — тихий опрос 30с, пока вкладка видима.
       Просмотры/ER/динамика обновляются на глазах, без перезагрузки. */
    const iv = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void fetchStats()
    }, 30_000)
    return () => {
      alive = false
      clearInterval(iv)
    }
  }, [username])

  if (failed) {
    return (
      <div className="flex flex-col items-center gap-2 px-8 py-14 text-center">
        <BarChart3 className="h-6 w-6 text-tg-hint" aria-hidden />
        <p className="text-[14px] font-semibold text-tg-text">Статистика недоступна</p>
        <p className="text-snippet text-tg-hint">Попробуйте открыть канал позже</p>
      </div>
    )
  }

  if (!stats) return <CabinetSkeleton />

  const mediaTotal = stats.mediaMix.reduce((s, m) => s + m.count, 0) || 1
  const MEDIA_COLORS = ['var(--tg-link)', 'var(--tg-green)', 'var(--tg-star)', 'var(--tg-sep)']
  const MEDIA_LABELS: Record<string, string> = {
    image: 'Фото',
    video: 'Видео',
    gif: 'GIF',
    sticker: 'Стикеры',
    none: 'Без медиа',
    text: 'Текст',
    link: 'Ссылки',
    poll: 'Опросы',
    audio: 'Аудио',
    voice: 'Голосовые',
    file: 'Файлы',
  }

  return (
    <div className="pb-2">
      {/* ===== Обзор: крупные цифры (одна строка на sm+) ===== */}
      <div className="grid grid-cols-2 border-b border-tg-sep/60 sm:grid-cols-4 sm:divide-x sm:divide-tg-sep/60">
        <BigCell label="Просмотры всего" value={formatCount(stats.viewsTotal)} sub={`${stats.posts} постов`} />
        <BigCell label="В среднем на пост" value={formatCount(stats.viewsAvg)} sub={`медиана ${formatCount(stats.viewsMedian)}`} />
        <BigCell label="Реакции" value={formatCount(stats.reactionsTotal)} sub={`≈${formatCount(Math.round(stats.reactionsAvg))} на пост`} />
        <BigCell label="Вовлечённость" value={`${stats.erPct}%`} sub="реакций от просмотров" />
      </div>

      {/* ===== Охват подписчиков ===== */}
      {stats.reachPct !== null && (
        <div className="border-t border-tg-sep/60 px-4 py-3.5">
          <div className="flex items-baseline justify-between">
            <span className="text-[13px] font-medium text-tg-text2">Охват подписчиков</span>
            <span className="text-[13px] font-semibold text-tg-text tabular-nums">
              {stats.reachPct}%
            </span>
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-tg-sep">
            <div
              className="h-full rounded-full bg-tg-link transition-all"
              style={{ width: `${Math.min(100, stats.reachPct)}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11.5px] leading-snug text-tg-hint">
            Средний пост видит {formatCount(stats.viewsAvg)} из{' '}
            {formatCount(stats.membersCount ?? stats.subscribersCount)} подписчиков
          </p>
        </div>
      )}

      {/* ===== Секции в 2 колонки на ПК: страница вдвое короче ===== */}
      <div className="lg:grid lg:grid-cols-2 lg:items-start lg:gap-x-10">
      {/* ===== Динамика просмотров ===== */}
      {stats.series.length >= 2 && (
        <Section title="Динамика просмотров" hint={`последние ${stats.series.length} постов`} icon={TrendingUp}>
          <div className="h-[150px]" data-noswipe>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={stats.series} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="gViews" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--tg-link)" stopOpacity={0.28} />
                    <stop offset="100%" stopColor="var(--tg-link)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--tg-sep)" strokeDasharray="3 5" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={AXIS_TICK}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={44}
                  tickFormatter={(v: string) => fmtDate.format(new Date(v))}
                />
                <YAxis
                  tick={AXIS_TICK}
                  axisLine={false}
                  tickLine={false}
                  width={42}
                  tickFormatter={(v: number) => formatCount(v)}
                />
                <Tooltip
                  content={<ChartTip suffix=" просм." />}
                  cursor={{ stroke: 'var(--tg-sep)' }}
                />
                <Area
                  type="monotone"
                  dataKey="views"
                  stroke="var(--tg-link)"
                  strokeWidth={2}
                  fill="url(#gViews)"
                  dot={false}
                  activeDot={{ r: 3.5, fill: 'var(--tg-link)', strokeWidth: 0 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          {stats.series.some((s) => s.reactions > 0) && (
            <p className="mt-1.5 text-[11.5px] text-tg-hint">
              Реакции за тот же период: {formatCount(stats.series.reduce((s, x) => s + x.reactions, 0))}
            </p>
          )}
        </Section>
      )}

      {/* ===== Когда публикует: лучшее время + дни недели + часы ===== */}
      <Section
        title="Активность и лучшее время"
        hint={stats.bestSlot ? `${DOW_FULL[stats.bestSlot.dow]}, ${hh(stats.bestSlot.hour)}–${hh((stats.bestSlot.hour + 3) % 24)} UTC` : 'постов за всю историю'}
        icon={BarChart3}
      >
        {stats.bestSlot && (
          <div className="mb-3 flex items-center gap-3 rounded-xl bg-tg-link/[0.06] px-3 py-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-tg-link/10 text-[13px] font-bold text-tg-link">
              {DOW_SHORT[stats.bestSlot.dow]}
            </div>
            <p className="min-w-0 text-[12.5px] leading-snug text-tg-text2 tabular-nums">
              Лучший слот: в среднем{' '}
              <b className="font-semibold text-tg-text">{formatCount(stats.bestSlot.viewsAvg)}</b> просм. ·{' '}
              {stats.bestSlot.samples}{' '}
              {pluralRu(stats.bestSlot.samples, 'пост', 'поста', 'постов')}
            </p>
          </div>
        )}
        <div className="h-[110px]" data-noswipe>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={DOW_ORDER.map((dow) => ({
                dow,
                name: DOW_SHORT[dow],
                count: stats.weekday[dow].count,
              }))}
              margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
            >
              <XAxis dataKey="name" tick={AXIS_TICK} axisLine={false} tickLine={false} />
              <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={34} />
              <Tooltip content={<ChartTip suffix=" постов" />} cursor={{ fill: 'var(--tg-sep)', opacity: 0.4 }} />
              <Bar dataKey="count" fill="var(--tg-link)" radius={[4, 4, 0, 0]} maxBarSize={26} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Тепловая карта: часы суток UTC × количество постов */}
        <p className="mb-2 mt-3 text-[12px] font-medium text-tg-hint">Часы суток (UTC)</p>
        <div className="h-[88px]" data-noswipe>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={stats.hours.map((h) => ({ name: String(h.hour), count: h.count }))}
              margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
            >
              <XAxis
                dataKey="name"
                tick={AXIS_TICK}
                axisLine={false}
                tickLine={false}
                interval={2}
              />
              <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={34} />
              <Tooltip content={<ChartTip suffix=" постов" />} cursor={{ fill: 'var(--tg-sep)', opacity: 0.4 }} />
              <Bar dataKey="count" fill="var(--tg-link)" radius={[3, 3, 0, 0]} maxBarSize={12} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Section>

      {/* ===== Ритм публикаций (30 дней) ===== */}
      <Section
        title="Ритм публикаций"
        hint={
          stats.gapHoursAvg !== null
            ? `интервал ≈${stats.gapHoursAvg >= 24 ? `${Math.round(stats.gapHoursAvg / 24)} дн` : `${Math.round(stats.gapHoursAvg)} ч`}`
            : undefined
        }
        icon={TrendingUp}
      >
        <div className="h-[84px]" data-noswipe>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={stats.cadence.map((c) => ({ name: c.date.slice(8), count: c.count }))} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <XAxis dataKey="name" tick={AXIS_TICK} axisLine={false} tickLine={false} interval={6} />
              <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={30} allowDecimals={false} />
              <Tooltip
                content={<ChartTip suffix=" постов" />}
                cursor={{ fill: 'var(--tg-sep)', opacity: 0.4 }}
                labelFormatter={(l) => {
                  const row = stats.cadence.find((c) => c.date.slice(8) === String(l))
                  return row ? fmtDate.format(new Date(row.date)) : String(l)
                }}
              />
              <Bar dataKey="count" fill="var(--tg-green)" radius={[3, 3, 0, 0]} maxBarSize={14} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-tg-hint tabular-nums">
          <span>
            <b className="font-semibold text-tg-text2">{stats.postsPerDayAvg}</b> постов в активный день
          </span>
          <span>
            <b className="font-semibold text-tg-text2">{stats.activeDays}</b>{' '}
            {pluralRu(stats.activeDays, 'активный день', 'активных дня', 'активных дней')}
          </span>
          {stats.firstAt && (
            <span>
              в ленте с <b className="font-semibold text-tg-text2">{fmtDate.format(new Date(stats.firstAt))}</b>
            </span>
          )}
        </div>
      </Section>

      {/* ===== Топ постов ===== */}
      {stats.topByViews.length > 0 && (
        <Section title="Топ постов" hint="по просмотрам" icon={Eye}>
          <TopList items={stats.topByViews} channelTitle={title} />
        </Section>
      )}
      {stats.topByReactions.length > 0 && stats.topByReactions[0].reactions > 0 && (
        <Section title="Топ по реакциям" hint="по отклику" icon={Flame}>
          <TopList items={stats.topByReactions} channelTitle={title} />
        </Section>
      )}

      {/* ===== Контент ===== */}
      <Section title="Контент" hint={`${stats.withTextPct}% постов с текстом`} icon={ImageIcon}>
        <div className="flex h-2 overflow-hidden rounded-full bg-tg-sep">
          {stats.mediaMix.map((m, i) => (
            <div
              key={m.type}
              style={{
                width: `${(m.count / mediaTotal) * 100}%`,
                background: MEDIA_COLORS[i % MEDIA_COLORS.length],
              }}
            />
          ))}
        </div>
        <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1">
          {stats.mediaMix.slice(0, 5).map((m, i) => (
            <span key={m.type} className="flex items-center gap-1.5 text-[12px] text-tg-hint">
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: MEDIA_COLORS[i % MEDIA_COLORS.length] }}
                aria-hidden
              />
              {MEDIA_LABELS[m.type] ?? m.type}
              <b className="font-semibold text-tg-text2 tabular-nums">{Math.round((m.count / mediaTotal) * 100)}%</b>
            </span>
          ))}
        </div>

        {/* Факты: плоские строки */}
        <dl className="mt-3 divide-y divide-tg-sep/50">
          <FactRow label="Медиана просмотров" value={formatCount(stats.viewsMedian)} />
          <FactRow label="Рекорд поста" value={formatCount(stats.viewsMax)} />
          <FactRow label="Средняя длина текста" value={`${formatCount(stats.textLenAvg)} симв.`} />
          <FactRow label="Лайки в приложении" value={formatCount(stats.likesTotal)} icon={<Heart className="h-3.5 w-3.5" aria-hidden />} />
          <FactRow label="Открытия в приложении" value={formatCount(stats.appViews)} icon={<Users className="h-3.5 w-3.5" aria-hidden />} />
          {stats.lastAt && <FactRow label="Последний пост" value={timeAgoRu(stats.lastAt)} />}
        </dl>
      </Section>
      </div>

      <p className="border-t border-tg-sep/60 px-4 pb-4 pt-3 text-[11.5px] leading-snug text-tg-hint">
        Просмотры и реакции — данные исходного канала Telegram, обновляются при парсинге.
        Лайки и открытия — активность пользователей Tg Swipe.
      </p>
    </div>
  )
}

function FactRow({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <dt className="flex items-center gap-1.5 text-[13px] text-tg-hint">
        {icon}
        {label}
      </dt>
      <dd className="text-[13.5px] font-semibold text-tg-text tabular-nums">{value}</dd>
    </div>
  )
}

/* ---------- Скелетон кабинета ---------- */

function CabinetSkeleton() {
  return (
    <div aria-hidden>
      <div className="grid grid-cols-2 border-b border-tg-sep/60">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="border-tg-sep/60 px-4 py-4 odd:border-r [&:nth-child(n+3)]:border-t">
            <div className="tg-shimmer h-6 w-24 rounded-md" />
            <div className="tg-shimmer mt-2 h-3.5 w-16 rounded-md" />
          </div>
        ))}
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="border-t border-tg-sep/60 px-4 pb-5 pt-4">
          <div className="tg-shimmer h-3.5 w-36 rounded-md" />
          <div className="tg-shimmer mt-3 h-[150px] w-full rounded-xl" />
        </div>
      ))}
    </div>
  )
}
