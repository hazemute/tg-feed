'use client'

/**
 * BookmarksSheet (v5.91) — экран «Сохранённые посты».
 *
 * Долгая недоделка: закладка в карточке поста работала, счётчик в профиле был,
 * но САМОГО СПИСКА сохранённого нигде не было (GET /api/bookmarks не вызывался
 * ни одним экраном — бэкенд готов с v5.19). Теперь:
 *   - полный лист-шит по тапу на «Сохранено» в статистике профиля;
 *   - фильтры «Все / Непрочитанные» + кнопка «отметить всё прочитанным»;
 *   - непрочитанные помечены точкой, прочитанные — приглушены;
 *   - тап по посту → отметка «прочитано» (POST /api/bookmark/read) и
 *     PostOverlay с очередью из сохранённых (свайп ←/→ внутри шита);
 *   - убрать из сохранённых можно прямо из списка (иконка закладки справа);
 *   - гость видит CTA входа по Telegram.
 *
 * Устройство: SWR-кэш уровня модуля (паттерн профиля) — повторное открытие
 * мгновенно показывает прошлый список, сеть тихо догоняет.
 */

import { useCallback, useEffect, useState } from 'react'
import { Bookmark, CheckCheck, ChevronRight } from 'lucide-react'
import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { useApp } from '@/lib/store'
import { haptic, userAvatarUrl } from '@/lib/tg'
import { cn } from '@/lib/utils'
import { timeAgoRu } from '@/lib/format'
import type { PostDTO } from '@/lib/types'
import { Avatar } from '@/components/tg/Avatar'
import { BottomSheet } from '@/components/tg/BottomSheet'
import { VerifiedBadge } from '@/components/tg/VerifiedBadge'

/** Элемент списка: пост + отметка прочтения (зеркало BookmarkItemDTO API) */
export type BookmarkItem = PostDTO & { readAt: string | null }

type BmFilter = 'all' | 'unread'

/** SWR-кэш модуля: профиль размонтируется — без кэша каждый вход мигал бы скелетонами */
let bmCache: { items: BookmarkItem[]; at: number } | null = null

