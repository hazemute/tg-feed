'use client'

import { useEffect, useState } from 'react'
import { Flame, Snowflake, Trophy } from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { BottomSheet } from '@/components/tg/BottomSheet'

/**
 * «Активность» (v5.93): стрик чтения + цель недели + календарь.
 *
 * Продуктовая механика удержания ПОВЕРХ чтения (не игра): день зачитывается
 * сам, когда юзер читает пост; заморозка покрывает один пропущенный день;
 * вехи стрика и цель недели дают свайпы. Данные — GET /api/reading, лениво
 * при открытии экрана (профиль не грузит их заранее) + SWR-кэш модуля.
 */

export type ReadingStatsDTO = {
  streak: number
  bestStreak: number
  freezes: number
  todayReads: number
  totalReads: number
  weekReads: number
  weekGoal: number
  weekReward: number
  milestones: { days: number; reward: number; reached: boolean }[]
  history: { day: string; reads: number }[]
}

let cachedReading: ReadingStatsDTO | null = null

/** Ячейка календаря: 0 → серый, 1–2 / 3–5 / 6+ → три ступени акцента */
function cellClass(reads: number): string {
  if (reads <= 0) return 'bg-tg-sep/50'
  if (reads <= 2) return 'bg-tg-link/25'
  if (reads <= 5) return 'bg-tg-link/50'
  return 'bg-tg-link'
}

const WD_LABELS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс']

function fmtDate(day: string): string {
  return day.slice(8, 10) + '.' + day.slice(5, 7)
}

