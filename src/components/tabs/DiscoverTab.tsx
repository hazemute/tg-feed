'use client'

import { useEffect, useMemo, useState } from 'react'
import { Search, X } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { pluralRu, timeAgoRu } from '@/lib/format'
import { haptic, openTelegram } from '@/lib/tg'
import type { PostDTO, SearchResponse, SubscriptionDTO } from '@/lib/types'
import { Avatar } from '@/components/tg/Avatar'

/** Глубокие градиенты карточек тематик (без неона) */
const GRADIENTS: Record<string, string> = {
  crypto: 'from-[#b45309] to-[#7c2d12]',
  news: 'from-[#1d4ed8] to-[#172554]',
  it: 'from-[#047857] to-[#134e4a]',
  humor: 'from-[#be123c] to-[#4c0519]',
  business: 'from-[#7c3aed] to-[#3b0764]',
  travel: 'from-[#0e7490] to-[#083344]',
  food: 'from-[#c2410c] to-[#431407]',
  sport: 'from-[#15803d] to-[#052e16]',
  other: 'from-[#475569] to-[#1e293b]',
}

/**
 * Экран «Каталог & Темы»:
 * поиск по ключевым словам внутри постов, градиентная сетка категорий,
 * управление подписками (скрыть из ленты / отписаться).
 */
export function DiscoverTab() {
  const { user } = useApp()

  return (
    <div className="no-scrollbar h-full overflow-y-auto overscroll-contain pb-6">
      <SearchSection />
      <CategoryGrid />
      {user && <SubscriptionsManager />}
    </div>
  )
}

/* ---------- Поиск по постам ---------- */

