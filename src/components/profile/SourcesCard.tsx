'use client'

import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Forward, Plus, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { haptic } from '@/lib/tg'

/**
 * ИСТОЧНИКИ РЕКОМЕНДАЦИЙ (v5.50) — механика «В один клик».
 *
 * Юзер пересылает боту по одному свежему посту из 5 любимых каналов
 * («где ты сидишь каждый день»). Бот извлекает каналы из пересланных
 * сообщений и складывает их в профиль — лента персонализируется под
 * реальные привычки чтения, а за 5 каналов начисляется билет в розыгрыш.
 *
 * Самодостаточный компонент: сам тянет /api/giveaway (sources + botUsername).
 * Рендерится только привязанным к Telegram юзерам.
 */

type SourcesDTO = {
  count: number
  goal: number
  channels: string[]
}

type GiveawayResponse = {
  giveaway: unknown | null
  sources: SourcesDTO
  botUsername: string | null
}

export function SourcesCard() {
  const user = useApp((s) => s.user)
  const [data, setData] = useState<SourcesDTO | null>(null)
  const [botUsername, setBotUsername] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  const load = useCallback(() => {
    if (!user || user.isGuest) return
    // giveaway может быть null — sources приходят всегда
    api<GiveawayResponse>('/api/giveaway')
      .then((r) => {
        if (r.sources) setData(r.sources)
        setBotUsername(r.botUsername ?? null)
      })
      .catch(() => {
        // карточка необязательна — тишину не показываем
      })
  }, [user])

  useEffect(() => {
    void load()
  }, [load, reload])

  // Пересылки обрабатываются ботом: когда юзер возвращается в миниапп
  // из чата с ботом — данные обновляются
  useEffect(() => {
    if (!user || user.isGuest) return
    const onVis = () => {
      if (document.visibilityState === 'visible') setReload((n) => n + 1)
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [user])

  if (!user || user.isGuest) return null
  if (!data) return null

  const done = data.count >= data.goal
  const pct = Math.min(100, Math.round((data.count / Math.max(1, data.goal)) * 100))
  const botLink = botUsername ? `https://t.me/${botUsername}` : 'https://t.me/tgswipe_bot'
  const extra = Math.max(0, data.channels.length - 5)

  const openBot = () => {
    haptic('light')
    window.open(botLink, '_blank', 'noopener')
  }

  return (
    <section className="pt-7" aria-label="Источники рекомендаций">
      <div className="px-4">
        <h2 className="text-[19px] font-bold text-tg-text">Источники рекомендаций</h2>
      </div>

      <div className="mx-4 mt-3 overflow-hidden rounded-2xl border border-emerald-200/70 bg-gradient-to-br from-emerald-50 to-teal-50 dark:border-emerald-500/20 dark:from-emerald-500/10 dark:to-teal-500/5">
        {/* Шапка */}
        <div className="flex items-center gap-3 px-4 pt-3.5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-500/15">
            <Forward className="h-5 w-5 text-emerald-600 dark:text-emerald-400" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[15.5px] font-bold leading-tight text-tg-text">
              Твои любимые каналы
            </p>
            <p className="text-[12.5px] text-tg-hint">
              {done
                ? 'профиль собран — лента стала точнее'
                : 'перешли посты — лента подстроится под тебя'}
            </p>
          </div>
          <span
            className={cn(
              'flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[13px] font-bold tabular-nums',
              done
                ? 'bg-emerald-500 text-white'
                : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
            )}
          >
            {done ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : null}
            {data.count}/{data.goal}
          </span>
        </div>

        {/* Прогресс */}
        <div className="mt-3 px-4">
          <div className="h-1.5 overflow-hidden rounded-full bg-white/70 dark:bg-white/10">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-2 text-[13px] leading-snug text-tg-hint">
            {done ? (
              <>Билет за этот профиль начислен в активном розыгрыше 🎟 Пересылай ещё — чем больше источников, тем умнее лента.</>
            ) : (
              <>Открой чат с ботом и перешли <b className="text-tg-text">по одному свежему посту</b> из {data.goal - data.count === 1 ? 'одного канала' : `${data.goal - data.count} каналов`}, где ты сидишь каждый день. За полный профиль — билет в розыгрыш 🎟</>
            )}
          </p>
        </div>

        {/* Чипы каналов */}
        {data.channels.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5 px-4">
            {data.channels.slice(0, 5).map((t, i) => (
              <span
                key={`${t}-${i}`}
                className="inline-flex max-w-[46%] items-center gap-1 rounded-full bg-white/80 px-2.5 py-1 text-[12px] font-medium text-tg-text dark:bg-white/10"
              >
                <span className="truncate">{t}</span>
              </span>
            ))}
            {extra > 0 && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-white/80 px-2.5 py-1 text-[12px] font-semibold text-emerald-700 dark:bg-white/10 dark:text-emerald-300">
                <Plus className="h-3 w-3" aria-hidden />
                {extra}
              </span>
            )}
          </div>
        )}

        {/* CTA + обновить */}
        <div className="flex items-center gap-2 px-4 pb-3.5 pt-3">
          <button
            type="button"
            onClick={openBot}
            className="flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-500 text-[14px] font-bold text-white transition active:scale-[0.98]"
          >
            <Forward className="h-4 w-4" aria-hidden />
            {done ? 'Добавить ещё каналы' : 'Переслать посты боту'}
          </button>
          <button
            type="button"
            onClick={() => setReload((n) => n + 1)}
            aria-label="Обновить источники"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/70 text-tg-hint transition active:scale-90 dark:bg-white/5"
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
    </section>
  )
}
