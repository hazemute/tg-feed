'use client'

/**
 * LevelSheet (v5.75) — детали уровня: прогресс и награда, «как получать XP»,
 * дневные лимиты и журнал последних начислений (XpLog через GET /api/level).
 * Открывается тапом по LevelBar в своём профиле.
 */

import { useEffect, useState } from 'react'
import {
  Bug,
  CalendarCheck,
  Heart,
  ListChecks,
  MessageCircle,
  Send,
  ShieldAlert,
  Sparkles,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { haptic } from '@/lib/tg'
import { levelProgress } from '@/lib/xp-rules'
import type { LevelResponse } from '@/lib/types'
import { BottomSheet } from '@/components/tg/BottomSheet'

/** Иконка и цвет записи журнала по виду XP */
function kindIcon(kind: string, amount: number) {
  switch (kind) {
    case 'comment':
      return { Icon: MessageCircle, cls: 'text-tg-link' }
    case 'like':
      return { Icon: Heart, cls: 'text-rose-500' }
    case 'quest':
      return { Icon: ListChecks, cls: 'text-emerald-600' }
    case 'checkin':
      return { Icon: CalendarCheck, cls: 'text-emerald-600' }
    case 'bug':
      return { Icon: Bug, cls: 'text-amber-500' }
    case 'violation':
      return { Icon: ShieldAlert, cls: 'text-red-500' }
    default:
      return { Icon: Sparkles, cls: 'text-tg-hint' }
  }
}

export function LevelSheet({
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
  const [data, setData] = useState<LevelResponse | null>(null)
  const [failed, setFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  // Загрузка при открытии (AbortController — быстрый тап туда-обратно не оставит гонок).
  // setState только в колбэках промиса — правило react-hooks/set-state-in-effect.
  useEffect(() => {
    if (!open || isGuest) return
    const ac = new AbortController()
    api<LevelResponse>('/api/level', { signal: ac.signal })
      .then((d) => {
        setData(d)
        setFailed(false)
      })
      .catch((e: unknown) => {
        if ((e as Error)?.name !== 'AbortError') setFailed(true)
      })
    return () => ac.abort()
  }, [open, isGuest, reloadKey])

  // Свежие данные поверх кэша: levelProgress считаем на клиенте от ответа
  const p = data ? levelProgress(data.xp, data.level) : null

  const earnRows: { Icon: typeof MessageCircle; label: string; value: string; cls: string }[] = [
    { Icon: MessageCircle, label: t('level.commentRow'), value: `+${2} XP`, cls: 'text-tg-link' },
    { Icon: Heart, label: t('level.likeRow'), value: `+${1} XP`, cls: 'text-rose-500' },
    { Icon: ListChecks, label: t('level.questRow'), value: `+${5} XP`, cls: 'text-emerald-600' },
    { Icon: CalendarCheck, label: t('level.checkinRow'), value: `+${3} XP`, cls: 'text-emerald-600' },
    { Icon: Bug, label: t('level.bugRow'), value: `+10…+${1000}`, cls: 'text-amber-500' },
    {
      Icon: ShieldAlert,
      label: t('level.violationRow'),
      value: `−15 / −50 XP`,
      cls: 'text-red-500',
    },
  ]

  return (
    // v5.77: subtitle убран — приказ владельца «убери у ника описания и меньше текста»
    <BottomSheet open={open} onClose={onClose} title={t('level.title')}>
      {isGuest ? (
        /* Гость: уровни недоступны — зовём на логин (кнопка открывает модалку ProfileTab) */
        <div className="rounded-2xl bg-tg-surface p-4 text-center">
          <p className="text-[15.5px] font-semibold text-tg-text">{t('level.guestTitle')}</p>
          <p className="mt-1 text-[13.5px] leading-snug text-tg-hint">{t('level.guestHint')}</p>
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
        <div className="space-y-4">
          {/* ---------- Прогресс ---------- */}
          <div className="rounded-2xl bg-tg-surface p-4">
            {p ? (
              <>
                <div className="flex items-center gap-3">
                  <div className="flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-full bg-tg-link text-white">
                    <span className="text-[9px] font-medium leading-none opacity-80">{t('level.short')}</span>
                    <span className="text-[17px] font-bold leading-none">{p.level}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="h-[7px] w-full overflow-hidden rounded-full bg-tg-sep">
                      <div
                        className="h-full rounded-full bg-tg-link transition-[width] duration-500 ease-out"
                        style={{ width: `${Math.round(p.pct * 100)}%` }}
                      />
                    </div>
                    <div className="mt-1.5 flex items-center justify-between text-[12px] text-tg-hint">
                      <span className="tabular-nums">{p.inLevelXp} XP</span>
                      <span className="tabular-nums">
                        {p.needXp} XP {t('level.toNext')}
                      </span>
                    </div>
                  </div>
                </div>
                {/* Награда за следующий уровень — мотивационная строка */}
                <div className="mt-3 flex items-center justify-between rounded-xl bg-tg-bg px-3 py-2">
                  <span className="text-[12.5px] text-tg-hint">
                    {t('level.rewardForLevel')} {p.level + 1}
                  </span>
                  <span className="text-[13px] font-bold text-tg-link tabular-nums">
                    +{p.nextRewardSwipes} свайпов
                  </span>
                </div>
                {/* Дневные лимиты (сегодня засчитано) — v5.77: убрано (лишний текст) */}
              </>
            ) : (
              <div className="tg-shimmer h-20 rounded-xl" aria-hidden />
            )}
          </div>

          {/* ---------- Как получать XP ---------- */}
          <div>
            <h3 className="mb-2 px-1 text-[13px] font-semibold uppercase tracking-wide text-tg-hint">
              {t('level.howTo')}
            </h3>
            <div className="overflow-hidden rounded-2xl bg-tg-surface">
              {earnRows.map(({ Icon, label, value, cls }, i) => (
                <div
                  key={label}
                  className={`flex items-center gap-3 px-3.5 py-2.5 ${
                    i > 0 ? 'border-t border-tg-sep' : ''
                  }`}
                >
                  <Icon className={`h-4.5 w-4.5 shrink-0 ${cls}`} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium text-tg-text">{label}</div>
                  </div>
                  <span className={`shrink-0 text-[13px] font-bold tabular-nums ${amountCls(value)}`}>{value}</span>
                </div>
              ))}
            </div>
            {/* v5.77: сноска под списком убрана (лишний текст) */}
          </div>

          {/* ---------- История ---------- */}
          <div>
            <h3 className="mb-2 px-1 text-[13px] font-semibold uppercase tracking-wide text-tg-hint">
              {t('level.history')}
            </h3>
            <div className="max-h-72 overflow-y-auto rounded-2xl bg-tg-surface">
              {!data && !failed && (
                <div className="space-y-2 p-3" aria-hidden>
                  <div className="tg-shimmer h-8 rounded-lg" />
                  <div className="tg-shimmer h-8 rounded-lg" />
                  <div className="tg-shimmer h-8 rounded-lg" />
                </div>
              )}
              {failed && (
                <button
                  type="button"
                  onClick={() => setReloadKey((k) => k + 1)}
                  className="w-full py-4 text-[14px] font-medium text-tg-link"
                >
                  Повторить
                </button>
              )}
              {data && data.history.length === 0 && (
                <p className="px-3.5 py-4 text-center text-[13px] text-tg-hint">{t('level.empty')}</p>
              )}
              {data &&
                data.history.map((h, i) => {
                  const { Icon, cls } = kindIcon(h.kind, h.amount)
                  return (
                    <div
                      key={h.id}
                      className={`flex items-center gap-3 px-3.5 py-2.5 ${
                        i > 0 ? 'border-t border-tg-sep' : ''
                      }`}
                    >
                      <Icon className={`h-4 w-4 shrink-0 ${cls}`} aria-hidden />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] text-tg-text">{h.note ?? h.kind}</div>
                        <div className="text-[11px] text-tg-hint">
                          {new Date(h.createdAt).toLocaleString('ru-RU', {
                            day: 'numeric',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </div>
                      </div>
                      <span
                        className={`shrink-0 text-[13px] font-bold tabular-nums ${
                          h.amount >= 0 ? 'text-emerald-600' : 'text-red-500'
                        }`}
                      >
                        {h.amount >= 0 ? `+${h.amount}` : h.amount} XP
                      </span>
                    </div>
                  )
                })}
            </div>
          </div>
        </div>
      )}
    </BottomSheet>
  )
}

/** Значения в списке «как получать»: штрафы красным, остальное — как у иконки */
function amountCls(value: string): string {
  return value.startsWith('−') || value.startsWith('-') ? 'text-red-500' : 'text-tg-text'
}
