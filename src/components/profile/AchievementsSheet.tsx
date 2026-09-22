'use client'

/**
 * AchievementsSheet (v5.90) — полный экран достижений.
 *
 * Каталог живёт в lib/achievements.ts (общий с сервером), разблокировки и
 * метрики — GET /api/achievements. Карточка: иконка по группе, название,
 * описание, три ступени (🥉 порог → 🥈 → 🥇), прогресс к следующей ступени
 * и награда. variant="full" — контент длинный (10 карточек × 4 группы).
 */

import { useEffect, useMemo, useState } from 'react'
import {
  Bookmark,
  CalendarCheck,
  Compass,
  Eye,
  Flame,
  Heart,
  ListChecks,
  MessageCircle,
  Send,
  Sparkles,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { useApp } from '@/lib/store'
import { haptic } from '@/lib/tg'
import type { Lang } from '@/lib/i18n'
import {
  ACHIEVEMENTS,
  ACHIEVEMENT_TOTAL_STEPS,
  type AchievementDef,
  type AchievementsResponse,
} from '@/lib/achievements'
import { BottomSheet } from '@/components/tg/BottomSheet'

/** Иконки по строке из каталога (в серверном коде компоненты недоступны) */
const ICONS: Record<string, LucideIcon> = {
  Eye,
  Heart,
  MessageCircle,
  Bookmark,
  Sparkles,
  Flame,
  CalendarCheck,
  TrendingUp,
  Compass,
  ListChecks,
}

/** Палитра по группе (без синего/индиго — правило стиля проекта) */
const GROUP_STYLE: Record<AchievementDef['group'], { chip: string; bar: string; text: string }> = {
  activity: {
    chip: 'bg-emerald-500/15 text-emerald-600',
    bar: 'bg-emerald-500',
    text: 'text-emerald-600',
  },
  social: {
    chip: 'bg-rose-500/15 text-rose-500',
    bar: 'bg-rose-500',
    text: 'text-rose-500',
  },
  collection: {
    chip: 'bg-violet-500/15 text-violet-500',
    bar: 'bg-violet-500',
    text: 'text-violet-500',
  },
  progress: {
    chip: 'bg-amber-500/15 text-amber-500',
    bar: 'bg-amber-500',
    text: 'text-amber-500',
  },
}

const GROUP_ORDER: AchievementDef['group'][] = ['activity', 'social', 'collection', 'progress']

const STEP_EMOJI = ['🥉', '🥈', '🥇']

function fmtNum(n: number): string {
  return n.toLocaleString('ru-RU')
}

export function AchievementsSheet({
  open,
  onClose,
  isGuest,
  onLogin,
}: {
  open: boolean
  onClose: () => void
  isGuest: boolean
  /** Открыть логин по Telegram (модалка живёт в ProfileTab) */
  onLogin?: () => void
}) {
  const t = useT()
  const lang = useApp((s) => s.lang) as Lang
  const [data, setData] = useState<AchievementsResponse | null>(null)
  const [failed, setFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    if (!open || isGuest) return
    const ac = new AbortController()
    api<AchievementsResponse>('/api/achievements', { signal: ac.signal })
      .then((d) => {
        setData(d)
        setFailed(false)
      })
      .catch((e: unknown) => {
        if ((e as Error)?.name !== 'AbortError') setFailed(true)
      })
    return () => ac.abort()
  }, [open, isGuest, reloadKey])

  const tierByRow = useMemo(() => {
    const m = new Map<string, number>()
    data?.achievements.forEach((r) => m.set(r.id, r.tier))
    return m
  }, [data])

  const unlockedSteps = data?.unlockedSteps ?? 0

  return (
    <BottomSheet open={open} onClose={onClose} title={t('ach.title')} variant="full">
      {isGuest ? (
        <div className="rounded-2xl bg-tg-surface p-4 text-center">
          <p className="text-[15.5px] font-semibold text-tg-text">{t('ach.guestTitle')}</p>
          <p className="mt-1 text-[13.5px] leading-snug text-tg-hint">{t('ach.guestHint')}</p>
          <button
            type="button"
            onClick={() => {
              haptic('light')
              onClose()
              onLogin?.()
            }}
            className="press mx-auto mt-3 flex h-10 items-center gap-1.5 rounded-full bg-tg-link px-4 text-[14px] font-bold text-white"
          >
            <Send className="h-4 w-4" />
            Вход по Telegram
          </button>
        </div>
      ) : (
        <div className="space-y-5">
          {/* ---------- Сводка ---------- */}
          <div className="rounded-2xl bg-tg-surface p-4">
            <div className="flex items-baseline justify-between">
              <span className="text-[13px] font-medium text-tg-hint">{t('ach.summaryOf')}</span>
              <span className="text-[17px] font-bold tabular-nums text-tg-text">
                {unlockedSteps}
                <span className="text-[13px] font-medium text-tg-hint">
                  {' '}
                  {t('ach.of')} {ACHIEVEMENT_TOTAL_STEPS}
                </span>
              </span>
            </div>
            <div className="mt-2 h-[7px] w-full overflow-hidden rounded-full bg-tg-sep">
              <div
                className="h-full rounded-full bg-tg-link transition-[width] duration-500 ease-out"
                style={{
                  width: `${Math.round((unlockedSteps / ACHIEVEMENT_TOTAL_STEPS) * 100)}%`,
                }}
              />
            </div>
          </div>

          {/* ---------- Группы ---------- */}
          {!data && !failed && (
            <div className="space-y-2" aria-hidden>
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="tg-shimmer h-[86px] rounded-2xl" />
              ))}
            </div>
          )}
          {failed && (
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              className="w-full rounded-2xl bg-tg-surface py-5 text-[14px] font-medium text-tg-link"
            >
              {t('ach.reload')}
            </button>
          )}
          {data &&
            GROUP_ORDER.map((group) => {
              const defs = ACHIEVEMENTS.filter((a) => a.group === group)
              if (defs.length === 0) return null
              const groupKey = `ach.group${group[0].toUpperCase()}${group.slice(1)}` as
                | 'ach.groupActivity'
                | 'ach.groupSocial'
                | 'ach.groupCollection'
                | 'ach.groupProgress'
              return (
                <section key={group}>
                  <h3 className="mb-2 px-1 text-[13px] font-semibold uppercase tracking-wide text-tg-hint">
                    {t(groupKey)}
                  </h3>
                  <div className="space-y-2">
                    {defs.map((def) => (
                      <AchievementCard
                        key={def.id}
                        def={def}
                        tier={tierByRow.get(def.id) ?? 0}
                        value={data.metrics[def.metric] ?? 0}
                        lang={lang}
                      />
                    ))}
                  </div>
                </section>
              )
            })}

          {data && unlockedSteps === 0 && (
            <p className="px-4 text-center text-[13px] text-tg-hint">{t('ach.empty')}</p>
          )}
        </div>
      )}
    </BottomSheet>
  )
}

