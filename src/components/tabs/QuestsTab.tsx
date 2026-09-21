'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, BadgeCheck, Check, ExternalLink, RefreshCw, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api, apiCached, invalidateApiCache } from '@/lib/api'
import { pluralRu } from '@/lib/format'
import { formatSwipesFull } from '@/lib/money'
import { haptic, tg } from '@/lib/tg'
import { useApp } from '@/lib/store'
import { SwipeIcon } from '@/components/tg/SwipeIcon'

/**
 * Экран «Задания» (v5.51, вместо «Трендов»): подписка на канал / вступление
 * в чат за свайпы. Проверка честная — через Bot API; если юзер получил награду
 * и отписался, сервер аннулирует задание и списывает двойную награду.
 *
 * Паттерн кнопки «в два тапа»: первый тап при not_member открывает цель,
 * после подписки второй тап проверяет и начисляет.
 */

type QuestItem = {
  id: string
  kind: string
  title: string
  description: string | null
  rewardSwp: number
  link: string
  myStatus: 'done' | 'revoked' | null
}

type QuestsResponse = { items: QuestItem[]; balance: number }

const KIND_META: Record<string, { emoji: string; label: string }> = {
  subscribe: { emoji: '📢', label: 'Подписка на канал' },
  join_chat: { emoji: '💬', label: 'Вступление в чат' },
}