export function StreakSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const [stats, setStats] = useState<ReadingStatsDTO | null>(cachedReading)

  useEffect(() => {
    if (!open) return
    let stopped = false
    api<ReadingStatsDTO>('/api/reading')
      .then((d) => {
        cachedReading = d
        if (!stopped) setStats(d)
      })
      .catch(() => {})
    return () => {
      stopped = true
    }
  }, [open])

  // Сетка календаря: колонки — дни недели (пн..вс), старт с выравниванием
  const history = stats?.history ?? []
  const pad = history.length > 0 ? (new Date(`${history[0].day}T00:00:00Z`).getUTCDay() + 6) % 7 : 0
  const cells: ({ day: string; reads: number } | null)[] = [...Array<null>(pad), ...history]

  const weekReads = stats?.weekReads ?? 0
  const goal = stats?.weekGoal ?? 30
  const progress = Math.min(1, goal > 0 ? weekReads / goal : 0)
  const R = 26
  const C = 2 * Math.PI * R

  return (
    <BottomSheet open={open} onClose={onClose} title={t('act.title')} subtitle={t('act.subtitle')} variant="full">
      <div className="space-y-5 px-4 pb-10 pt-4">
        {/* Три стата: стрик / рекорд / заморозки */}
        <div className="grid grid-cols-3 gap-2">
          {[
            {
              icon: Flame,
              value: stats ? `${stats.streak}` : null,
              label: t('act.streak'),
              tone: 'text-orange-500',
              bg: 'bg-orange-500/15',
            },
            {
              icon: Trophy,
              value: stats ? `${stats.bestStreak}` : null,
              label: t('act.best'),
              tone: 'text-amber-500',
              bg: 'bg-amber-500/15',
            },
            {
              icon: Snowflake,
              value: stats ? `${stats.freezes}` : null,
              label: t('act.freezes'),
              tone: 'text-sky-500',
              bg: 'bg-sky-500/15',
            },
          ].map((s, i) => (
            <div key={i} className="rounded-2xl border border-tg-sep/50 bg-tg-surface/60 px-3 py-3.5 text-center">
              <s.icon className={cn('mx-auto h-5 w-5', s.tone)} strokeWidth={1.9} aria-hidden />
              <div className="mt-1 text-[20px] font-bold leading-none tabular-nums text-tg-text">
                {s.value ?? <span className="inline-block h-5 w-6 rounded bg-tg-sep/60 tg-shimmer" aria-hidden />}
              </div>
              <div className="mt-1 text-[11.5px] font-medium text-tg-hint">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Цель недели: кольцо прогресса + награда */}
        <section className="rounded-2xl border border-tg-sep/50 bg-tg-surface/60 p-4" aria-label={t('act.weekGoal')}>
          <div className="flex items-center gap-4">
            <div className="relative h-16 w-16 shrink-0" role="img" aria-label={`${weekReads}/${goal}`}>
              <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90">
                <circle cx="32" cy="32" r={R} fill="none" strokeWidth="6" className="stroke-tg-sep/60" />
                <circle
                  cx="32"
                  cy="32"
                  r={R}
                  fill="none"
                  strokeWidth="6"
                  strokeLinecap="round"
                  className="stroke-tg-link transition-[stroke-dashoffset] duration-500"
                  strokeDasharray={C}
                  strokeDashoffset={C * (1 - progress)}
                />
              </svg>
              <span className="absolute inset-0 flex items-center justify-center text-[13px] font-bold tabular-nums text-tg-text">
                {Math.round(progress * 100)}%
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[15.5px] font-bold text-tg-text">{t('act.weekGoal')}</div>
              <div className="mt-0.5 text-[13.5px] tabular-nums text-tg-text2">
                {stats ? (
                  <>
                    {weekReads} / {goal} · {t('act.postsShort')}
                  </>
                ) : (
                  <span className="inline-block h-4 w-28 rounded bg-tg-sep/60 tg-shimmer" aria-hidden />
                )}
              </div>
              <div className="mt-1 text-[12.5px] leading-snug text-tg-hint">
                {t('act.weekRewardHint')} +{stats?.weekReward ?? 300}
              </div>
            </div>
          </div>
        </section>

        {/* Календарь последних 5 недель */}
        <section aria-label={t('act.calendar')}>
          <div className="flex items-center justify-between px-1">
            <h3 className="text-[14px] font-bold text-tg-text">{t('act.calendar')}</h3>
            {stats && stats.todayReads > 0 && (
              <span className="text-[12px] tabular-nums text-tg-hint">
                {t('act.readToday')} {stats.todayReads}
              </span>
            )}
          </div>
          <div className="mt-2 flex gap-1 px-1" aria-hidden>
            {WD_LABELS.map((w) => (
              <span key={w} className="w-[calc((100%-24px)/7)] text-center text-[10.5px] font-medium text-tg-hint">
                {w}
              </span>
            ))}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-1 px-1" role="img" aria-label={t('act.calendar')}>
            {cells.map((c, i) =>
              c ? (
                <span
                  key={c.day}
                  title={`${fmtDate(c.day)} · ${c.reads}`}
                  className={cn('aspect-square w-full rounded-[5px]', cellClass(c.reads))}
                />
              ) : (
                <span key={`pad-${i}`} className="aspect-square w-full rounded-[5px] bg-transparent" aria-hidden />
              ),
            )}
          </div>
          <p className="mt-2 px-1 text-[12px] leading-snug text-tg-hint">{t('act.howItWorks')}</p>
        </section>

        {/* Вехи стрика */}
        <section aria-label={t('act.milestones')}>
          <h3 className="px-1 text-[14px] font-bold text-tg-text">{t('act.milestones')}</h3>
          <div className="mt-2 overflow-hidden rounded-2xl border border-tg-sep/50 bg-tg-surface/60">
            {(stats?.milestones ?? [
              { days: 7, reward: 500, reached: false },
              { days: 30, reward: 2500, reached: false },
              { days: 100, reward: 10000, reached: false },
            ]).map((m, i) => (
              <div key={m.days} className={cn('flex items-center gap-3 px-4 py-3', i > 0 && 'border-t border-tg-sep/60')}>
                <span
                  className={cn(
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[12.5px] font-bold tabular-nums',
                    m.reached ? 'bg-tg-link/15 text-tg-link' : 'bg-tg-sep/40 text-tg-hint',
                  )}
                >
                  {m.days}
                </span>
                <div className="min-w-0 flex-1">
                  <div className={cn('text-[14.5px] font-semibold', m.reached ? 'text-tg-text' : 'text-tg-text2')}>
                    {m.reached ? t('act.milestoneDone') : t('act.milestoneTodo')}
                  </div>
                  <div className="text-[12.5px] text-tg-hint">
                    +{m.reward.toLocaleString('ru-RU')} · {t('act.freezesHintShort')}
                  </div>
                </div>
                {m.reached && (
                  <span className="shrink-0 text-[13px] font-bold text-tg-link" aria-label="done">
                    ✓
                  </span>
                )}
              </div>
            ))}
          </div>
          {stats && stats.totalReads > 0 && (
            <p className="mt-2 px-1 text-[12.5px] tabular-nums text-tg-hint">
              {t('act.totalReads')} {stats.totalReads.toLocaleString('ru-RU')}
            </p>
          )}
        </section>
      </div>
    </BottomSheet>
  )
}
