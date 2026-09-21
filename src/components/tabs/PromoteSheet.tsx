'use client'

import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { BarChart3, Crown, Loader2, Megaphone, ShieldCheck, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { haptic, openTelegram } from '@/lib/tg'
import { formatCount } from '@/lib/format'
import type { AdminStatsDTO, AdsPlatformStats } from '@/lib/types'

const CREATOR = 'tgswipe_bot'

/**
 * Форматы продвижения. Ключевая ценность для рекламодателя — не «покажемся»,
 * а измеримый результат: CPA-кампания платит только за уникальные переходы
 * (эскроу-бюджет), premium-канал в топе ранжирования (×3 к весу постов)
 * и прозрачная статистика каждой кампании.
 */
const FORMATS = [
  {
    id: 'feed',
    icon: Megaphone,
    title: 'Реклама за переходы (CPA)',
    price: 'от 3 свайпов / переход',
    note: 'карточка в ленте · платите только за уникальных читателей, бюджет в эскроу',
  },
  {
    id: '7d',
    icon: Crown,
    title: 'Premium · 7 дней',
    price: '990 свайпов',
    note: 'канал в топе ленты, ×3 к показам постов',
  },
  {
    id: '30d',
    icon: Crown,
    title: 'Premium · 30 дней',
    price: '2 990 свайпов',
    note: 'выгоднее на 55% + золотое кольцо аватара',
  },
] as const

/**
 * Шит «Продвинуть канал»: живой охват площадки, форматы и прямая связь
 * с создателем. Статистика тянется из /api/ads/stats (кэш 60с).
 */
export function PromoteSheet({
  open,
  onClose,
  channels,
}: {
  open: boolean
  onClose: () => void
  channels: AdminStatsDTO[]
}) {
  const [channelId, setChannelId] = useState<string>('')
  const [format, setFormat] = useState<string>('feed')
  const [stats, setStats] = useState<AdsPlatformStats | null>(null)

  // Живой охват площадки: загружаем при каждом открытии шита.
  // Пока летит запрос — показываем прежний ответ (или «считаем охват»)
  useEffect(() => {
    if (!open) return
    let cancelled = false
    api<AdsPlatformStats>('/api/ads/stats')
      .then((r) => {
        if (!cancelled) setStats(r)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [open])

  // Esc на сайте закрывает панель (на ПК это центрированный диалог)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const activeChannelId = channelId || channels[0]?.channelId || ''
  const activeFormat = useMemo(() => FORMATS.find((f) => f.id === format) ?? FORMATS[0], [format])

  const contact = () => {
    haptic('success')
    openTelegram(CREATOR)
    onClose()
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[60] flex flex-col justify-end lg:justify-center lg:px-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Продвижение канала"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 320 }}
            className="relative mx-auto max-h-[92vh] w-full max-w-[520px] overflow-y-auto rounded-t-3xl bg-tg-bg p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-[0_-8px_40px_rgba(0,0,0,0.18)] lg:max-h-[86vh] lg:rounded-3xl lg:pb-6 lg:shadow-[0_24px_80px_rgba(0,0,0,0.28)]"
          >
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-tg-sep lg:hidden" aria-hidden />

            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-tg-star/15">
                <Crown className="h-4.5 w-4.5 text-tg-star" />
              </span>
              <div>
                <div className="text-[16px] font-bold text-tg-text">Прирост подписчиков</div>
                <div className="text-[12px] text-tg-hint">Оплата за охват, статистика открыта</div>
              </div>
            </div>

            {/* Живой охват площадки */}
            <div className="mt-4 rounded-2xl border border-tg-sep/60 bg-tg-surface/60 p-3.5">
              <div className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-tg-hint">
                <BarChart3 className="h-3.5 w-3.5" aria-hidden />
                Охват площадки сейчас
              </div>
              {stats ? (
                <div className="mt-2.5 grid grid-cols-3 gap-2 text-center">
                  <Stat value={formatCount(stats.users)} label="читателей" />
                  <Stat value={formatCount(stats.views24h)} label="просмотров / 24ч" />
                  <Stat value={formatCount(stats.channels)} label="каналов в ленте" />
                </div>
              ) : (
                <div className="mt-3 flex items-center justify-center gap-2 py-1 text-[13px] text-tg-hint">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Считаем охват…
                </div>
              )}
              <p className="mt-2.5 text-[12px] leading-snug text-tg-text2">
                Ваша аудитория — люди, которые уже листают Telegram-ленту каждый день. Мы не
                прячем рекламу: показы и клики каждой кампании фиксируются, и вы видите реальный
                CTR, а не обещания.
              </p>
            </div>

            <div className="mt-4 space-y-4">
              {/* Канал (для premium-форматов) */}
              <div>
                <div className="mb-1.5 text-[12px] font-medium text-tg-hint">Канал</div>
                {channels.length === 0 ? (
                  <p className="text-snippet text-tg-hint">
                    Сначала добавьте свой канал через профиль — затем вернитесь сюда.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {channels.map((c) => (
                      <Pill
                        key={c.channelId}
                        active={activeChannelId === c.channelId}
                        onClick={() => setChannelId(c.channelId)}
                      >
                        {c.title}
                      </Pill>
                    ))}
                  </div>
                )}
              </div>

              {/* Формат */}
              <div>
                <div className="mb-1.5 text-[12px] font-medium text-tg-hint">Формат</div>
                <div className="space-y-2">
                  {FORMATS.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      aria-pressed={format === f.id}
                      onClick={() => {
                        setFormat(f.id)
                        haptic('light')
                      }}
                      className={cn(
                        'flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition',
                        format === f.id
                          ? 'border-tg-star bg-tg-star/10'
                          : 'border-tg-sep bg-tg-surface',
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                          format === f.id ? 'bg-tg-star/15' : 'bg-tg-sep/50',
                        )}
                      >
                        <f.icon
                          className={cn(
                            'h-4.5 w-4.5',
                            format === f.id ? 'text-tg-star' : 'text-tg-hint',
                          )}
                          aria-hidden
                        />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-baseline justify-between gap-x-2">
                          <span className="text-[14.5px] font-semibold text-tg-text">{f.title}</span>
                          <span className="whitespace-nowrap text-[14.5px] font-bold text-tg-star">
                            {f.price}
                          </span>
                        </span>
                        <span className="mt-0.5 block text-[12px] leading-snug text-tg-hint">
                          {f.note}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Гарантии */}
              <div className="flex items-start gap-2.5 rounded-xl bg-tg-surface/60 p-3.5">
                <ShieldCheck className="mt-0.5 h-4.5 w-4.5 shrink-0 text-tg-link" aria-hidden />
                <p className="text-[12.5px] leading-snug text-tg-text2">
                  Посты канала поднимаются в топ ленты — платите только за уникальных читателей.
                  Отчёт по показам и кликам — после каждой кампании.
                </p>
              </div>

              <button
                type="button"
                onClick={contact}
                className="press h-12 w-full rounded-xl bg-tg-star text-[15px] font-bold text-white"
              >
                <span className="inline-flex items-center gap-2">
                  <Sparkles className="h-4 w-4" />
                  Запустить кампанию
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  haptic('light')
                  onClose()
                  useApp.getState().goToTab('channel')
                }}
                className="press h-11 w-full rounded-xl bg-tg-link/10 text-[14.5px] font-semibold text-tg-link"
              >
                Самостоятельно во вкладке «Мой канал»
              </button>
              <p className="text-center text-[11px] leading-snug text-tg-hint">
                1 свайп = 1 ₽ · CPA: бюджет в эскроу, списание за уникальные переходы · {activeFormat.title}
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-xl bg-tg-bg px-1 py-2.5">
      <div className="text-[17px] font-bold leading-none tabular-nums text-tg-text">{value}</div>
      <div className="mt-1 text-[10.5px] leading-tight text-tg-hint">{label}</div>
    </div>
  )
}

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => {
        onClick()
        haptic('light')
      }}
      className={cn(
        'rounded-full px-3.5 py-2 text-[13px] font-medium transition active:scale-95',
        active ? 'bg-tg-link text-white' : 'bg-tg-surface text-tg-text2',
      )}
    >
      {children}
    </button>
  )
}
