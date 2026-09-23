'use client'

/**
 * v6.1: PRO ANALYTICS — карточка внизу раздела «Статистика» кабинета канала.
 *
 * Данные: GET /api/mychannel/analytics?channelId=…&days=7|14|30|90
 *  → totals (мини-метрики), series (CSS-барчарт по дням с переключателем
 *    метрики views/likes/subs), topPosts (топ-5 постов).
 *
 * 402 pro_required (api() кидает Error('pro_required')) → карточка-апселл
 * «Доступно на Snap Pro» с кнопкой «Подробнее» — паттерн TIERS_EVENT из
 * ChannelTab/PromoSection: флаг в sessionStorage + событие + вкладка «Профиль».
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BarChart3,
  Bookmark,
  Clock,
  Crown,
  Eye,
  Heart,
  Loader2,
  MessageSquare,
  Sparkles,
  Users,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { haptic } from '@/lib/tg'
import { useApp } from '@/lib/store'
import { formatCount } from '@/lib/format'

type AnalyticsData = {
  ok: true
  totals: {
    views: number
    likes: number
    comments: number
    bookmarks: number
    members: number
    avgDwellSec: number
    subscribedNow: number
  }
  series: { date: string; views: number; likes: number; subs: number }[]
  topPosts: { id: string; title: string; views: number; likes: number; publishedAt: string }[]
}

const TIERS_FLAG = 'tgfeed_open_tiers'
const TIERS_EVENT = 'tgfeed:open-tiers'

type Metric = 'views' | 'likes' | 'subs'

const METRICS: { id: Metric; label: string }[] = [
  { id: 'views', label: 'Просмотры' },
  { id: 'likes', label: 'Лайки' },
  { id: 'subs', label: 'Подписки' },
]

const PERIODS = [7, 14, 30, 90] as const

function fmtDayShort(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

/** Среднее время чтения: до минуты — в секундах, дальше — в минутах */
function fmtDwell(sec: number): string {
  if (sec <= 0) return '0 сек'
  if (sec < 60) return `${sec} сек`
  return `${Math.round(sec / 60)} мин`
}

function cut60(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > 60 ? `${clean.slice(0, 60).trimEnd()}…` : clean || 'Без текста'
}