export function BookmarksSheet({
  open,
  onClose,
  onLogin,
}: {
  open: boolean
  onClose: () => void
  /** Открыть вход по Telegram (гостю); модалка живёт в ProfileTab */
  onLogin?: () => void
}) {
  const t = useT()
  const lang = useApp((s) => s.lang)
  const user = useApp((s) => s.user)
  const openPost = useApp((s) => s.openPost)
  const setPostQueue = useApp((s) => s.setPostQueue)

  const [items, setItems] = useState<BookmarkItem[]>(() => bmCache?.items ?? [])
  const [filter, setFilter] = useState<BmFilter>('all')
  const [failed, setFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  // Загрузка при открытии. setState — только в колбэках промиса
  // (правило react-hooks/set-state-in-effect).
  useEffect(() => {
    if (!open) return
    const ac = new AbortController()
    api<{ items: BookmarkItem[] }>('/api/bookmarks', { signal: ac.signal })
      .then((d) => {
        bmCache = { items: d.items, at: Date.now() }
        setItems(d.items)
        setFailed(false)
      })
      .catch((e: unknown) => {
        if ((e as Error)?.name !== 'AbortError') setFailed(true)
      })
    return () => ac.abort()
  }, [open, reloadKey])

  /** Оптимистичная отметка «прочитано» (fire-and-forget, ответ не нужен) */
  const markRead = useCallback((postId: string) => {
    setItems((prev) => {
      if (prev.some((x) => x.id === postId && x.readAt)) return prev
      void api('/api/bookmark/read', {
        method: 'POST',
        body: JSON.stringify({ postId }),
      }).catch(() => {})
      return prev.map((x) => (x.id === postId && !x.readAt ? { ...x, readAt: new Date().toISOString() } : x))
    })
  }, [])

  /** Убрать из сохранённых прямо из списка (оптимистично; при ошибке — перезагрузка) */
  const unbookmark = useCallback(
    (postId: string) => {
      haptic('light')
      setItems((prev) => prev.filter((x) => x.id !== postId))
      void api('/api/bookmark', {
        method: 'POST',
        body: JSON.stringify({ postId, userId: user?.id }),
      })
        .then(() => {
          // Счётчик в статистике профиля устарел — профиль обновится по событию
          window.dispatchEvent(new CustomEvent('tgfeed:bookmarks-changed'))
        })
        .catch(() => setReloadKey((k) => k + 1))
    },
    [user?.id],
  )

  /** Открыть пост: очередь = сохранённые (свайп ←/→ по ним), тап = прочитано */
  const openItem = useCallback(
    (item: BookmarkItem, list: BookmarkItem[]) => {
      haptic('light')
      markRead(item.id)
      setPostQueue(list.map(({ readAt: _readAt, ...p }) => p))
      openPost(item)
    },
    [markRead, openPost, setPostQueue],
  )

  /** Отметить все прочитанными (кнопка в тулбаре) */
  const markAllRead = useCallback(() => {
    haptic('light')
    setItems((prev) => {
      if (!prev.some((x) => !x.readAt)) return prev
      void api('/api/bookmark/read', { method: 'POST', body: JSON.stringify({ all: true }) }).catch(() => {})
      return prev.map((x) => (x.readAt ? x : { ...x, readAt: new Date().toISOString() }))
    })
  }, [])

  const isGuest = !user || user.isGuest
  const unreadCount = items.reduce((n, x) => n + (x.readAt ? 0 : 1), 0)
  const shown = filter === 'unread' ? items.filter((x) => !x.readAt) : items
  const loading = open && items.length === 0 && !failed

  return (
    <BottomSheet open={open} onClose={onClose} title={t('bm.title')} subtitle={t('bm.subtitle')} variant="full"
      toolbar={
        !isGuest && items.length > 0 ? (
          <div className="shrink-0 border-b border-tg-sep bg-tg-bg px-4 pb-2 pt-2" role="group" aria-label={t('bm.filterAria')}>
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <div className="no-scrollbar flex gap-2 overflow-x-auto">
                  <FilterChip active={filter === 'all'} onClick={() => { haptic('light'); setFilter('all') }}>
                    {t('bm.all')} · {items.length}
                  </FilterChip>
                  <FilterChip active={filter === 'unread'} onClick={() => { haptic('light'); setFilter('unread') }}>
                    {t('bm.unread')} · {unreadCount}
                  </FilterChip>
                </div>
                <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-7 bg-gradient-to-l from-tg-bg to-transparent" />
              </div>
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={markAllRead}
                  aria-label={t('bm.markRead')}
                  className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-tg-surface px-3 text-[13px] font-semibold text-tg-text transition active:scale-95"
                >
                  <CheckCheck className="h-4 w-4" aria-hidden />
                  {t('bm.markRead')}
                </button>
              )}
            </div>
          </div>
        ) : null
      }
    >
      <div className="space-y-3">
        {/* ---------- Гость: CTA входа ---------- */}
        {isGuest ? (
          <div className="rounded-2xl bg-tg-surface p-4 text-center">
            <Bookmark className="mx-auto h-8 w-8 text-tg-hint" aria-hidden />
            <p className="mt-2 text-[15px] font-semibold text-tg-text">{t('bm.guestTitle')}</p>
            <p className="mt-1 text-[13px] leading-snug text-tg-hint">{t('bm.guestHint')}</p>
            <button
              type="button"
              onClick={() => {
                haptic('light')
                onClose()
                onLogin?.()
              }}
              className="press mx-auto mt-3 flex h-10 items-center gap-1.5 rounded-full bg-tg-link px-4 text-[14px] font-bold text-white"
            >
              Вход по Telegram
            </button>
          </div>
        ) : (
          <>
            {/* ---------- Ошибка ---------- */}
            {failed && (
              <button
                type="button"
                onClick={() => setReloadKey((k) => k + 1)}
                className="w-full rounded-2xl bg-tg-surface py-6 text-center text-[14px] font-medium text-tg-link"
              >
                {t('bm.failed')} · {t('bm.retry')}
              </button>
            )}

            {loading && <SkeletonList />}

            {/* ---------- Пусто ---------- */}
            {!loading && !failed && items.length === 0 && (
              <div className="rounded-2xl bg-tg-surface py-10 text-center">
                <Bookmark className="mx-auto h-8 w-8 text-tg-hint" aria-hidden />
                <p className="mt-2 text-[14px] font-medium text-tg-text">{t('bm.empty')}</p>
                <p className="mx-auto mt-1 max-w-[260px] text-[13px] leading-snug text-tg-hint">{t('bm.emptyHint')}</p>
              </div>
            )}

            {/* ---------- Фильтр «непрочитанные» пуст ---------- */}
            {!loading && !failed && items.length > 0 && shown.length === 0 && (
              <div className="rounded-2xl bg-tg-surface py-8 text-center text-[14px] text-tg-hint">
                {t('bm.allRead')}
              </div>
            )}

            {/* ---------- Список ---------- */}
            {shown.length > 0 && (
              <ul className="overflow-hidden rounded-2xl bg-tg-surface" aria-label={t('bm.title')}>
                {shown.map((item, i) => (
                  <li
                    key={item.id}
                    className={cn('flex items-stretch', i > 0 && 'border-t border-tg-sep', !item.readAt && 'bg-tg-link/[0.04]')}
                  >
                    <button
                      type="button"
                      onClick={() => openItem(item, shown)}
                      aria-label={`${item.channel.title} — ${t('user.openProfile')}`}
                      className="flex min-w-0 flex-1 items-start gap-3 px-3.5 py-3 text-left transition active:bg-tg-link/5"
                    >
                      {/* Непрочитанная точка — на месте ранга, знакомый паттерн списков */}
                      <span className="flex w-6 shrink-0 justify-center pt-2.5" aria-hidden>
                        {!item.readAt && <span className="h-2 w-2 rounded-full bg-tg-link" />}
                      </span>
                      <Avatar
                        name={item.channel.title}
                        src={userAvatarUrl(item.channel.id, item.channel.avatarUrl)}
                        size={40}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className="flex min-w-0 items-center gap-1">
                            <span className="truncate text-[14.5px] font-semibold text-tg-text">{item.channel.title}</span>
                            {item.channel.verified && <VerifiedBadge size={13} />}
                          </span>
                          <span className="shrink-0 text-[12px] text-tg-hint">
                            {lang === 'ru' ? timeAgoRu(item.publishedAt) : ''}
                          </span>
                        </span>
                        <span className={cn('mt-0.5 line-clamp-2 block text-[13.5px] leading-snug', item.readAt ? 'text-tg-hint/70' : 'text-tg-hint')}>
                          {item.text ? item.text.slice(0, 220) : 'Медиа-пост'}
                        </span>
                      </span>
                      <ChevronRight className="mt-2 h-4 w-4 shrink-0 text-tg-hint" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => unbookmark(item.id)}
                      aria-label={t('bm.remove')}
                      className="flex w-11 shrink-0 items-center justify-center text-tg-hint transition active:scale-90"
                    >
                      <Bookmark className="h-[18px] w-[18px] fill-tg-link text-tg-link" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </BottomSheet>
  )
}

/* ---------- Чип фильтра ---------- */

function FilterChip({
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
      onClick={onClick}
      className={cn(
        'flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13.5px] font-semibold transition active:scale-95',
        active ? 'bg-tg-link text-white' : 'bg-tg-surface text-tg-text',
      )}
    >
      {children}
    </button>
  )
}

/* ---------- Скелетон ---------- */

function SkeletonList() {
  return (
    <div className="space-y-2 rounded-2xl bg-tg-surface p-3" aria-hidden>
      {Array.from({ length: 7 }).map((_, i) => (
        <div key={i} className="tg-shimmer h-16 rounded-xl" />
      ))}
    </div>
  )
}