/* ------------------------------ Карточка -------------------------------- */

function AchievementCard({
  def,
  tier,
  value,
  lang,
}: {
  def: AchievementDef
  /** достигнутый тир (0 — ничего) */
  tier: number
  /** текущее значение метрики */
  value: number
  lang: Lang
}) {
  const t = useT()
  const style = GROUP_STYLE[def.group]
  const Icon = ICONS[def.icon] ?? Sparkles

  // Следующая ступень (null — всё получено)
  const nextTier = tier < 3 ? def.tiers[tier] : null
  const nextThreshold = nextTier?.value ?? 0
  const prevThreshold = tier > 0 ? def.tiers[tier - 1].value : 0
  const pct =
    nextTier && nextThreshold > prevThreshold
      ? Math.max(0, Math.min(1, (value - prevThreshold) / (nextThreshold - prevThreshold)))
      : 1

  const name = lang === 'en' ? def.name.en : def.name.ru
  const desc = lang === 'en' ? def.desc.en : def.desc.ru
  // «до Бронзы/Серебра/Золота» (ru — родительный падеж)
  const toTierLabels = [t('ach.toBronze'), t('ach.toSilver'), t('ach.toGold')]

  return (
    <div className="rounded-2xl bg-tg-surface p-3.5">
      <div className="flex items-start gap-3">
        <div
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${
            tier > 0 ? style.chip : 'bg-tg-sep/60 text-tg-hint'
          }`}
        >
          <Icon className="h-5 w-5" strokeWidth={1.9} aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[15px] font-semibold text-tg-text">{name}</span>
            {tier > 0 && (
              <span className="shrink-0 text-[13px]" aria-hidden>
                {STEP_EMOJI[tier - 1]}
              </span>
            )}
          </div>
          <div className="text-[12.5px] leading-snug text-tg-hint">{desc}</div>
        </div>
        {/* Награда за следующую ступень */}
        {nextTier && (
          <div className="shrink-0 text-right">
            <div className="text-[12.5px] font-bold tabular-nums text-tg-text">
              +{fmtNum(nextTier.swipes)}
            </div>
            <div className="text-[11px] tabular-nums text-tg-hint">+{nextTier.xp} XP</div>
          </div>
        )}
      </div>

      {/* Прогресс к следующей ступени */}
      <div className="mt-2.5">
        {nextTier ? (
          <>
            <div className="h-[5px] w-full overflow-hidden rounded-full bg-tg-sep/70">
              <div
                className={`h-full rounded-full transition-[width] duration-500 ease-out ${style.bar}`}
                style={{ width: `${Math.round(pct * 100)}%` }}
              />
            </div>
            <div className="mt-1 flex items-center justify-between text-[11.5px] tabular-nums text-tg-hint">
              <span>
                {toTierLabels[tier]}: {fmtNum(Math.min(value, nextThreshold))} / {fmtNum(nextThreshold)}
              </span>
              <span className="font-semibold text-tg-text">{Math.round(pct * 100)}%</span>
            </div>
          </>
        ) : (
          <div className={`text-[12px] font-semibold ${style.text}`}>
            ✓ {t('ach.done')} — {fmtNum(def.tiers[2].value)}+
          </div>
        )}
      </div>

      {/* Ступени: порог каждой */}
      <div className="mt-2.5 flex items-center gap-1.5" aria-label={t('ach.ariaSteps')}>
        {def.tiers.map((tr, i) => {
          const got = tier >= i + 1
          return (
            <div
              key={i}
              className={`flex min-w-0 flex-1 items-center justify-center gap-1 rounded-lg px-1.5 py-1 text-[11px] font-medium tabular-nums ${
                got ? 'bg-tg-link/10 text-tg-text' : 'bg-tg-sep/40 text-tg-hint'
              }`}
            >
              <span aria-hidden>{STEP_EMOJI[i]}</span>
              <span className="truncate">{fmtNum(tr.value)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
