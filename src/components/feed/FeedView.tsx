'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowUp, Bell, Clock3, EyeOff, Flame, Image as ImageIcon, Inbox, Loader2, Search, WifiOff, X } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { toast } from 'sonner'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { api, getSessionToken } from '@/lib/api'
import { useApp } from '@/lib/store'
import { haptic } from '@/lib/tg'
import { loadFeedCache, saveFeedCache } from '@/lib/offline'
import { openChannelToJoin } from '@/lib/tg-subscribe'
import type { AdDTO, FeedResponse, NotificationsResponse, PostDTO } from '@/lib/types'
import { PostCard } from '@/components/feed/PostCard'
import { AdCard } from '@/components/feed/AdCard'
import { SummarySheet } from '@/components/feed/SummarySheet'
import { NotificationsSheet } from '@/components/feed/NotificationsSheet'

const PAGE_SIZE = 10 // страниц меньше — запросов меньше, лента заполняется быстрее
const PTR_THRESHOLD = 62 // тянем вниз на столько, чтобы обновить
/** Подряд идущие страницы без единого нового поста: после двух — лента кончилась
 *  (окно пагинации съехало из-за вставки свежих постов: догонять его бессмысленно
 *  и именно это выглядело как «вечная загрузка» при скролле вниз) */
const MAX_EMPTY_PAGES = 2

// ---------- Полезности ленты ----------

/** Скрытые посты («Не интересно») — между сессиями, в localStorage */
const HIDDEN_KEY = 'tgfeed_hidden_posts'
function loadHidden(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.localStorage.getItem(HIDDEN_KEY)
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set()
  } catch {
    return new Set()
  }
}
function saveHidden(ids: Set<string>) {
  try {
    window.localStorage.setItem(HIDDEN_KEY, JSON.stringify([...ids]))
  } catch {
    /* приватный режим — скрытие будет до перезагрузки */
  }
}

/**
 * Разнообразие ленты на клиенте: один и тот же канал — НЕ подряд. Работает
 * поверх серверного diversify и ловит ВСЕ источники повторов: стыки страниц,
 * тихий аппенд свежих постов, дедуп при «съехавшем» окне пагинации, офлайн-кэш.
 *
 * Алгоритм — минимальные локальные свопы: пост, соседствующий с каналом
 * предыдущего, меняется местами с ближайшим постом другого канала правее.
 * startAt позволяет не трогать уже видимую часть ленты (стабильность экрана):
 * чиним только хвост, начиная со стыка «старое | новое».
 *
 * Хвостовой ремонт: когда весь остаток — посты ОДНОГО канала (канал залил
 * серию, новых других нет), справа переставлять нечего. Занимаем ближайшего
 * соседа СЛЕВА другого канала и вставляем его после первого поста серии —
 * пара в хвосте разбивается. Принимаем вариант только если соседств-дубликатов
 * стало строго меньше (никогда не ухудшаем).
 */
function stitchNoRepeat<T>(list: T[], channelIdOf: (x: T) => string, startAt = 1): T[] {
  const from = Math.max(1, startAt)
  const arr = [...list]
  const pairs = (a: T[]): number => {
    let n = 0
    for (let k = 1; k < a.length; k++) if (channelIdOf(a[k]) === channelIdOf(a[k - 1])) n++
    return n
  }

  for (let i = from; i < arr.length; i++) {
    const prevCh = channelIdOf(arr[i - 1])
    if (!prevCh || channelIdOf(arr[i]) !== prevCh) continue
    // 1) обычный случай: меняемся с ближайшим постом другого канала правее
    let j = i + 1
    while (j < arr.length && channelIdOf(arr[j]) === prevCh) j++
    if (j < arr.length) {
      const tmp = arr[i]
      arr[i] = arr[j]
      arr[j] = tmp
      continue
    }
    // 2) хвост — сплошная серия этого канала: занимаем соседа слева
    let runStart = i
    while (runStart - 1 >= from && channelIdOf(arr[runStart - 1]) === prevCh) runStart--
    let s = runStart - 1
    while (s >= from && channelIdOf(arr[s]) === prevCh) s--
    if (s < from) continue // слева (в окне ремонта) однородно — нечего занимать
    const candidate = [...arr]
    const [borrowed] = candidate.splice(s, 1)
    // s < runStart: после удаления сдвиг влево — первый пост серии теперь на
    // runStart-1, вставляем занятого соседа СРАЗУ ПОСЛЕ него (индекс runStart)
    candidate.splice(runStart, 0, borrowed)
    if (pairs(candidate) < pairs(arr)) {
      for (let k = 0; k < arr.length; k++) arr[k] = candidate[k]
    }
  }
  return arr
}