export function QuestsTab() {
  const [data, setData] = useState<QuestsResponse | null>(null)
  const [failed, setFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [claimingId, setClaimingId] = useState<string | null>(null)
  const [justDone, setJustDone] = useState<string | null>(null)
  const doneTimer = useRef(0)
  // v5.54: гость не клэймит (сервер всё равно не сможет проверить tgId) —
  // показываем шторку входа; баланс мутаций пишем в общий стор
  const user = useApp((s) => s.user)
  const openAuthGate = useApp((s) => s.openAuthGate)
  const patchBalance = useApp((s) => s.patchBalance)

  const load = useCallback(() => {
    // Клиентский кэш 15с — повторное открытие вкладки мгновенно; claim всегда
    // ходит живьём и мутирует локальный стейт напрямую.
    apiCached<QuestsResponse>('/api/quests', 15_000)
      .then((r) => {
        setData(r)
        setFailed(false)
      })
      .catch(() => {
        setFailed(true)
      })
  }, [])

  useEffect(() => {
    load()
  }, [load, reloadKey])

  // Возврат в миниапп после перехода в канал: обновить статусы
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [load])

  useEffect(() => () => window.clearTimeout(doneTimer.current), [])

  const claim = async (q: QuestItem) => {
    if (claimingId) return
    if (user?.isGuest) {
      openAuthGate('quest')
      return
    }
    setClaimingId(q.id)
    haptic('light')
    try {
      const res = await api<{ status: string; reward?: number; balance?: number; link?: string }>(
        `/api/quests/${q.id}/claim`,
        { method: 'POST' },
      )
      if (res.status === 'done') {
        haptic('success')
        // v5.54: баланс сразу в общий стор (кошелёк в профиле перестал показывать
        // устаревшее значение) + сброс клиентского кэша списка заданий
        patchBalance({ swipes: res.balance ?? 0 })
        invalidateApiCache('/api/quests')
        setData((prev) =>
          prev
            ? {
                items: prev.items.map((it) => (it.id === q.id ? { ...it, myStatus: 'done' } : it)),
                balance: res.balance ?? prev.balance,
              }
            : prev,
        )
        setJustDone(q.id)
        window.clearTimeout(doneTimer.current)
        doneTimer.current = window.setTimeout(() => setJustDone(null), 1600)
        toast.success(`Награда получена: +${res.reward} ${pluralRu(res.reward ?? 0, 'свайп', 'свайпа', 'свайпов')}`)
      } else if (res.status === 'not_member') {
        // Не в цели: открываем канал/чат, после подписки — второй тап
        openTarget(res.link ?? q.link)
        toast.info('Подпишитесь и нажмите кнопку ещё раз — награда зачислится автоматически')
      } else if (res.status === 'already') {
        setData((prev) =>
          prev
            ? {
                items: prev.items.map((it) => (it.id === q.id ? { ...it, myStatus: 'done' as const } : it)),
                balance: prev.balance,
              }
            : prev,
        )
      } else if (res.status === 'revoked') {
        invalidateApiCache('/api/quests')
        setData((prev) =>
          prev
            ? {
                items: prev.items.map((it) => (it.id === q.id ? { ...it, myStatus: 'revoked' as const } : it)),
                balance: prev.balance,
              }
            : prev,
        )
        toast.error('Награда за это задание была аннулирована')
      } else if (res.status === 'cannot_verify') {
        toast.error('Проверка временно недоступна — попробуйте позже')
      } else {
        toast.error('Задание недоступно')
      }
    } catch {
      toast.error('Не удалось выполнить задание')
    } finally {
      setClaimingId(null)
    }
  }

  const totalAvailable = (data?.items ?? [])
    .filter((q) => q.myStatus === null)
    .reduce((s, q) => s + q.rewardSwp, 0)
  const doneCount = (data?.items ?? []).filter((q) => q.myStatus === 'done').length

  return (
    <div className="no-scrollbar h-full w-full overflow-y-auto overscroll-contain pb-24">
      <div className="mx-auto w-full max-w-[1000px]">
        <header className="px-4 pb-3 pt-4">
          <h1 className="text-screen-title text-tg-text">Задания</h1>
          <p className="mt-1 text-[15px] text-tg-hint">Выполняйте задания и получайте свайпы</p>
        </header>

        {failed ? (
          <Empty
            icon={AlertTriangle}
            tone="warn"
            text="Не удалось загрузить задания. Проверьте соединение и попробуйте снова."
            action={
              <button
                type="button"
                onClick={() => {
                  haptic('light')
                  setFailed(false)
                  setReloadKey((k) => k + 1)
                }}
                className="press mt-4 h-10 rounded-full bg-tg-link px-6 text-[14px] font-semibold text-white"
              >
                Повторить
              </button>
            }
          />
        ) : !data ? (
          <QuestsSkeleton />
        ) : (
          <>
            {/* Сводка: доступно к получению + баланс + прогресс */}
            <section className="px-4 pb-1" aria-label="Сводка по заданиям">
              <div className="card-soft rounded-2xl bg-tg-surface p-4">
                <div className="flex items-center gap-3">
                  <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-tg-link/12">
                    <Sparkles className="size-5 text-tg-link" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-semibold leading-tight text-tg-text">
                      {totalAvailable > 0
                        ? `Доступно ${formatSwipesFull(totalAvailable)} ${pluralRu(totalAvailable, 'свайп', 'свайпа', 'свайпов')}`
                        : doneCount > 0
                          ? 'Все задания выполнены 🎉'
                          : 'Пока нет доступных заданий'}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1 text-[12.5px] text-tg-hint">
                      <SwipeIcon className="h-3 w-3" size={12} />
                      <span>
                        Баланс: {formatSwipesFull(data.balance)}{' '}
                        {pluralRu(data.balance, 'свайп', 'свайпа', 'свайпов')}
                        {doneCount > 0 ? ` · выполнено: ${doneCount}` : ''}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      haptic('light')
                      setReloadKey((k) => k + 1)
                    }}
                    aria-label="Обновить задания"
                    className="flex size-9 shrink-0 items-center justify-center rounded-full text-tg-hint transition active:scale-90 hover:bg-tg-sep/40"
                  >
                    <RefreshCw className="size-4" />
                  </button>
                </div>
                {data.items.length > 0 && (
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-tg-sep/50">
                    <motion.div
                      className="h-full rounded-full bg-tg-link"
                      initial={false}
                      animate={{ width: `${(doneCount / data.items.length) * 100}%` }}
                      transition={{ type: 'spring', stiffness: 200, damping: 26 }}
                    />
                  </div>
                )}
              </div>
            </section>

            {/* Список заданий */}
            <section className="pb-6 pt-3" aria-label="Список заданий">
              {data.items.length === 0 ? (
                <Empty
                  icon={Sparkles}
                  text="Новых заданий пока нет — заглядывайте позже, они появляются регулярно."
                />
              ) : (
                <div className="space-y-2.5 px-4">
                  {data.items.map((q, i) => (
                    <QuestCard
                      key={q.id}
                      quest={q}
                      index={i}
                      claiming={claimingId === q.id}
                      justDone={justDone === q.id}
                      onClaim={() => claim(q)}
                    />
                  ))}
                </div>
              )}
            </section>

            <p className="px-8 pb-4 text-center text-[11.5px] leading-relaxed text-tg-hint">
              Награду нельзя получить повторно. Если отписаться от цели после получения, задание
              аннулируется, а награда спишется в двойном размере.
            </p>
          </>
        )}
      </div>
    </div>
  )
}

/* ------------------------------- Карточка ------------------------------- */