export function ProAnalyticsCard({ channelId }: { channelId: string }) {
  const [days, setDays] = useState<number>(14)
  const [data, setData] = useState<AnalyticsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [proRequired, setProRequired] = useState(false)
  const [failed, setFailed] = useState(false)
  const [metric, setMetric] = useState<Metric>('views')
  const seqRef = useRef(0)

  const load = useCallback(
    async (d: number) => {
      const seq = ++seqRef.current
      setLoading(true)
      try {
        const r = await api<AnalyticsData>(
          `/api/mychannel/analytics?channelId=${encodeURIComponent(channelId)}&days=${d}`,
        )
        if (seq !== seqRef.current) return
        setData(r)
        setProRequired(false)
        setFailed(false)
      } catch (e) {
        if (seq !== seqRef.current) return
        // 402 pro_required — api() кидает Error с message 'pro_required'
        if ((e as Error)?.message === 'pro_required') setProRequired(true)
        else setFailed(true)
      } finally {
        if (seq === seqRef.current) setLoading(false)
      }
    },
    [channelId],
  )

  useEffect(() => {
    void load(days)
  }, [load, days])

  /** Паттерн ChannelTab/PromoSection: флаг + событие → шит тарифов на «Профиле» */
  const goTiers = () => {
    haptic('light')
    try {
      sessionStorage.setItem(TIERS_FLAG, '1')
    } catch {
      /* приватный режим — останется только событие */
    }
    window.dispatchEvent(new Event(TIERS_EVENT))
    useApp.getState().setTab('profile')
  }

  /* ---------- Апселл Snap Pro ---------- */
  if (proRequired) {
    return (
      <section className="relative mt-7 overflow-hidden rounded-2xl border border-tg-link/30 bg-gradient-to-br from-tg-link/[0.14] via-tg-link/[0.06] to-transparent p-5">
        <span
          className="flex h-12 w-12 items-center justify-center rounded-2xl bg-tg-link text-white shadow-lg shadow-tg-link/30"
          aria-hidden
        >
          <Crown className="h-6 w-6" />
        </span>
        <div className="mt-3 flex items-center gap-2">
          <h3 className="text-[17px] font-bold text-tg-text">Pro Analytics</h3>
          <Sparkles className="h-4 w-4 shrink-0 text-tg-star" aria-hidden />
        </div>
        <p className="mt-1 text-[13.5px] leading-relaxed text-tg-hint">
          Доступно на Snap Pro: просмотры и подписки по дням, топ постов, время чтения и платные
          подписчики — за 7/14/30/90 дней.
        </p>
        <button
          type="button"
          onClick={goTiers}
          className="press mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-2xl bg-tg-link text-[14.5px] font-bold text-white transition active:scale-[0.98]"
        >
          <Sparkles className="h-4 w-4" aria-hidden />
          Подробнее
        </button>
      </section>
    )
  }

  /* ---------- Сбой сети (не pro_required) ---------- */
  if (failed && !data) {
    return (
      <button
        type="button"
        onClick={() => void load(days)}
        className="mt-7 w-full rounded-2xl bg-tg-surface px-4 py-4 text-[13.5px] font-medium text-tg-hint"
      >
        Pro Analytics: не удалось загрузить · Повторить
      </button>
    )
  }

  const totals = data?.totals
  const series = data?.series ?? []

  const maxVal = Math.max(1, ...series.map((s) => s[metric]))

  return (
    <section className="mt-7" data-noswipe>
      {/* Заголовок + период */}
      <div className="mb-2 flex items-center gap-1.5 px-1">
        <BarChart3 className="h-4 w-4 text-tg-hint" aria-hidden />
        <span className="text-[13px] font-bold uppercase tracking-wide text-tg-hint">
          Pro Analytics
        </span>
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-tg-hint" aria-hidden />}
      </div>

      <div
        className="no-scrollbar mb-3 flex gap-2 overflow-x-auto"
        data-hscroll
        role="tablist"
        aria-label="Период аналитики"
      >
        {PERIODS.map((d) => (
          <button
            key={d}
            type="button"
            role="tab"
            aria-selected={days === d}
            onClick={() => {
              if (days !== d) {
                haptic('light')
                setDays(d)
              }
            }}
            className={cn(
              'flex h-8 shrink-0 items-center rounded-full px-3.5 text-[12.5px] font-semibold transition active:scale-95',
              days === d ? 'bg-tg-link text-white' : 'bg-tg-surface text-tg-hint',
            )}
          >
            {d} дней
          </button>
        ))}
      </div>

      {/* Мини-метрики */}
      {totals ? (
        <div className="grid grid-cols-3 gap-2">
          {(
            [
              { icon: Eye, label: 'Просмотры', value: formatCount(totals.views) },
              { icon: Heart, label: 'Лайки', value: formatCount(totals.likes) },
              { icon: MessageSquare, label: 'Комментарии', value: formatCount(totals.comments) },
              { icon: Bookmark, label: 'Закладки', value: formatCount(totals.bookmarks) },
              { icon: Crown, label: 'Платные подписчики', value: formatCount(totals.members) },
              { icon: Clock, label: 'Время чтения', value: fmtDwell(totals.avgDwellSec) },
            ] as const
          ).map((m) => (
            <div key={m.label} className="rounded-xl bg-tg-surface px-3 py-2.5">
              <m.icon className="h-3.5 w-3.5 text-tg-hint" aria-hidden />
              <div className="mt-1.5 truncate text-[16px] font-bold leading-none text-tg-text tabular-nums">
                {m.value}
              </div>
              <div className="mt-1 truncate text-[10.5px] leading-none text-tg-hint">{m.label}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="tg-shimmer h-24 rounded-2xl" aria-hidden />
      )}

      {/* Барчарт по дням: чистый CSS (flex-столбики), высота по максимуму серии */}
      <div className="mt-4 rounded-2xl border border-tg-sep/50 bg-tg-surface/60 p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12.5px] font-semibold text-tg-text2">Динамика по дням</span>
          <div className="flex gap-1" role="radiogroup" aria-label="Метрика графика">
            {METRICS.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={metric === m.id}
                onClick={() => {
                  haptic('light')
                  setMetric(m.id)
                }}
                className={cn(
                  'h-7 rounded-full px-2.5 text-[11.5px] font-semibold transition active:scale-95',
                  metric === m.id ? 'bg-tg-link text-white' : 'bg-tg-surface2 text-tg-hint',
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {series.length > 0 ? (
          <>
            {/* Столбики: тап/hover по всей высоте колонки — тайтл с датой и числом */}
            <div
              className="mt-3 flex h-28 items-end gap-[2px]"
              role="img"
              aria-label={`График: ${METRICS.find((m) => m.id === metric)?.label.toLowerCase()} по дням`}
            >
              {series.map((s) => {
                const v = s[metric]
                const h = Math.max(4, Math.round((v / maxVal) * 100))
                return (
                  <div
                    key={s.date}
                    className="flex h-full min-w-0 flex-1 cursor-default items-end"
                    title={`${fmtDayShort(s.date)}: ${formatCount(v)}`}
                  >
                    <div
                      className={cn(
                        'w-full rounded-t-[3px] transition-[height] duration-300',
                        v > 0 ? 'bg-tg-link' : 'bg-tg-sep',
                      )}
                      style={{ height: `${h}%` }}
                    />
                  </div>
                )
              })}
            </div>
            <div className="mt-1 flex justify-between text-[10.5px] text-tg-hint">
              <span>{fmtDayShort(series[0].date)}</span>
              <span>{fmtDayShort(series[series.length - 1].date)}</span>
            </div>
          </>
        ) : (
          <p className="mt-3 text-[12.5px] text-tg-hint">Пока нет данных за выбранный период</p>
        )}
      </div>

      {/* Топ постов */}
      {data && data.topPosts.length > 0 && (
        <div className="mt-4">
          <div className="mb-1.5 px-1 text-[12.5px] font-semibold text-tg-text2">Топ постов</div>
          <div className="divide-y divide-tg-sep/50 overflow-hidden rounded-2xl border border-tg-sep/50">
            {data.topPosts.map((p, i) => (
              <div key={p.id} className="flex items-center gap-3 px-3.5 py-2.5">
                <span className="w-5 shrink-0 text-center text-[13px] font-bold text-tg-hint tabular-nums">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13.5px] text-tg-text">
                  {cut60(p.title)}
                </span>
                <span className="flex shrink-0 items-center gap-2.5 text-[12px] font-semibold text-tg-hint tabular-nums">
                  <span className="flex items-center gap-1">
                    <Eye className="h-3.5 w-3.5" aria-hidden />
                    {formatCount(p.views)}
                  </span>
                  <span className="flex items-center gap-1">
                    <Heart className="h-3.5 w-3.5" aria-hidden />
                    {formatCount(p.likes)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {totals && totals.subscribedNow > 0 && (
        <p className="mt-3 flex items-center gap-1.5 px-1 text-[12px] text-tg-hint">
          <Users className="h-3.5 w-3.5" aria-hidden />
          Сейчас на канале {formatCount(totals.subscribedNow)} подписчиков
        </p>
      )}
    </section>
  )
}