/** Чип-фильтр тулбара: компактный, активный — с синей подложкой */
function FilterChip({
  active,
  onClick,
  label,
  Icon,
  aria,
}: {
  active: boolean
  onClick: () => void
  label: string
  Icon: typeof Clock3
  aria: string
}) {
  return (
    <button
      type="button"
      onClick={() => {
        haptic('light')
        onClick()
      }}
      aria-pressed={active}
      aria-label={aria}
      title={aria}
      className={cn(
        'flex h-8 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[12.5px] font-medium transition active:scale-95',
        active
          ? 'border-tg-link/30 bg-tg-link/10 text-tg-link'
          : 'border-tg-sep bg-tg-surface text-tg-hint',
      )}
    >
      <Icon className={cn('h-3.5 w-3.5', active && 'text-tg-link')} aria-hidden />
      {label}
    </button>
  )
}

/**
 * Умная лента: вкладки категорий с синим подчёркиванием (как в макете),
 * бесконечная вертикальная прокрутка, pull-to-refresh, каждый 10-й слот — реклама.
 */
export function FeedView() {
  const t = useT()
  const { user, category, setCategory, categories, feedVersion, bumpFeed, openSearchWith, setPostQueue, openAuthGate } = useApp()
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
  // Офлайн-режим: сеть недоступна — показываем кэш из IndexedDB
  const [offline, setOffline] = useState(false)
  // Экран «Уведомления»: счётчик для бейджа у колокольчика + открытый шит + данные шита
  const [notifCount, setNotifCount] = useState(0)
  // Непрочитанные события «Активности» (комментарии/поддержка/кампании) —
  // с новыми постами делят один бейдж колокольчика
  const [unreadActivity, setUnreadActivity] = useState(0)
  const [notifOpen, setNotifOpen] = useState(false)
  const [notifData, setNotifData] = useState<NotificationsResponse | null>(null)
  const [notifFailed, setNotifFailed] = useState(false)
  // Момент новейшего загруженного поста — для подсчёта «N новых»
  const latestTimeRef = useRef<string>('')
  const seedRef = useRef<string>('')
  // Счётчик пустых страниц (дедуп съел всё) — сбрасывается при полной перезагрузке
  const emptyStreakRef = useRef(0)

  // ---------- Тулбар ленты: поиск по загруженным постам + фильтры + сортировка ----------
  const [query, setQuery] = useState('')
  const [mediaOnly, setMediaOnly] = useState(false)
  const [dayOnly, setDayOnly] = useState(false)
  const [popularSort, setPopularSort] = useState(false)
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => loadHidden())
  // «Не интересно» (v5.10): замьютнутые каналы текущей сессии (сервер хранит
  // полный список в ChannelMute — локальный сет нужен только для мгновенной
  // фильтрации уже загруженных постов)
  const [mutedChannels, setMutedChannels] = useState<Set<string>>(new Set())
  // Прогресс чтения ленты (0..1) — обновляется императивно (без ререндера)
  const progressRef = useRef<HTMLDivElement>(null)

  const filtersActive = query.trim().length > 0 || mediaOnly || dayOnly || popularSort || hiddenIds.size > 0

  const resetFilters = useCallback(() => {
    setQuery('')
    setMediaOnly(false)
    setDayOnly(false)
    setPopularSort(false)
  }, [])

  /** «Не интересно» (v5.10): скрывает ВЕСЬ канал, а не один пост.
   *  Жалоба владельца: раньше кнопка прятала только пост (локально), и канал
   *  продолжал лезть в ленту. Теперь: серверный мьют (ChannelMute — фильтр в
   *  /api/feed с редкими возвращениями) + мгновенная локальная фильтрация.
   *  Тост с «Вернуть» откатывает мьют. */
  const hidePost = useCallback(
    (post: { channel: { id: string; title: string } }) => {
      const cid = post.channel.id
      setMutedChannels((prev) => new Set(prev).add(cid))
      api('/api/subscribe', {
        method: 'POST',
        body: JSON.stringify({ channelId: cid, action: 'mute' }),
      }).catch(() => {})
      toast(t('feed.channelHiddenToast'), {
        description: post.channel.title,
        action: {
          label: t('feed.unhideToast'),
          onClick: () => {
            setMutedChannels((prev) => {
              const next = new Set(prev)
              next.delete(cid)
              return next
            })
            api('/api/subscribe', {
              method: 'POST',
              body: JSON.stringify({ channelId: cid, action: 'unmute' }),
            }).catch(() => {})
          },
        },
      })
    },
    [t],
  )

  /** Видимые посты: мьютнутые каналы + скрытые + фильтры + поиск + сортировка (клиентски, мгновенно) */
  const visibleItems = useMemo(() => {
    let list = items
    if (mutedChannels.size > 0) list = list.filter((p) => !mutedChannels.has(p.channel.id))
    if (hiddenIds.size > 0) list = list.filter((p) => !hiddenIds.has(p.id))
    if (mediaOnly) {
      list = list.filter(
        (p) =>
          (p.media != null && (p.media.url || p.media.name || p.media.question || p.media.link)) ||
          p.gallery.length > 0,
      )
    }
    if (dayOnly) {
      const dayAgo = Date.now() - 86_400_000
      list = list.filter((p) => new Date(p.publishedAt).getTime() >= dayAgo)
    }
    const q = query.trim().toLowerCase()
    if (q) {
      list = list.filter(
        (p) =>
          p.text.toLowerCase().includes(q) ||
          p.channel.title.toLowerCase().includes(q) ||
          p.channel.username.toLowerCase().includes(q),
      )
    }
    if (popularSort && list.length > 1) {
      list = [...list].sort(
        (a, b) => b.likesCount - a.likesCount || b.viewsCount - a.viewsCount,
      )
    }
    return list
  }, [items, hiddenIds, mutedChannels, mediaOnly, dayOnly, query, popularSort])

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
  // Снимок ленты для свайп-навигации ←/→ в полном экране поста (PostOverlay):
  // обновляется вместе с ВИДИМОЙ лентой (с учётом фильтров/скрытых) — оверлей
  // листает только те посты, которые пользователь реально видит.
  useEffect(() => {
    setPostQueue(visibleItems)
  }, [visibleItems, setPostQueue])
  const busyRef = useRef(false)

  // Реклама: первичная загрузка + рефреш при каждом bump ленты (pull-to-refresh,
  // новые посты) — выключенная админом реклама исчезает без перезагрузки приложения
  useEffect(() => {
    api<{ items: AdDTO[] }>('/api/ads')
      .then((d) => setAds(d.items))
      .catch(() => {})
  }, [feedVersion])

  // ---------- Уведомления (колокольчик в шапке) ----------
  const fetchNotifCount = useCallback(async () => {
    const uid = userRef.current?.id
    if (!uid) return
    const now = Date.now()
    if (now - notifFetchedAtRef.current < 30_000) return
    notifFetchedAtRef.current = now
    try {
      const r = await api<NotificationsResponse>(`/api/notifications?userId=${encodeURIComponent(uid)}`)
      setNotifCount(r.count)
      setUnreadActivity(r.unreadActivity ?? 0)
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
    setUnreadActivity(0)
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
        // Новый сид перемешивания при каждой полной перезагрузке ленты —
        // «Обновить» показывает ДРУГИЙ порядок постов; внутри сессии порядок стабилен
        if (replace || !seedRef.current) seedRef.current = Math.random().toString(36).slice(2, 12)
        const data = await api<FeedResponse>(
          `/api/feed?userId=${encodeURIComponent(userRef.current.id)}&category=${encodeURIComponent(category)}&page=${p}&limit=${PAGE_SIZE}&sh=${seedRef.current}`,
        )
        /* Дедуп: внутри ответа (ранк может вернуть пост дважды) и против уже
           виденных (окно пагинации съезжает — шедулер вставляет новые посты).
           Считается СИНХРОННО по itemsRef — заодно даёт точное число новых. */
        const prevList = replace ? [] : itemsRef.current
        const seen = new Set(prevList.map((p) => p.id))
        const incoming: typeof data.items = []
        const once = new Set<string>()
        for (const p of data.items) {
          if (once.has(p.id)) continue
          once.add(p.id)
          if (!replace && seen.has(p.id)) continue
          seen.add(p.id)
          incoming.push(p)
        }
        const freshCount = incoming.length
        if (replace) {
          setItems(stitchNoRepeat(incoming, (p) => p.channel.id))
        } else if (freshCount > 0) {
          // стык «видимое | догруженное» + хвост: без повторов каналов подряд
          setItems((prev) =>
            stitchNoRepeat([...prev, ...incoming], (p) => p.channel.id, Math.max(1, prev.length - 1)),
          )
        }
        /* Пустая страница = окно пагинации съехало (свежие посты вставлены выше).
           После MAX_EMPTY_PAGES пустых подряд — честно заканчиваем ленту вместо
           бесконечной погони за окном (раньше это выглядело как вечный спиннер).
           ВАЖНО: сервер почти всегда отвечает hasMore:true — если дать ему
           перезаписать стоп-флаг, лента гоняла пустые страницы ВЕЧНО (запрос
           за запросом, спиннер без конца). Стоп-флаг теперь главный. */
        if (replace) emptyStreakRef.current = 0
        else if (freshCount === 0) emptyStreakRef.current += 1
        else emptyStreakRef.current = 0
        const feedOver = emptyStreakRef.current >= MAX_EMPTY_PAGES
        // Запоминаем новейший пост (для пилюли «N новых постов») — только если он новее текущего
        const times = data.items.map((x) => x.publishedAt).sort()
        const mx = times[times.length - 1]
        if (mx && mx > latestTimeRef.current) latestTimeRef.current = mx
        setHasMore(feedOver ? false : data.hasMore)
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
          // тост только при первой ошибке — при скролле вниз у нас есть
          // ненавязчивая кнопка «Повторить» внизу ленты
          if (itemsRef.current.length === 0) toast.error('Не удалось загрузить ленту')
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
    setQuery('') // поиски разных категорий не смешиваются
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

  // Кнопка «наверх» — показываем после прокрутки ленты дальше 700px;
  // там же императивно обновляем тонкий прогресс-бар чтения (без ререндеров)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      setShowTop(el.scrollTop > 700)
      const max = el.scrollHeight - el.clientHeight
      const p = max > 0 ? Math.min(1, el.scrollTop / max) : 0
      if (progressRef.current) {
        progressRef.current.style.transform = `scaleX(${p})`
        progressRef.current.style.opacity = p > 0.005 ? '1' : '0'
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // Поллинг новых постов: ТИХО добавляем их в КОНЕЦ ленты (без пилюль и скроллов
  // вверх — пользователь просто продолжает листать и встречает свежее ниже)
  const checkFresh = useCallback(async () => {
    if (document.visibilityState !== 'visible') return
    if (useApp.getState().tab !== 'feed') return
    if (busyRef.current || refreshingRef.current) return
    if (!latestTimeRef.current || !userRef.current) return
    try {
      const r = await api<FeedResponse & { count: number }>(
        `/api/feed/fresh?userId=${encodeURIComponent(userRef.current.id)}&category=${encodeURIComponent(category)}&after=${encodeURIComponent(latestTimeRef.current)}`,
      )
      if (r.items.length > 0) {
        // Тихий аппенд в низ: без прыжков скролла, без тостов — посты просто
        // появляются ниже, когда пользователь долистает до них
        setItems((prev) => {
          const seen = new Set(prev.map((p) => p.id))
          const fresh: typeof r.items = []
          for (const x of r.items) {
            if (seen.has(x.id)) continue
            seen.add(x.id)
            fresh.push(x)
          }
          if (fresh.length === 0) return prev
          // свежая пачка встаёт в конец ленты — стык и хвост разводим по каналам
          return stitchNoRepeat([...prev, ...fresh], (p) => p.channel.id, Math.max(1, prev.length - 1))
        })
        const mx = r.items.map((x) => x.publishedAt).sort().pop()
        if (mx && mx > latestTimeRef.current) latestTimeRef.current = mx
      }
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

  // Pull-to-refresh: полная перезагрузка ленты с новым сидом перемешивания
  const refresh = useCallback(async () => {
    if (!userRef.current || busyRef.current) return
    setRefreshing(true)
    try {
      await load(0, true)
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
      // Ленивая регистрация: гость должен привязать Telegram, чтобы лайкать
      if (user.isGuest) {
        openAuthGate('like')
        haptic('light')
        return
      }
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
      // Ленивая регистрация: сохранение поста — момент для привязки Telegram
      if (user.isGuest) {
        openAuthGate('bookmark')
        haptic('light')
        return
      }
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
        // Подписка в один тап: локальная запись создана — открываем канал
        // в Telegram, где пользователь нажимает родную «Подписаться».
        // После возврата членство тихо сверится через Bot API.
        if (finalSubscribed && next) openChannelToJoin(ch.username)
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
          справа — колокольчик уведомлений с бейджем новых постов.
          relative z-20 — пилюля «N новых» (z-10) выползает ИЗ-ПОД этой панели */}
      <header className="relative z-20 shrink-0 bg-tg-bg" data-noswipe>
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

          {/* Колокольчик «Уведомления» — 40×40, бейдж: новые посты + активность (9+ при переполнении) */}
          <div className="shrink-0 px-3 pb-1.5 pt-2.5">
            <button
              type="button"
              onClick={openNotifications}
              aria-label={
                notifCount + unreadActivity > 0
                  ? `Уведомления: ${notifCount + unreadActivity}`
                  : 'Уведомления'
              }
              className="relative flex h-10 w-10 items-center justify-center rounded-full border border-tg-sep bg-tg-surface transition active:scale-90"
            >
              <Bell className="h-5 w-5 text-tg-text" strokeWidth={1.9} />
              <AnimatePresence>
                {notifCount + unreadActivity > 0 && (
                  <motion.span
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0, opacity: 0 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 24 }}
                    className="absolute -right-1 -top-1 flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-tg-like px-1 text-[10px] font-semibold leading-none text-white"
                  >
                    {notifCount + unreadActivity > 9 ? '9+' : notifCount + unreadActivity}
                  </motion.span>
                )}
              </AnimatePresence>
            </button>
          </div>
        </div>
        <div className="h-px w-full bg-tg-sep/60" aria-hidden />

        {/* Тулбар: поиск по загруженным постам + фильтры + сортировка */}
        <div className="flex items-center gap-1.5 px-3 pb-1.5 pt-1.5" data-noswipe>
          <div className="relative flex min-w-0 flex-1 items-center">
            <Search
              className="pointer-events-none absolute left-2.5 h-4 w-4 text-tg-hint"
              aria-hidden
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('toolbar.search')}
              aria-label={t('toolbar.searchAria')}
              className="h-8 w-full rounded-full border border-tg-sep bg-tg-surface pl-8 pr-7 text-[13.5px] text-tg-text outline-none transition-colors placeholder:text-tg-hint focus:border-tg-link/40"
            />
            {query.length > 0 && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label={t('toolbar.clear')}
                className="absolute right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-tg-sep text-tg-hint active:scale-90"
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            )}
          </div>
          <FilterChip
            active={mediaOnly}
            onClick={() => setMediaOnly((v) => !v)}
            label={t('toolbar.media')}
            Icon={ImageIcon}
            aria={t('toolbar.mediaAria')}
          />
          <FilterChip
            active={dayOnly}
            onClick={() => setDayOnly((v) => !v)}
            label={t('toolbar.day')}
            Icon={Clock3}
            aria={t('toolbar.dayAria')}
          />
          <FilterChip
            active={popularSort}
            onClick={() => setPopularSort((v) => !v)}
            label={t('toolbar.top')}
            Icon={Flame}
            aria={t('toolbar.topAria')}
          />
        </div>

        {/* Счётчик активных фильтров + сброс */}
        {filtersActive && (
          <div className="flex items-center gap-1 px-4 pb-1.5 text-[11.5px] leading-none text-tg-hint" data-noswipe>
            <span>
              {t('toolbar.shownPrefix')} {visibleItems.length} {t('toolbar.of')} {items.length}
            </span>
            {(query.trim().length > 0 || mediaOnly || dayOnly || popularSort) && (
              <button
                type="button"
                onClick={resetFilters}
                className="font-semibold text-tg-link active:opacity-60"
              >
                · {t('toolbar.reset')}
              </button>
            )}
            {hiddenIds.size > 0 && (
              <button
                type="button"
                onClick={() => {
                  setHiddenIds(new Set())
                  saveHidden(new Set())
                }}
                className="font-semibold text-tg-link active:opacity-60"
              >
                · {t('toolbar.unhide')} ({hiddenIds.size})
              </button>
            )}
          </div>
        )}
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

      {/* Сама лента — естественный скролл + pull-to-refresh */}
      <div
        ref={scrollRef}
        className="no-scrollbar relative min-h-0 flex-1 overflow-y-auto overscroll-contain pb-24"
        aria-label="Лента постов"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {/* Прогресс чтения ленты — волосная полоса под шапкой (ширина = доля прокрутки) */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-30 h-[2.5px]">
          <div
            ref={progressRef}
            className="h-full origin-left bg-tg-link/70"
            style={{ transform: 'scaleX(0)', opacity: 0, transition: 'opacity 150ms ease' }}
          />
        </div>
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
        ) : visibleItems.length === 0 ? (
          /* Фильтры/поиск отсекли всё — предлагаем сброс */
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-tg-surface">
              <Search className="h-7 w-7 text-tg-hint" aria-hidden />
            </span>
            <p className="text-[15px] font-semibold text-tg-text">{t('toolbar.empty')}</p>
            <p className="text-snippet text-tg-hint">{t('toolbar.emptyHint')}</p>
            <button
              type="button"
              onClick={() => {
                haptic('light')
                resetFilters()
                setHiddenIds(new Set())
                saveHidden(new Set())
              }}
              className="mt-1 h-10 rounded-full bg-tg-button px-5 text-[14px] font-semibold text-white active:scale-95"
            >
              {t('toolbar.resetFilters')}
            </button>
          </div>
        ) : (
          <>
            {/* На сайте (html[data-platform='web']) колонка шире — см. globals.css */}
            <div className="feed-col mx-auto w-full max-w-[600px] lg:border-x lg:border-tg-sep/40">
            {visibleItems.map((p, i) => (
              <Fragment key={p.id}>
                <PostCard
                  post={p}
                  appearDelay={staggerBatch ? Math.min(i, 6) * 0.04 : undefined}
                  onLike={() => onLike(p)}
                  onBookmark={() => onBookmark(p)}
                  onSubscribe={() => onSubscribe(p)}
                  onSummary={() => setSummaryPost(p)}
                  onHide={() => hidePost(p)}
                />
                {(i + 1) % 10 === 0 && ads.length > 0 && (
                  <AdCard ad={ads[Math.floor(i / 10) % ads.length]} />
                )}
                {/* Волосной разделитель между постами — структура ленты как в нативных клиентах */}
                {i < visibleItems.length - 1 && (
                  <div className="mx-4 h-px bg-tg-sep/40" aria-hidden />
                )}
              </Fragment>
            ))}

            <div ref={sentinelRef} className="h-2" aria-hidden />
            </div>

            {/* Спиннер догрузки: виден ТОЛЬКО пока реально идёт запрос следующей
                страницы (не при initial-скелетонах и не после конца ленты) —
                «пропадает, когда посты загрузились, появляется, когда закончились» */}
            {!initial && loading && hasMore && (
              <div className="flex justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-tg-hint" />
              </div>
            )}

            {/* Ошибка догрузки при скролле вниз: ненавязчивая кнопка вместо
                вечного ожидания — тап повторяет текущую страницу */}
            {!initial && !loading && hasMore && loadFailed && (
              <div className="flex justify-center py-4">
                <button
                  type="button"
                  onClick={() => {
                    haptic('light')
                    setLoadFailed(false)
                    load(page + 1, false)
                  }}
                  className="flex h-9 items-center gap-1.5 rounded-full border border-tg-sep bg-tg-surface px-4 text-[13px] font-medium text-tg-link transition active:scale-95"
                >
                  <AlertCircle className="h-3.5 w-3.5" aria-hidden />
                  {t('feed.retryLoad')}
                </button>
              </div>
            )}

            {!hasMore && (
              <div className="flex flex-col items-center px-8 py-10 text-center">
                <p className="text-[15px] font-semibold text-tg-text">{t('feed.endTitle')}</p>
                <p className="mt-1 text-snippet text-tg-hint">{t('feed.endHint')}</p>
                <button
                  type="button"
                  onClick={bumpFeed}
                  className="mt-4 h-10 rounded-full bg-tg-surface px-5 text-[14px] font-semibold text-tg-link active:scale-95"
                >
                  {t('feed.refresh')}
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
