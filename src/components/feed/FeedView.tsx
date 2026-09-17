'use client'

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowUp, Bell, Inbox, Loader2, WifiOff } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api, getSessionToken } from '@/lib/api'
import { useApp } from '@/lib/store'
import { haptic } from '@/lib/tg'
import { pluralRu } from '@/lib/format'
import { loadFeedCache, saveFeedCache } from '@/lib/offline'
import type { AdDTO, FeedResponse, NotificationsResponse, PostDTO } from '@/lib/types'
import { PostCard } from '@/components/feed/PostCard'
import { AdCard } from '@/components/feed/AdCard'
import { SummarySheet } from '@/components/feed/SummarySheet'
import { NotificationsSheet } from '@/components/feed/NotificationsSheet'

const PAGE_SIZE = 5
const PTR_THRESHOLD = 62 // тянем вниз на столько, чтобы обновить

/**
 * Умная лента: вкладки категорий с синим подчёркиванием (как в макете),
 * бесконечная вертикальная прокрутка, pull-to-refresh, каждый 10-й слот — реклама.
 */
export function FeedView() {
  const { user, category, setCategory, categories, feedVersion, bumpFeed, openSearchWith } = useApp()
  const [items, setItems] = useState<PostDTO[]>([])
  const [ads, setAds] = useState<AdDTO[]>([])
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(false)
  const [initial, setInitial] = useState(true)
  // Ошибка загрузки ленты (сеть/сервер): показываем отдельный блок вместо «пустого»
  const [loadFailed, setLoadFailed] = useState(false)
  const [summaryPost, setSummaryPost] = useState<PostDTO | null>(null)
  const [showTop, setShowTop] = useState(false)
  const [freshCount, setFreshCount] = useState(0)
  // Офлайн-режим: сеть недоступна — показываем кэш из IndexedDB
  const [offline, setOffline] = useState(false)
  // Экран «Уведомления»: счётчик для бейджа у колокольчика + открытый шит + данные шита
  const [notifCount, setNotifCount] = useState(0)
  const [notifOpen, setNotifOpen] = useState(false)
  const [notifData, setNotifData] = useState<NotificationsResponse | null>(null)
  const [notifFailed, setNotifFailed] = useState(false)
  // Момент новейшего загруженного поста — для подсчёта «N новых»
  const latestTimeRef = useRef<string>('')

  // Состояние pull-to-refresh (pull дублируется в ref — замыкания не устаревают)
  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const ptrRef = useRef<{ startY: number; pulling: boolean; pull: number } | null>(null)
  const refreshingRef = useRef(false)
  refreshingRef.current = refreshing

  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  // Guard частоты обновления счётчика уведомлений: не чаще раза в 30с
  const notifFetchedAtRef = useRef(0)

  // Stagger-анимация появления постов — только для САМОЙ первой партии
  // (первичная загрузка страницы). Флаг выключается сразу после первого
  // завершения загрузки: append следующих страниц, вставка fresh-постов сверху,
  // pull-to-refresh и смена категории рендерятся без анимаций, чтобы не дёргалось.
  // Важно: выключение происходит в эффекте ПОСЛЕ первого коммита с постами —
  // первая партия успевает смонтироваться с задержками (PostCard «прилипает»
  // к задержке первым рендером, сменой пропса тип корня не меняется).
  const [staggerBatch, setStaggerBatch] = useState(true)
  useEffect(() => {
    if (!initial) setStaggerBatch(false)
  }, [initial])
  const userRef = useRef(user)
  userRef.current = user
  const itemsRef = useRef(items)
  itemsRef.current = items
  const busyRef = useRef(false)

  useEffect(() => {
    api<{ items: AdDTO[] }>('/api/ads')
      .then((d) => setAds(d.items))
      .catch(() => {})
  }, [])

  // ---------- Уведомления (колокольчик в шапке) ----------

  /** Обновить счётчик новых постов (не чаще раза в 30с — guard-таймштамп в ref) */
  const fetchNotifCount = useCallback(async () => {
    const uid = userRef.current?.id
    if (!uid) return
    const now = Date.now()
    if (now - notifFetchedAtRef.current < 30_000) return
    notifFetchedAtRef.current = now
    try {
      const r = await api<NotificationsResponse>(`/api/notifications?userId=${encodeURIComponent(uid)}`)
      setNotifCount(r.count)
    } catch {
      // тихо — бейдж просто останется прежним до следующего тика
    }
  }, [])

  // Счётчик: при монтировании ленты и после каждого bumpFeed (пересборка ленты)
  useEffect(() => {
    void fetchNotifCount()
  }, [feedVersion, fetchNotifCount])

  /** Тап по колокольчику: открыть шит; данные читаем ДО POST seen — иначе окно
   *  «нового» обнуляется под ногами и шит показывает пустоту (гонка GET/seen).
   *  Бейдж обнуляем оптимистично сразу. */
  const loadNotifData = useCallback(async () => {
    const uid = userRef.current?.id
    if (!uid) return
    try {
      const r = await api<NotificationsResponse>(`/api/notifications?userId=${encodeURIComponent(uid)}`)
      setNotifData(r)
      // POST seen после чтения данных (по ТЗ — «после открытия», окно зафиксировано)
      api('/api/notifications/seen', {
        method: 'POST',
        body: JSON.stringify({ userId: uid }),
      }).catch(() => {})
    } catch {
      setNotifFailed(true)
      toast.error('Не удалось загрузить уведомления')
    }
  }, [])

  const openNotifications = useCallback(() => {
    haptic('light')
    setNotifOpen(true)
    setNotifCount(0) // оптимистично
    setNotifData(null) // шит покажет скелетон
    setNotifFailed(false)
    notifFetchedAtRef.current = Date.now()
    void loadNotifData()
  }, [loadNotifData])

  const load = useCallback(
    async (p: number, replace: boolean) => {
      if (!userRef.current || busyRef.current) return
      busyRef.current = true
      setLoading(true)
      try {
        const data = await api<FeedResponse>(
          `/api/feed?userId=${encodeURIComponent(userRef.current.id)}&category=${encodeURIComponent(category)}&page=${p}&limit=${PAGE_SIZE}`,
        )
        setItems((prev) => (replace ? data.items : [...prev, ...data.items]))
        // Запоминаем новейший пост (для пилюли «N новых постов») — только если он новее текущего
        const times = data.items.map((x) => x.publishedAt).sort()
        const mx = times[times.length - 1]
        if (mx && mx > latestTimeRef.current) latestTimeRef.current = mx
        setHasMore(data.hasMore)
        setPage(p)
        setOffline(false)
        setLoadFailed(false)
        // Кэшируем свежую страницу (офлайн-режим)
        if (replace) void saveFeedCache(category, data.items)
        else void saveFeedCache(category, [...itemsRef.current, ...data.items])
      } catch {
        // Нет сети → показываем кэш из IndexedDB с баннером; иная ошибка → тост
        const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false
        if (isOffline) {
          setOffline(true)
          const cached = await loadFeedCache(category)
          if (cached.length > 0) {
            setItems((prev) => (prev.length > 0 ? prev : cached))
            setHasMore(false)
            setPage(p)
          } else {
            setLoadFailed(true)
            toast.error('Нет сети, а кэш ещё пуст')
          }
        } else {
          setLoadFailed(true)
          toast.error('Не удалось загрузить ленту')
        }
      } finally {
        busyRef.current = false
        setLoading(false)
        setInitial(false)
        // Если сентинел уже в кадре (короткий контент/быстрый скролл) — догружаем сразу.
        // Через таймаут, чтобы React успел закоммитить обновлённые page/hasMore.
        setTimeout(() => checkRef.current(), 80)
      }
    },
    [category],
  )

  /**
   * Ручная проверка «пора ли грузить дальше»: истина, если сентинел
   * видим или близко к кадру. Вызывается из IO и после каждой загрузки.
   */
  const checkLoadMore = useCallback(() => {
    if (!hasMore || busyRef.current || !userRef.current) return
    const el = sentinelRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.top < (window.innerHeight || 800) + 1100) {
      load(page + 1, false)
    }
  }, [hasMore, page, load])

  const checkRef = useRef(checkLoadMore)
  checkRef.current = checkLoadMore

  // Наблюдатель сентинела. Эффект перезапускается, когда сентинел появляется
  // в DOM (initial -> false) — раньше он не наблюдался вовсе и лента застревала
  // на первой странице.
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(() => checkRef.current(), { rootMargin: '1200px' })
    io.observe(el)
    return () => io.disconnect()
  }, [initial])

  useEffect(() => {
    if (!user) return
    setInitial(true)
    setLoadFailed(false)
    busyRef.current = false
    setFreshCount(0)
    // Stale-while-revalidate: мгновенно показываем кэш, сеть догонит
    void loadFeedCache(category).then((cached) => {
      if (cached.length > 0 && !itemsRef.current.length) {
        setItems(cached)
        setInitial(false)
      }
    })
    load(0, true)
    scrollRef.current?.scrollTo({ top: 0 })
  }, [user, category, feedVersion, load])

  // События сети: при возврате онлайна — тихо обновить ленту
  useEffect(() => {
    const goOnline = () => {
      setOffline(false)
      if (userRef.current && !busyRef.current) load(0, true)
    }
    const goOffline = () => setOffline(true)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [load])

  // Кнопка «наверх» — показываем после прокрутки ленты дальше 700px (passive-листенер
  // на самом скроллящемся контейнере overflow-y-auto, cleanup при размонтировании)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => setShowTop(el.scrollTop > 700)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // Поллинг новых постов (пилюля «N новых»), только когда вкладка активна и видима
  const checkFresh = useCallback(async () => {
    if (document.visibilityState !== 'visible') return
    if (useApp.getState().tab !== 'feed') return
    if (busyRef.current || refreshingRef.current) return
    if (!latestTimeRef.current || !userRef.current) return
    try {
      const r = await api<FeedResponse & { count: number }>(
        `/api/feed/fresh?userId=${encodeURIComponent(userRef.current.id)}&category=${encodeURIComponent(category)}&after=${encodeURIComponent(latestTimeRef.current)}`,
      )
      if (r.count > 0) setFreshCount(r.count)
    } catch {
      // тихо — попробуем на следующем тике
    }
  }, [category])

  useEffect(() => {
    if (!user) return
    const iv = setInterval(checkFresh, 45000)
    const t = setTimeout(checkFresh, 6000)
    return () => {
      clearInterval(iv)
      clearTimeout(t)
    }
  }, [user, initial, checkFresh])

  // ---------- SSE: живые обновления без ожидания ближайшего поллинга ----------
  // Парсер публикует «posts:new» в событийную шину — SSE-роут толкает её
  // подписчикам. Соединение через fetch-стрим (EventSource не умеет заголовки
  // Authorization). При событии: сбрасываем guard бейджа и обновляем
  // счётчики уведомлений и пилюли «N новых» немедленно. Обрыв → retry 5с.
  const checkFreshRef = useRef(checkFresh)
  checkFreshRef.current = checkFresh

  useEffect(() => {
    if (!user) return
    const ac = new AbortController()
    let stopped = false
    let retry: ReturnType<typeof setTimeout> | null = null

    const handleFrame = (frame: string) => {
      if (!frame.startsWith('event: posts:new')) return
      notifFetchedAtRef.current = 0 // guard «не чаще 30с» не должен гасить push-событие
      void fetchNotifCount()
      void checkFreshRef.current?.()
    }

    const connect = async () => {
      while (!stopped) {
        try {
          const res = await fetch('/api/events', {
            signal: ac.signal,
            headers: {
              Accept: 'text/event-stream',
              // Bearer-сессия: роут /api/events требует авторизацию
              Authorization: `Bearer ${getSessionToken() ?? ''}`,
            },
          })
          if (!res.ok || !res.body) throw new Error(`sse ${res.status}`)
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buf = ''
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            let sep: number
            while ((sep = buf.indexOf('\n\n')) >= 0) {
              const frame = buf.slice(0, sep)
              buf = buf.slice(sep + 2)
              handleFrame(frame)
            }
          }
        } catch {
          // обрыв сети или abort — тихо уходим в retry
        }
        if (stopped) return
        await new Promise<void>((r) => {
          retry = setTimeout(r, 5000)
        })
      }
    }

    void connect()
    return () => {
      stopped = true
      if (retry) clearTimeout(retry)
      ac.abort()
    }
  }, [user, fetchNotifCount])

  // Тап по пилюле: вставляем новые посты сверху (как в Telegram), без полного ре-ранка
  const applyFresh = useCallback(async () => {
    if (!userRef.current || busyRef.current) return
    setRefreshing(true)
    try {
      const r = await api<FeedResponse & { count: number }>(
        `/api/feed/fresh?userId=${encodeURIComponent(userRef.current.id)}&category=${encodeURIComponent(category)}&after=${encodeURIComponent(latestTimeRef.current)}`,
      )
      if (r.items.length > 0) {
        const freshIds = new Set(r.items.map((x) => x.id))
        setItems((prev) => [...r.items.filter((x) => !prev.some((p) => p.id === x.id)), ...prev])
        const mx = r.items.map((x) => x.publishedAt).sort().pop()
        if (mx && mx > latestTimeRef.current) latestTimeRef.current = mx
        void freshIds
      }
      setFreshCount(0)
      haptic('light')
      scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    } catch {
      toast.error('Не удалось обновить ленту')
    } finally {
      setRefreshing(false)
    }
  }, [category])

  const refresh = useCallback(async () => {
    if (!userRef.current || busyRef.current) return
    setRefreshing(true)
    try {
      await load(0, true)
      setFreshCount(0)
    } finally {
      setRefreshing(false)
      setPull(0)
    }
  }, [load])

  // ---------- Pull-to-refresh (тач-жест вниз на самом верху ленты) ----------
  const onTouchStart = (e: React.TouchEvent) => {
    if (initial || refreshingRef.current || busyRef.current) return
    const el = scrollRef.current
    if (el && el.scrollTop <= 0) {
      ptrRef.current = { startY: e.touches[0].clientY, pulling: true, pull: 0 }
    }
  }
  const onTouchMove = (e: React.TouchEvent) => {
    const ptr = ptrRef.current
    if (!ptr?.pulling) return
    const el = scrollRef.current
    if (!el || el.scrollTop > 0) {
      ptr.pulling = false
      ptr.pull = 0
      setPull(0)
      return
    }
    const dy = e.touches[0].clientY - ptr.startY
    ptr.pull = dy > 0 ? Math.min(96, dy * 0.42) : 0
    setPull(ptr.pull)
  }
  const onTouchEnd = () => {
    const ptr = ptrRef.current
    ptrRef.current = null
    if (!ptr?.pulling) return
    if (ptr.pull >= PTR_THRESHOLD) {
      haptic('light')
      refresh()
    } else {
      setPull(0)
    }
  }

  const updatePost = useCallback((id: string, patch: Partial<PostDTO>) => {
    setItems((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }, [])

  // Лайк/закладка из полного экрана поста (PostOverlay) синхронизируются
  // с лентой точечно, без рефетча и потери скролла
  useEffect(() => {
    const onPostUpdated = (e: Event) => {
      const d = (e as CustomEvent).detail as { postId: string } & Partial<PostDTO>
      if (!d?.postId) return
      const { postId, ...patch } = d
      updatePost(postId, patch)
    }
    window.addEventListener('tgfeed:post-updated', onPostUpdated)
    return () => window.removeEventListener('tgfeed:post-updated', onPostUpdated)
  }, [updatePost])

  const onLike = useCallback(
    async (post: PostDTO) => {
      if (!user) return
      const nextLiked = !post.liked
      const nextCount = post.likesCount + (nextLiked ? 1 : -1)
      updatePost(post.id, { liked: nextLiked, likesCount: Math.max(0, nextCount) })
      try {
        const r = await api<{ liked: boolean; likesCount: number }>('/api/like', {
          method: 'POST',
          body: JSON.stringify({ userId: user.id, postId: post.id }),
        })
        updatePost(post.id, r)
      } catch {
        updatePost(post.id, { liked: post.liked, likesCount: post.likesCount })
        toast.error('Не удалось сохранить лайк')
      }
    },
    [user, updatePost],
  )

  const onBookmark = useCallback(
    async (post: PostDTO) => {
      if (!user) return
      const next = !post.bookmarked
      updatePost(post.id, {
        bookmarked: next,
        bookmarksCount: Math.max(0, post.bookmarksCount + (next ? 1 : -1)),
      })
      haptic(next ? 'success' : 'light')
      try {
        await api('/api/bookmark', {
          method: 'POST',
          body: JSON.stringify({ userId: user.id, postId: post.id }),
        })
        toast.success(next ? 'Сохранено' : 'Убрано из сохранённых')
      } catch {
        updatePost(post.id, {
          bookmarked: !next,
          bookmarksCount: Math.max(0, post.bookmarksCount + (next ? -1 : 1)),
        })
        toast.error('Ошибка')
      }
    },
    [user, updatePost],
  )

  const onSubscribe = useCallback(
    async (post: PostDTO) => {
      if (!user) return
      const ch = post.channel
      const next = !ch.subscribed
      setItems((prev) =>
        prev.map((p) =>
          p.channel.id === ch.id
            ? {
                ...p,
                channel: {
                  ...p.channel,
                  subscribed: next,
                  subscribersCount: Math.max(0, p.channel.subscribersCount + (next ? 1 : -1)),
                },
              }
            : p,
        ),
      )
      try {
        const r = await api<{ subscribed: boolean; notify: boolean }>('/api/subscribe', {
          method: 'POST',
          body: JSON.stringify({ userId: user.id, channelId: ch.id }),
        })
        // Сервер — источник истины: применяем его состояние вместо
        // оптимистичного (защита от рассинхрона toggle-семантики, баг qa18 №1)
        const finalSubscribed = r.subscribed
        setItems((prev) =>
          prev.map((p) =>
            p.channel.id === ch.id
              ? {
                  ...p,
                  channel: {
                    ...p.channel,
                    subscribed: finalSubscribed,
                    subscribersCount: Math.max(
                      0,
                      p.channel.subscribersCount + (finalSubscribed === next ? 0 : finalSubscribed ? 1 : -1),
                    ),
                  },
                }
              : p,
          ),
        )
        if (finalSubscribed) haptic('success')
      } catch {
        setItems((prev) =>
          prev.map((p) =>
            p.channel.id === ch.id
              ? {
                  ...p,
                  channel: {
                    ...p.channel,
                    subscribed: !next,
                    subscribersCount: Math.max(0, p.channel.subscribersCount + (next ? -1 : 1)),
                  },
                }
              : p,
          ),
        )
        toast.error('Ошибка подписки')
      }
    },
    [user],
  )

  const tabs = [
    { slug: 'all', title: 'Все' },
    ...categories.map((c) => ({ slug: c.slug, title: c.title })),
    { slug: 'discover', title: 'Интересное' }, // посты из наименее просмотренных категорий
  ]

  return (
    <div className="relative flex h-full flex-col">
      {/* Вкладки категорий — крупные, активная жирная с синей чертой (макет);
          справа — колокольчик уведомлений с бейджем новых постов */}
      <header className="shrink-0 bg-tg-bg" data-noswipe>
        <div className="flex items-end">
          <div
            className="no-scrollbar flex min-w-0 flex-1 items-end gap-6 overflow-x-auto px-4 pb-1 pt-2.5"
            role="tablist"
            aria-label="Категории ленты"
          >
            {tabs.map((t) => {
              const active = category === t.slug
              return (
                <button
                  key={t.slug}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    if (!active) haptic('light')
                    setCategory(t.slug)
                  }}
                  className={cn(
                    'relative shrink-0 pb-2 text-[19px] leading-none transition-colors',
                    active ? 'font-bold text-tg-text' : 'font-medium text-tg-hint',
                  )}
                >
                  {t.title}
                  {active && (
                    <motion.span
                      layoutId="feed-tab-underline"
                      transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                      aria-hidden
                      className="absolute inset-x-0 -bottom-px h-[3px] rounded-full bg-tg-link"
                    />
                  )}
                </button>
              )
            })}
          </div>

          {/* Колокольчик «Уведомления» — 40×40, бейдж с числом новых постов (9+ при переполнении) */}
          <div className="shrink-0 px-3 pb-1.5 pt-2.5">
            <button
              type="button"
              onClick={openNotifications}
              aria-label={
                notifCount > 0
                  ? `Уведомления: ${notifCount} ${pluralRu(notifCount, 'новый пост', 'новых поста', 'новых постов')}`
                  : 'Уведомления'
              }
              className="relative flex h-10 w-10 items-center justify-center rounded-full border border-tg-sep bg-tg-surface transition active:scale-90"
            >
              <Bell className="h-5 w-5 text-tg-text" strokeWidth={1.9} />
              <AnimatePresence>
                {notifCount > 0 && (
                  <motion.span
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0, opacity: 0 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 24 }}
                    className="absolute -right-1 -top-1 flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-tg-like px-1 text-[10px] font-semibold leading-none text-white"
                  >
                    {notifCount > 9 ? '9+' : notifCount}
                  </motion.span>
                )}
              </AnimatePresence>
            </button>
          </div>
        </div>
        <div className="h-px w-full bg-tg-sep/60" aria-hidden />
      </header>

      {/* Баннер офлайна: лента из кэша */}
      <AnimatePresence>
        {offline && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            role="status"
            className="overflow-hidden bg-amber-50 dark:bg-amber-500/10"
          >
            <div className="flex items-center justify-center gap-2 px-4 py-1.5 text-[12.5px] font-medium text-amber-700 dark:text-amber-400">
              <WifiOff className="h-3.5 w-3.5" />
              Нет сети — показаны сохранённые посты
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Пилюля «N новых постов» (как в нативных лентах) */}
      <AnimatePresence>
        {freshCount > 0 && !refreshing && (
          <motion.button
            type="button"
            initial={{ opacity: 0, y: -14, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -14, scale: 0.9 }}
            transition={{ type: 'spring', stiffness: 400, damping: 28 }}
            onClick={() => applyFresh()}
            aria-label={`Показать: ${freshCount} ${pluralRu(freshCount, 'новый пост', 'новых поста', 'новых постов')}`}
            className="absolute left-1/2 top-3 z-30 flex h-9 -translate-x-1/2 items-center gap-1.5 rounded-full bg-tg-link px-4 text-[13.5px] font-semibold text-white shadow-lg shadow-tg-link/30 transition active:scale-95"
          >
            <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
            {freshCount} {pluralRu(freshCount, 'новый пост', 'новых поста', 'новых постов')}
          </motion.button>
        )}
      </AnimatePresence>

      {/* Сама лента — естественный скролл + pull-to-refresh */}
      <div
        ref={scrollRef}
        className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain pb-24"
        aria-label="Лента постов"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {/* Индикатор pull-to-refresh */}
        <motion.div
          initial={false}
          animate={{ height: refreshing ? 44 : pull }}
          transition={{ type: 'spring', stiffness: 400, damping: 32 }}
          className="flex items-center justify-center overflow-hidden"
          aria-hidden={pull === 0 && !refreshing}
        >
          <Loader2
            className={cn(
              'h-5 w-5 text-tg-hint transition-opacity',
              refreshing || pull > 8 ? 'opacity-100' : 'opacity-0',
              refreshing && 'animate-spin',
            )}
            style={!refreshing ? { transform: `rotate(${pull * 4}deg)` } : undefined}
          />
        </motion.div>

        {initial ? (
          <FeedSkeleton />
        ) : items.length === 0 && loadFailed ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-tg-surface">
              <AlertCircle className="h-7 w-7 text-tg-hint" aria-hidden />
            </span>
            <p className="text-[15px] font-semibold text-tg-text">Не удалось загрузить ленту</p>
            <p className="text-snippet text-tg-hint">Проверьте соединение и попробуйте ещё раз</p>
            <button
              type="button"
              onClick={bumpFeed}
              className="mt-1 h-10 rounded-full bg-tg-surface px-5 text-[14px] font-semibold text-tg-link active:scale-95"
            >
              Обновить
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-tg-surface">
              <Inbox className="h-12 w-12 text-tg-hint" aria-hidden />
            </span>
            <p className="text-[15px] font-semibold text-tg-text">Здесь пока пусто</p>
            <p className="text-snippet text-tg-hint">
              Подпишитесь на каналы или посмотрите популярные
            </p>
            <button
              type="button"
              onClick={() => {
                haptic('light')
                openSearchWith('')
              }}
              className="mt-1 h-10 rounded-full bg-tg-button px-5 text-[14px] font-semibold text-white active:scale-95"
            >
              Открыть поиск
            </button>
          </div>
        ) : (
          <>
            {items.map((p, i) => (
              <Fragment key={p.id}>
                <PostCard
                  post={p}
                  appearDelay={staggerBatch ? Math.min(i, 6) * 0.04 : undefined}
                  onLike={() => onLike(p)}
                  onBookmark={() => onBookmark(p)}
                  onSubscribe={() => onSubscribe(p)}
                  onSummary={() => setSummaryPost(p)}
                />
                {(i + 1) % 10 === 0 && ads.length > 0 && (
                  <AdCard ad={ads[Math.floor(i / 10) % ads.length]} />
                )}
              </Fragment>
            ))}

            <div ref={sentinelRef} className="h-2" aria-hidden />

            {loading && (
              <div className="flex justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-tg-hint" />
              </div>
            )}

            {!hasMore && (
              <div className="flex flex-col items-center px-8 py-10 text-center">
                <p className="text-[15px] font-semibold text-tg-text">Вы досмотрели ленту</p>
                <p className="mt-1 text-snippet text-tg-hint">
                  Загляните чуть позже — каналы публикуют новое
                </p>
                <button
                  type="button"
                  onClick={bumpFeed}
                  className="mt-4 h-10 rounded-full bg-tg-surface px-5 text-[14px] font-semibold text-tg-link active:scale-95"
                >
                  Обновить
                </button>
              </div>
            )}
          </>
        )}

        <SummarySheet post={summaryPost} onClose={() => setSummaryPost(null)} />
      </div>

      {/*
        Кнопка «наверх»: закреплена справа НАД таббаром (bottom-24 от низа колонки —
        таббар идёт ниже по flex-колонке и не перекрывается) и выше тостов sonner
        (bottom-center, offset 72). pointer-events только на самой кнопке (при скрытии
        она размонтируется из DOM — ничего не блокирует). ChannelSheet рендерится в
        page.tsx ВНЕ FeedView и сам перекрывает кнопку своим fixed z-[70] — отдельно
        прятать FAB при открытом канале не нужно.
      */}
      <AnimatePresence>
        {showTop && (
          <motion.button
            type="button"
            data-noswipe
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.6 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            onClick={() => {
              haptic('light')
              setShowTop(false) // прячем сразу, не дожидаясь события scroll
              scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
            }}
            aria-label="Наверх"
            className="absolute bottom-24 right-4 z-20 flex h-11 w-11 items-center justify-center rounded-full bg-tg-button text-white shadow-lg transition active:scale-90"
          >
            <ArrowUp className="h-5 w-5" strokeWidth={2.2} />
          </motion.button>
        )}
      </AnimatePresence>

      {/* Экран «Уведомления» — портал в body (fixed не зависит от transform вкладок);
          состояние и данные живут здесь, page.tsx и store не трогаем */}
      <NotificationsSheet
        open={notifOpen}
        onClose={() => setNotifOpen(false)}
        data={notifData}
        failed={notifFailed}
        onRetry={() => {
          setNotifFailed(false)
          void loadNotifData()
        }}
      />
    </div>
  )
}