function QuestCard({
  quest,
  index,
  claiming,
  justDone,
  onClaim,
}: {
  quest: QuestItem
  index: number
  claiming: boolean
  justDone: boolean
  onClaim: () => void
}) {
  const meta = KIND_META[quest.kind] ?? { emoji: '🎯', label: 'Задание' }
  const done = quest.myStatus === 'done'
  const revoked = quest.myStatus === 'revoked'

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.04, 0.2), duration: 0.25, ease: 'easeOut' }}
      className={cn(
        'card-soft relative overflow-hidden rounded-2xl bg-tg-surface p-4 transition',
        revoked && 'opacity-60',
      )}
    >
      {/* Полоса зачёта слева: зелёная — выполнено, красная — отозвано */}
      {done && <span className="absolute inset-y-0 left-0 w-1 bg-tg-green" aria-hidden />}
      {revoked && <span className="absolute inset-y-0 left-0 w-1 bg-tg-like" aria-hidden />}

      <div className="flex items-start gap-3">
        <div
          className={cn(
            'flex size-11 shrink-0 items-center justify-center rounded-xl text-[20px]',
            done ? 'bg-tg-green/12' : 'bg-tg-link/12',
          )}
          aria-hidden
        >
          {meta.emoji}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-tg-hint">
            {meta.label}
          </div>
          <div className="mt-0.5 text-[15.5px] font-semibold leading-snug text-tg-text">
            {quest.title}
          </div>
          {quest.description && (
            <div className="mt-1 text-[13.5px] leading-snug text-tg-hint">{quest.description}</div>
          )}

          <div className="mt-2.5 flex items-center justify-between gap-2">
            <span
              className={cn(
                'inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-bold',
                done ? 'bg-tg-green/12 text-tg-green' : 'bg-tg-link/12 text-tg-link',
              )}
            >
              <SwipeIcon className="size-3.5" size={14} aria-hidden />+{formatSwipesFull(quest.rewardSwp)}
            </span>

            {done ? (
              <AnimatePresence mode="wait">
                {justDone ? (
                  <motion.span
                    key="done-anim"
                    initial={{ scale: 0.7, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="inline-flex h-9 items-center gap-1.5 rounded-full bg-tg-green px-4 text-[13.5px] font-bold text-white"
                  >
                    <BadgeCheck className="size-4" aria-hidden />
                    Готово!
                  </motion.span>
                ) : (
                  <motion.span
                    key="done"
                    initial={{ scale: 0.9, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="inline-flex h-9 items-center gap-1.5 rounded-full bg-tg-green/12 px-4 text-[13.5px] font-semibold text-tg-green"
                  >
                    <Check className="size-4" strokeWidth={2.6} aria-hidden />
                    Выполнено
                  </motion.span>
                )}
              </AnimatePresence>
            ) : revoked ? (
              <span className="inline-flex h-9 items-center gap-1.5 rounded-full bg-tg-like/12 px-4 text-[13px] font-semibold text-tg-like">
                <AlertTriangle className="size-4" aria-hidden />
                Аннулировано
              </span>
            ) : (
              <button
                type="button"
                onClick={onClaim}
                disabled={claiming}
                aria-label={`Получить награду за задание «${quest.title}»`}
                className={cn(
                  'press inline-flex h-9 items-center gap-1.5 rounded-full bg-tg-link px-4 text-[13.5px] font-bold text-white',
                  claiming && 'opacity-60',
                )}
              >
                {claiming ? (
                  <span
                    className="size-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
                    aria-hidden
                  />
                ) : (
                  <ExternalLink className="size-3.5" aria-hidden />
                )}
                {claiming ? 'Проверяем…' : 'Получить'}
              </button>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  )
}

/** Открыть цель в Telegram (миниапп) или новой вкладке (сайт) */
function openTarget(link: string): void {
  const w = tg()
  if (w?.openTelegramLink) {
    w.openTelegramLink(link)
    return
  }
  window.open(link, '_blank', 'noopener')
}

/* --------------------------- Служебные блоки --------------------------- */

function Empty({
  icon: Icon,
  tone = 'accent',
  text,
  action,
}: {
  icon: typeof Sparkles
  tone?: 'accent' | 'warn'
  text: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center px-8 py-14 text-center">
      <span
        className={cn(
          'flex size-16 items-center justify-center rounded-full',
          tone === 'warn' ? 'bg-tg-star/10 text-tg-star' : 'bg-tg-link/10 text-tg-link',
        )}
        aria-hidden
      >
        <Icon className="size-8" strokeWidth={1.7} />
      </span>
      <p className="mt-3 max-w-[300px] text-[14.5px] leading-relaxed text-tg-hint">{text}</p>
      {action}
    </div>
  )
}

function QuestsSkeleton() {
  return (
    <div aria-hidden>
      <div className="px-4 pb-1">
        <div className="tg-shimmer h-[86px] rounded-2xl" />
      </div>
      <div className="space-y-2.5 px-4 pt-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="rounded-2xl bg-tg-surface p-4">
            <div className="flex items-start gap-3">
              <div className="tg-shimmer size-11 shrink-0 rounded-xl" />
              <div className="min-w-0 flex-1">
                <div className="tg-shimmer h-3 w-24 rounded" />
                <div className="tg-shimmer mt-2 h-4 w-3/4 rounded" />
                <div className="tg-shimmer mt-2 h-3 w-1/2 rounded" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
