'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bell, BellOff, ChevronRight, Eye, EyeOff, Loader2, RefreshCw, Search, UserMinus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { formatCount, pluralRu } from '@/lib/format'
import { haptic } from '@/lib/tg'
import { Avatar } from '@/components/tg/Avatar'
import type { SubscriptionDTO } from '@/lib/types'

/**
 * УПРАВЛЕНИЕ ПОДПИСКАМИ (v5.68) — секция вкладки «Каналы».
 *
 * Переехало из профиля (разгрузка экрана — приказ владельца). Здесь всё
 * про relationship юзера с каналами:
 *  • список подписок с живым поиском;
 *  • колокольчик уведомлений (notify on/off);
 *  • «скрыть из ленты» / вернуть (mute/unmute — канал остаётся в подписках);
 *  • отписка.
 */

export function SubscriptionsSection() {
  const user = useApp((s) => s.user)
  const openChannel = useApp((s) => s.openChannel)
  const setTab = useApp((s) => s.setTab)
  const [subs, setSubs] = useState<SubscriptionDTO[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [q, setQ] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!user || user.isGuest) return
    try {
      const r = await api<{ items: SubscriptionDTO[] }>('/api/subscriptions')
      setSubs(r.items)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [user])

  useEffect(() => {
    void load()
  }, [load])

  const filtered = useMemo(() => {
    const rows = subs ?? []
    const needle = q.trim().toLowerCase()
    if (!needle) return rows
    return rows.filter(
      (s) =>
        s.channel.title.toLowerCase().includes(needle) ||
        (s.channel.username ?? '').toLowerCase().includes(needle),
    )
  }, [subs, q])

  const act = async (
    s: SubscriptionDTO,
    action: 'notify' | 'mute' | 'unmute' | 'unsubscribe',
  ) => {
    if (busyId) return
    setBusyId(s.channelId)
    haptic('light')
    // оптимистично
    setSubs((prev) => {
      if (!prev) return prev
      if (action === 'unsubscribe') return prev.filter((x) => x.channelId !== s.channelId)
      return prev.map((x) => {
        if (x.channelId !== s.channelId) return x
        if (action === 'notify') return { ...x, notify: !x.notify }
        if (action === 'mute') return { ...x, hidden: true }
        return { ...x, hidden: false }
      })
    })
    try {
      await api('/api/subscribe', {
        method: 'POST',
        body: JSON.stringify({ channelId: s.channelId, action }),
      })
      if (action === 'unsubscribe') toast(`Канал «${s.channel.title}» удалён из подписок`)
      if (action === 'mute') toast(`«${s.channel.title}» скрыт из ленты`)
      if (action === 'unmute') toast(`«${s.channel.title}» снова в ленте`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не получилось')
      void load() // откат к серверному состоянию
    } finally {
      setBusyId(null)
    }
  }

  if (!user || user.isGuest) {
    return (
      <section aria-label="Мои подписки">
        <SectionHead />
        <div className="mt-3 rounded-2xl bg-tg-surface px-4 py-6 text-center">
          <p className="text-[14.5px] text-tg-hint">
            Подписки доступны после входа через Telegram
          </p>
        </div>
      </section>
    )
  }

  return (
    <section aria-label="Мои подписки">
      <SectionHead
        count={subs?.length}
        onReload={() => {
          setSubs(null)
          void load()
        }}
      />

      {/* Поиск по подпискам */}
      {subs !== null && subs.length > 4 && (
        <div className="relative mt-3">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-tg-hint" aria-hidden />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Найти среди подписок…"
            aria-label="Поиск по подпискам"
            className="h-10 w-full rounded-xl border border-tg-sep/70 bg-tg-surface pl-10 pr-9 text-[14.5px] text-tg-text outline-none placeholder:text-tg-hint focus:border-tg-link/40"
          />
          {q && (
            <button
              type="button"
              onClick={() => setQ('')}
              aria-label="Очистить поиск"
              className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-tg-hint active:scale-90"
            >
              <UserMinus className="hidden" aria-hidden />
              <span className="text-[15px] leading-none">×</span>
            </button>
          )}
        </div>
      )}

      <div className="mt-1">
        {subs === null && !failed ? (
          <div className="space-y-3 px-1 pt-3" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3 rounded-2xl bg-tg-surface/60 p-3">
                <div className="tg-shimmer h-12 w-12 rounded-full" />
                <div className="flex-1 space-y-2">
                  <div className="tg-shimmer h-3.5 w-1/3 rounded" />
                  <div className="tg-shimmer h-3 w-1/4 rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : failed ? (
          <div className="mt-3 rounded-2xl bg-tg-surface px-4 py-6 text-center">
            <p className="text-[14.5px] text-tg-hint">Не удалось загрузить подписки</p>
            <button
              type="button"
              onClick={() => {
                setSubs(null)
                void load()
              }}
              className="press mt-2 h-10 rounded-full bg-tg-link px-5 text-[14px] font-semibold text-white"
            >
              <RefreshCw className="mr-1 inline h-4 w-4" aria-hidden /> Повторить
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="mt-3 rounded-2xl bg-tg-surface px-4 py-7 text-center">
            <p className="text-[15px] font-semibold text-tg-text">
              {subs?.length ? 'Ничего не найдено' : 'Вы пока ни на кого не подписаны'}
            </p>
            <p className="mt-1 text-snippet text-tg-hint">
              {subs?.length ? 'Попробуйте другой запрос' : 'Подпишитесь на каналы — они появятся здесь'}
            </p>
            {!subs?.length && (
              <button
                type="button"
                onClick={() => {
                  haptic('light')
                  setTab('search')
                }}
                className="press mt-3 h-10 rounded-full bg-tg-link px-5 text-[14px] font-semibold text-white"
              >
                Найти каналы
              </button>
            )}
          </div>
        ) : (
          <ul className="overflow-hidden rounded-2xl bg-tg-surface/60">
            {filtered.map((s, i) => (
              <li key={s.channelId} className={cn(i > 0 && 'border-t border-tg-sep/60')}>
                <div className="flex items-center gap-2.5 px-2.5 py-2.5">
                  <button
                    type="button"
                    onClick={() => openChannel(s.channel.username)}
                    aria-label={`Открыть канал ${s.channel.title}`}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                  >
                    <Avatar name={s.channel.title} color={s.channel.avatarColor} src={s.channel.avatarUrl} size={44} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[15.5px] font-semibold text-tg-text">
                          {s.channel.title}
                        </span>
                        {s.hidden && (
                          <span className="shrink-0 rounded-full bg-tg-surface2 px-1.5 py-0.5 text-[10px] font-semibold text-tg-hint">
                            скрыт
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block truncate text-[12.5px] text-tg-hint">
                        {s.channel.subscribersCount > 0
                          ? `${formatCount(s.channel.subscribersCount)} ${pluralRu(s.channel.subscribersCount, 'подписчик', 'подписчика', 'подписчиков')}`
                          : `@${s.channel.username}`}
                      </span>
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-tg-hint" aria-hidden />
                  </button>
                  {/* Действия */}
                  <div className="flex shrink-0 items-center">
                    <IconAction
                      label={s.notify ? 'Уведомления включены' : 'Включить уведомления'}
                      onClick={() => void act(s, 'notify')}
                      busy={busyId === s.channelId}
                    >
                      {s.notify ? (
                        <Bell className="h-4.5 w-4.5 text-tg-link" aria-hidden />
                      ) : (
                        <BellOff className="h-4.5 w-4.5" aria-hidden />
                      )}
                    </IconAction>
                    <IconAction
                      label={s.hidden ? 'Вернуть в ленту' : 'Скрыть из ленты'}
                      onClick={() => void act(s, s.hidden ? 'unmute' : 'mute')}
                      busy={busyId === s.channelId}
                    >
                      {s.hidden ? (
                        <Eye className="h-4.5 w-4.5" aria-hidden />
                      ) : (
                        <EyeOff className="h-4.5 w-4.5" aria-hidden />
                      )}
                    </IconAction>
                    <IconAction
                      label="Отписаться"
                      onClick={() => void act(s, 'unsubscribe')}
                      busy={busyId === s.channelId}
                      danger
                    >
                      <UserMinus className="h-4.5 w-4.5" aria-hidden />
                    </IconAction>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

function SectionHead({ count, onReload }: { count?: number; onReload?: () => void }) {
  return (
    <div className="flex items-center justify-between px-1 pt-1">
      <h2 className="flex items-center gap-2 text-[19px] font-bold text-tg-text">
        Мои подписки
        {typeof count === 'number' && count > 0 && (
          <span className="rounded-full bg-tg-surface px-2 py-0.5 text-[12.5px] font-semibold text-tg-hint tabular-nums">
            {count}
          </span>
        )}
      </h2>
      {onReload && (
        <button
          type="button"
          onClick={onReload}
          aria-label="Обновить подписки"
          className="flex h-8 w-8 items-center justify-center rounded-full text-tg-hint transition active:scale-90 hover:bg-tg-sep/40"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}

function IconAction({
  label,
  onClick,
  children,
  busy,
  danger,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
  busy?: boolean
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={label}
      title={label}
      className={cn(
        'flex h-9 w-9 items-center justify-center rounded-full text-tg-hint transition active:scale-90 active:bg-tg-sep/50 disabled:opacity-50',
        danger && 'active:text-destructive',
      )}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : children}
    </button>
  )
}