function SearchSection() {
  const { user } = useApp()
  const [q, setQ] = useState('')
  const [data, setData] = useState<{ q: string; items: PostDTO[] } | null>(null)
  const [searching, setSearching] = useState(false)

  const needle = q.trim()
  const results = data && data.q === needle && needle.length >= 2 ? data.items : null
  const busy = needle.length >= 2 && (searching || results === null)

  useEffect(() => {
    if (needle.length < 2) return
    let cancelled = false
    const t = setTimeout(() => {
      setSearching(true)
      const qs = new URLSearchParams({ q: needle })
      if (user) qs.set('userId', user.id)
      api<SearchResponse>(`/api/search?${qs.toString()}`)
        .then((r) => {
          if (!cancelled) setData({ q: needle, items: r.items })
        })
        .catch(() => {
          if (!cancelled) toast.error('Поиск недоступен')
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [needle, user?.id])  

  return (
    <section className="px-4 pt-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-tg-hint" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Поиск по текстам постов"
          aria-label="Поиск по постам"
          className="h-10 w-full rounded-xl border border-transparent bg-tg-surface pl-9 pr-9 text-snippet text-tg-text outline-none placeholder:text-tg-hint focus:border-tg-link"
        />
        {q && (
          <button
            type="button"
            onClick={() => setQ('')}
            aria-label="Очистить"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-tg-hint"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {needle.length >= 2 && (
        <div className="mt-3">
          {busy ? (
            <p className="px-1 py-3 text-snippet text-tg-hint">Ищем…</p>
          ) : results !== null && results.length === 0 ? (
            <p className="px-1 py-3 text-snippet text-tg-hint">
              По запросу «{needle}» ничего не найдено
            </p>
          ) : results !== null ? (
            <>
              <p className="px-1 pb-2 text-[12px] text-tg-hint">
                Найдено: {results.length}{' '}
                {pluralRu(results.length, 'пост', 'поста', 'постов')}
              </p>
              <div className="space-y-2">
                {results.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => openTelegram(p.link || p.channel.username)}
                    className="flex w-full items-start gap-3 rounded-xl bg-tg-surface p-3 text-left transition active:scale-[0.99]"
                  >
                    <Avatar name={p.channel.title} color={p.channel.avatarColor} src={p.channel.avatarUrl} size={38} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="truncate text-[14px] font-semibold text-tg-text">
                          {p.channel.title}
                        </span>
                        <span className="shrink-0 text-[11px] text-tg-hint">
                          {timeAgoRu(p.publishedAt)}
                        </span>
                      </span>
                      <span className="text-snippet mt-0.5 line-clamp-3 block text-tg-hint">
                        {p.text || 'медиа-пост'}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
      )}
    </section>
  )
}

/* ---------- Градиентная сетка категорий ---------- */

function CategoryGrid() {
  const { categories, setCategory, setTab, user } = useApp()

  return (
    <section className="px-4 pt-4">
      <h2 className="px-1 pb-2 text-[13px] font-semibold uppercase tracking-wide text-tg-hint">
        Темы
      </h2>
      <div className="grid grid-cols-2 gap-2.5">
        {categories.map((c) => (
          <button
            key={c.slug}
            type="button"
            onClick={() => {
              haptic('light')
              setCategory(c.slug)
              setTab('feed')
            }}
            className={cn(
              'flex h-24 flex-col justify-between rounded-2xl bg-gradient-to-br p-3.5 text-left text-white transition active:scale-[0.97]',
              GRADIENTS[c.slug] ?? GRADIENTS.other,
            )}
          >
            <span className="text-[15px] font-semibold leading-tight">{c.title}</span>
            <span className="text-[12px] leading-tight text-white/75">
              {c.todayCount > 0
                ? `${c.todayCount} ${pluralRu(c.todayCount, 'новый пост', 'новых поста', 'новых постов')} за сегодня`
                : `${c.channelCount} ${pluralRu(c.channelCount, 'канал', 'канала', 'каналов')}`}
            </span>
          </button>
        ))}
        {categories.length === 0 &&
          [...Array(6)].map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl bg-tg-surface" />
          ))}
      </div>
    </section>
  )
}

/* ---------- Управление подписками ---------- */

function SubscriptionsManager() {
  const { user } = useApp()
  const [subs, setSubs] = useState<SubscriptionDTO[] | null>(null)

  useEffect(() => {
    if (!user) return
    api<{ items: SubscriptionDTO[] }>(`/api/subscriptions?userId=${encodeURIComponent(user.id)}`)
      .then((d) => setSubs(d.items))
      .catch(() => setSubs([]))
  }, [user?.id])  

  const toggleHidden = async (s: SubscriptionDTO) => {
    if (!user) return
    const next = !s.hidden
    setSubs((prev) => (prev ?? []).map((x) => (x.channelId === s.channelId ? { ...x, hidden: next } : x)))
    haptic('light')
    try {
      await api('/api/subscription/visibility', {
        method: 'POST',
        body: JSON.stringify({ userId: user.id, channelId: s.channelId, hidden: next }),
      })
      toast.success(next ? `${s.channel.title} скрыт из ленты` : `${s.channel.title} вернулся в ленту`)
    } catch {
      setSubs((prev) => (prev ?? []).map((x) => (x.channelId === s.channelId ? { ...x, hidden: !next } : x)))
      toast.error('Не удалось изменить')
    }
  }

  const unsubscribe = async (s: SubscriptionDTO) => {
    if (!user) return
    setSubs((prev) => (prev ?? []).filter((x) => x.channelId !== s.channelId))
    try {
      await api('/api/subscribe', {
        method: 'POST',
        body: JSON.stringify({ userId: user.id, channelId: s.channelId }),
      })
      toast(`Вы отписались от @${s.channel.username}`)
    } catch {
      toast.error('Не удалось отписаться')
    }
  }

  return (
    <section className="px-4 pt-5">
      <h2 className="px-1 pb-2 text-[13px] font-semibold uppercase tracking-wide text-tg-hint">
        Мои подписки
      </h2>
      {subs === null ? (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-tg-surface" />
          ))}
        </div>
      ) : subs.length === 0 ? (
        <div className="rounded-xl bg-tg-surface p-4 text-snippet text-tg-hint">
          Вы пока не подписаны на каналы. Тапните [+] в ленте — и канал появится здесь.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl bg-tg-surface">
          {subs.map((s) => (
            <div
              key={s.channelId}
              className="flex items-center gap-3 border-b border-tg-bg px-3.5 py-2.5 last:border-b-0"
            >
              <button
                type="button"
                onClick={() => openTelegram(s.channel.username)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                aria-label={`Открыть канал ${s.channel.title}`}
              >
                <Avatar name={s.channel.title} color={s.channel.avatarColor} src={s.channel.avatarUrl} size={42} />
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-medium text-tg-text">
                    {s.channel.title}
                  </span>
                  <span className="block truncate text-[12px] text-tg-hint">
                    @{s.channel.username}
                    {s.hidden && <span className="ml-1.5 text-tg-hint/70">· скрыт</span>}
                  </span>
                </span>
              </button>
              <HiddenSwitch
                checked={s.hidden}
                onChange={() => toggleHidden(s)}
                label={`Скрыть ${s.channel.title} из ленты`}
              />
              <button
                type="button"
                onClick={() => unsubscribe(s)}
                aria-label={`Отписаться от ${s.channel.title}`}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-tg-surface2 text-tg-hint transition active:scale-90"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function HiddenSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: () => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={cn(
        'relative h-6 w-10 shrink-0 rounded-full transition-colors',
        checked ? 'bg-tg-link' : 'bg-tg-surface2',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all',
          checked ? 'left-[18px]' : 'left-0.5',
        )}
      />
    </button>
  )
}