function FeedSkeleton() {
  return (
    <div className="px-4 pt-4" aria-hidden>
      <div className="flex items-center gap-3">
        <div className="tg-shimmer h-[52px] w-[52px] rounded-full" />
        <div className="flex-1 space-y-2">
          <div className="tg-shimmer h-4 w-1/3 rounded-md" />
          <div className="tg-shimmer h-3 w-1/4 rounded-md" />
        </div>
        <div className="tg-shimmer h-11 w-11 rounded-full" />
      </div>
      <div className="mt-4 flex gap-2">
        <div className="tg-shimmer h-64 flex-1 rounded-2xl" />
        <div className="w-10 space-y-4 pt-2">
          <div className="tg-shimmer h-6 w-6 rounded-full" />
          <div className="tg-shimmer h-6 w-6 rounded-full" />
          <div className="tg-shimmer h-6 w-6 rounded-full" />
        </div>
      </div>
      <div className="mt-4 space-y-2">
        <div className="tg-shimmer h-3.5 w-full rounded-md" />
        <div className="tg-shimmer h-3.5 w-4/5 rounded-md" />
      </div>
      {/* Второй пост — каркас без медиа */}
      <div className="mt-6 flex items-center gap-3">
        <div className="tg-shimmer h-[52px] w-[52px] rounded-full" />
        <div className="flex-1 space-y-2">
          <div className="tg-shimmer h-4 w-2/5 rounded-md" />
          <div className="tg-shimmer h-3 w-1/3 rounded-md" />
        </div>
        <div className="tg-shimmer h-11 w-11 rounded-full" />
      </div>
      <div className="mt-4 space-y-2">
        <div className="tg-shimmer h-3.5 w-full rounded-md" />
        <div className="tg-shimmer h-3.5 w-11/12 rounded-md" />
        <div className="tg-shimmer h-3.5 w-3/5 rounded-md" />
      </div>
    </div>
  )
}
