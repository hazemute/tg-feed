'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowUp, Bell, Clock3, EyeOff, Flame, Image as ImageIcon, Inbox, Languages, Loader2, Search, WifiOff, X } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { toast } from 'sonner'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { haptic } from '@/lib/tg'
import { loadFeedCache, saveFeedCache } from '@/lib/offline'
import { prewarmUpcoming } from '@/lib/prewarm'
import type { LangFilter } from '@/lib/lang'
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
 * Фильтр языка ленты (v5.25): выбор пользователя между «всё / русский / другие».
 * Живёт в localStorage — это ПРЕДПОЧТЕНИЕ, как язык интерфейса: не сбрасывается
 * кнопкой «сбросить фильтры» и переживает перезагрузку.
 *
 * БАГФИКС (v5.33): ключ 'tgfeed_lang' ДЕЛИЛИ две несвязанные фичи — этот фильтр
 * (значения any/ru/foreign) и язык интерфейса (store.setLang, значения ru/en).
 * Итог: выбор языка интерфейса «Русский» втихую включал фильтр «только русские
 * посты», а переключение фильтра ломало язык интерфейса. Теперь у фильтра свой
 * ключ 'tgfeed_postlang' (старый остался языку интерфейса).
 */
const LANG_KEY = 'tgfeed_postlang'
const LANG_CYCLE: LangFilter[] = ['any', 'ru', 'foreign']
/** v5.66: дефолт «ru» — меньше нерусских постов (запрос владельца). Посты без
 * букв (мемы) в режиме ru всё равно проходят — лента не пустеет. Явно выбранный
 * фильтр сохранён в localStorage и не перезаписывается. */
const DEFAULT_LANG: LangFilter = 'ru'
function loadLangPref(): LangFilter {
  if (typeof window === 'undefined') return DEFAULT_LANG
  try {
    const raw = window.localStorage.getItem(LANG_KEY)
    return raw === 'ru' || raw === 'foreign' || raw === 'any' ? raw : DEFAULT_LANG
  } catch {
    return DEFAULT_LANG
  }
}
function saveLangPref(v: LangFilter) {
  try {
    window.localStorage.setItem(LANG_KEY, v)
  } catch {
    /* приватный режим */
  }
}

/**
 * Прогрев языковых вариантов (v5.27 — «зачем загрузка при выборе языка?»).
 * После каждой успешной загрузки страницы 0 тихо тянутся страницы 0 ДВУХ
 * других режимов языка с тем же сидом: сервер кладёт их в L0-кэш страницы,
 * а результаты держим и в памяти клиента. Тап по чипу языка подменяет ленту
 * МГНОВЕННО (0 мс по прогретому варианту), без скелетона и без запроса.
 * Бонус: прогрев окупается на сервере — индекс ленты уже собран, L0-кэш
 * тёплый для всех пользователей того же разреза.
 */
type PrefetchEntry = { data: FeedResponse; exp: number }
const langPrefetch = new Map<string, PrefetchEntry>()
const langPrefetchInflight = new Set<string>()
const LANG_PREFETCH_TTL_MS = 90_000

function prefetchKeyOf(userId: string, category: string, lang: LangFilter, seed: string): string {
  return `${userId}|${category}|${lang}|${seed}`
}

function prefetchOtherLangs(current: LangFilter, userId: string, category: string, seed: string): void {
  for (const l of LANG_CYCLE) {
    if (l === current) continue
    const key = prefetchKeyOf(userId, category, l, seed)
    const hit = langPrefetch.get(key)
    if (hit && hit.exp > Date.now()) continue
    if (langPrefetchInflight.has(key)) continue
    langPrefetchInflight.add(key)
    api<FeedResponse>(
      `/api/feed?userId=${encodeURIComponent(userId)}&category=${encodeURIComponent(category)}&page=0&limit=${PAGE_SIZE}&sh=${seed}&lang=${l}`,
      { signal: AbortSignal.timeout(30_000) },
    )
      .then((d) => {
        // амортизированная чистка протухших записей (карта крошечная — 2 ключа на разрез)
        if (langPrefetch.size > 24) {
          const now = Date.now()
          for (const [k, e] of langPrefetch) if (e.exp <= now) langPrefetch.delete(k)
        }
        /* v6.1.3: пустой ответ НЕ кэшируем. Прогрев уходит с тем же сидом, что
         * и основной запрос — если он поймал деградацию/блэк-дыру L0, раньше
         * пустота подменяла ленту МГНОВЕННО при тапе на чип языка (0 мс путь).
         * Теперь пустой прогрев просто не попадёт в карту — смена языка
         * пойдёт обычным путём и увидит живые данные. */
        if ((d.items?.length ?? 0) > 0) {
          langPrefetch.set(key, { data: d, exp: Date.now() + LANG_PREFETCH_TTL_MS })
        }
      })
      .catch(() => {
        /* тихо — переключение языка просто пойдёт обычным путём */
      })
      .finally(() => langPrefetchInflight.delete(key))
  }
}

/**
 * Prefetch СЛЕДУЮЩЕЙ страницы ленты (v5.57 — «догрузка без ожидания»).
 * После успешной загрузки страницы p тихо тянем p+1 с тем же сидом/разрезом:
 * ответ кладём в клиентскую память (и в серверный L0-кэш заодно). Когда
 * сентинел уйдёт вниз, append достанет страницу из карты мгновенно —
 * спиннер догрузки не появится вовсе. TTL короче языкового (страница
 * быстрее устаревает из-за вставки свежих постов шедулером).
 */
const pagePrefetch = new Map<string, PrefetchEntry>()
const pagePrefetchInflight = new Set<string>()
const PAGE_PREFETCH_TTL_MS = 45_000

function pagePrefetchKey(userId: string, category: string, lang: LangFilter, seed: string, p: number): string {
  return `${userId}|${category}|${lang}|${seed}|${p}`
}

function prefetchNextPage(next: number, userId: string, category: string, lang: LangFilter, seed: string): void {
  if (next < 1) return
  const key = pagePrefetchKey(userId, category, lang, seed, next)
  const hit = pagePrefetch.get(key)
  if (hit && hit.exp > Date.now()) return
  if (pagePrefetchInflight.has(key)) return
  pagePrefetchInflight.add(key)
  api<FeedResponse>(
    `/api/feed?userId=${encodeURIComponent(userId)}&category=${encodeURIComponent(category)}&page=${next}&limit=${PAGE_SIZE}&sh=${seed}&lang=${lang}`,
    { signal: AbortSignal.timeout(30_000) },
  )
    .then((d) => {
      if (pagePrefetch.size > 8) {
        const now = Date.now()
        for (const [k, e] of pagePrefetch) if (e.exp <= now) pagePrefetch.delete(k)
      }
      // v6.1.3: пустая страница не кэшируется в префетче (та же логика, что
      // и у языкового прогрева — пустота не должна подменяться мгновенно)
      if ((d.items?.length ?? 0) > 0) {
        pagePrefetch.set(key, { data: d, exp: Date.now() + PAGE_PREFETCH_TTL_MS })
      }
      // v5.60: медиа первых постов следующей страницы в idle — при свайпе
      // картинка уже в кэше браузера/edge, shimmer не появится
      prewarmUpcoming(d.items ?? [], false, 2, 4)
    })
    .catch(() => {
      /* тихо — обычная догрузка по сентинелу работает как раньше */
    })
    .finally(() => pagePrefetchInflight.delete(key))
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

/** Чип-фильтр тулбара: аккуратный, активный — с мягкой подложкой (v5.58) */
function FilterChip({
  active,
  onClick,
  label,
  Icon,
  aria,
  busy = false,
}: {
  active: boolean
  onClick: () => void
  label: string
  Icon: typeof Clock3
  aria: string
  /** короткая фоновая операция — иконка сменяется мини-спиннером (без блокировки чипа) */
  busy?: boolean
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
        'flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-4 text-[13.5px] font-medium transition active:scale-95',
        active
          ? 'border-transparent bg-tg-link/12 text-tg-link'
          : 'border-tg-sep/70 bg-tg-surface text-tg-hint',
      )}
    >
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin text-tg-link" aria-hidden />
      ) : (
        <Icon className={cn('h-4 w-4', active && 'text-tg-link')} aria-hidden />
      )}
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
  // Первая загрузка тянется дольше 7с (холодная пересборка индекса на дальнем
  // Supabase) — честный статус «готовим ленту» вместо мгновенной ошибки
  const [slowLoad, setSlowLoad] = useState(false)
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
  // Языковой фильтр (серверный): режет ленту в /api/feed, поэтому пагинация честная
  const [lang, setLang] = useState<LangFilter>(() => loadLangPref())
  const langRef = useRef(lang)
  langRef.current = lang
  // Смена языка идёт БЕЗ скелетона: старая лента остаётся на экране, сверху —
  // тонкий индикатор; прогретый вариант (prefetch) подменяется мгновенно
  const [langSwitching, setLangSwitching] = useState(false)
  // v5.66: гайд/другие экраны могут выставить фильтр языка после монтирования
  // ленты (WelcomeGuide ставит «ru» при первом входе) — перечитываем prefs
  useEffect(() => {
    const onLangPref = () => setLang(loadLangPref())
    window.addEventListener('tgfeed:langpref', onLangPref)
    return () => window.removeEventListener('tgfeed:langpref', onLangPref)
  }, [])
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

  /** Язык ленты: один тап циклит все → русский → другие → все (без выпадающих
   *  меню — тулбар не перегружается, выбор всегда виден на самом чипе).
   *  Предпочтение сохраняется в localStorage и НЕ сбрасывается «сбросить фильтры». */
  const cycleLang = useCallback(() => {
    setLang((prev) => {
      const next = LANG_CYCLE[(LANG_CYCLE.indexOf(prev) + 1) % LANG_CYCLE.length]
      saveLangPref(next)
      return next
    })
  }, [])
  const langLabel =
    lang === 'ru' ? t('toolbar.langRu') : lang === 'foreign' ? t('toolbar.langOther') : t('toolbar.lang')

  /** «Не интересно» (v5.10): скрывает ВЕСЬ канал, а не один пост.
   *  Жалоба владельца: раньше кнопка прятала только пост (локально), и канал
   *  продолжал лезть в ленту. Теперь: серверный мьют (ChannelMute — фильтр в
   *  /api/feed с редкими возвращениями) + мгновенная локальная фильтрация.
   *  Тост с «Вернуть» откатывает мьют. */
  /**
   * «Не интересно» (v5.68 — запрос владельца): скрываем КОНКРЕТНЫЙ ПОСТ,
   * а не весь канал. Серверный сигнал POST /api/notinterested → PostHide:
   * пост исчезает из ленты, канал остаётся, а тематика поста получает
   * отрицательный сигнал — похожие посты понижаются в приоритете.
   */
  const hidePost = useCallback(
    (post: { id: string; channel: { id: string; title: string } }) => {
      // гость «только читает» — шторка входа вместо записи
      if (user?.isGuest) {
        openAuthGate('mute')
        return
      }
      const pid = post.id
      setHiddenIds((prev) => {
        const next = new Set(prev).add(pid)
        saveHidden(next)
        return next
      })
      api('/api/notinterested', {
        method: 'POST',
        body: JSON.stringify({ postId: pid }),
      }).catch(() => {})
      toast(t('feed.postHiddenToast'), {
        description: t('feed.postHiddenHint'),
        action: {
          label: t('feed.unhideToast'),
          onClick: () => {
            setHiddenIds((prev) => {
              const next = new Set(prev)
              next.delete(pid)
              saveHidden(next)
              return next
            })
            api('/api/notinterested', {
              method: 'DELETE',
              body: JSON.stringify({ postId: pid }),
            }).catch(() => {})
          },
        },
      })
    },
    [t, user, openAuthGate],
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

  /* Порядковый номер запроса: эффект [user, category, feedVersion] при быстрой
   * смене категории принудительно снимает busyRef и стартует новую загрузку, пока
   * предыдущая ещё в полёте. Ответ старой (медленной) категории не должен
   * перезаписать свежую ленту — все сет-стейты применяются только если номер
   * запроса всё ещё актуален. */
  const loadSeqRef = useRef(0)
  const load = useCallback(
    async (
      p: number,
      replace: boolean,
      isRetry = false,
      opts?: { silent?: boolean; keepSeed?: boolean },
    ) => {
      if (!userRef.current || busyRef.current) return
      busyRef.current = true
      const seq = ++loadSeqRef.current
      // silent (смена языка): лента остаётся на экране — спиннеры не мигаем
      if (!opts?.silent) setLoading(true)
      const slowTimer = setTimeout(() => setSlowLoad(true), 7000)
      try {
        // Новый сид перемешивания при каждой полной перезагрузке ленты —
        // «Обновить» показывает ДРУГИЙ порядок постов; внутри сессии порядок стабилен.
        // keepSeed (смена языка): сид сохраняем — страница уже прогрета сервером
        // и prefetch’ем ровно с этим сидом, ответ приходит мгновенно.
        if ((replace && !opts?.keepSeed) || !seedRef.current)
          seedRef.current = Math.random().toString(36).slice(2, 12)
        /* Свой терпеливый таймаут 45с вместо дефолтных 20с из api(): холодная
           пересборка ленты (дальний Supabase, пустой индекс) занимает ~20-35с —
           дефолт обрубал ответ ровно в момент, когда сервер почти отвечал.
           «Бесконечной загрузки» нет: ниже авто-ретрай и статус-пилюля. */
        // v5.57: страница ужеprefetch’нута после прошлой загрузки — отдаём
        // мгновенно, без сети (мимо — обычный запрос)
        const pfKey = pagePrefetchKey(userRef.current.id, category, langRef.current, seedRef.current, p)
        const pfHit = pagePrefetch.get(pfKey)
        const data: FeedResponse =
          pfHit && pfHit.exp > Date.now()
            ? (pagePrefetch.delete(pfKey), pfHit.data)
            : await api<FeedResponse>(
                `/api/feed?userId=${encodeURIComponent(userRef.current.id)}&category=${encodeURIComponent(category)}&page=${p}&limit=${PAGE_SIZE}&sh=${seedRef.current}&lang=${langRef.current}`,
                { signal: AbortSignal.timeout(45_000) },
              )
        // Ответ устарел (категория/язык сменились, пока летел запрос) — молча discard
        if (seq !== loadSeqRef.current) return
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
        /* v6.1.3: авто-самолечение — страница 0 пришла ПУСТОЙ при активном
         * языковом фильтре. Один тихий ретрай с НОВЫМ сидом (replace без
         * keepSeed перегенерирует его сам) обходит застрявшую пустоту L0-
         * кэша/снапшота прошлого запроса. Если постов реально нет — после
         * ретрая честно покажется пустое состояние с кнопкой «Показать
         * все языки». */
        if (replace && p === 0 && incoming.length === 0 && !isRetry && langRef.current !== 'any') {
          busyRef.current = false
          clearTimeout(slowTimer)
          await load(0, true, true)
          return
        }
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
        // v5.57: сразу догреваем СЛЕДУЮЩУЮ страницу того же разреза —
        // append у сентинела станет мгновенным (память клиента + L0 сервера)
        if (!feedOver && data.hasMore && userRef.current)
          void prefetchNextPage(p + 1, userRef.current.id, category, langRef.current, seedRef.current)
        // v5.60: медиа/аватары постов, которые юзер вот-вот увидит, — в idle-загрузку
        prewarmUpcoming(incoming)
        // Кэшируем свежую страницу (офлайн-режим) — раздельно по языку
        if (replace) {
          void saveFeedCache(category, data.items, langRef.current)
          // Прогрев двух других языковых вариантов: их страница 0 ляжет и в
          // серверный L0-кэш, и в клиентскую память — смена языка станет мгновенной
          void prefetchOtherLangs(langRef.current, userRef.current.id, category, seedRef.current)
        } else void saveFeedCache(category, [...itemsRef.current, ...data.items], langRef.current)
      } catch (e) {
        // Ошибка устаревшего запроса — не трогаем состояние свежей загрузки
        if (seq !== loadSeqRef.current) return
        // Таймаут первой страницы (холодный кэш) — ОДИН тихий ретрай, прежде чем
        // показывать ошибку: сервер почти всегда успевает со второй попытки
        const isTimeout = (e as { name?: string } | null)?.name === 'TimeoutError'
        if (p === 0 && replace && !isRetry && isTimeout) {
          busyRef.current = false
          clearTimeout(slowTimer)
          setSlowLoad(true) // прошлый заход уже тянулся 45с — статус сразу
          await load(0, true, true)
          return
        }
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
        // Общие флаги (busy/спиннеры/скелетон) сбрасывает только СВЕЖИЙ запрос —
        // иначе поздний ответ старой категории снимал бы скелетон новой
        if (seq === loadSeqRef.current) {
          clearTimeout(slowTimer)
          setSlowLoad(false)
          busyRef.current = false
          setLoading(false)
          setInitial(false)
          // Если сентинел уже в кадре (короткий контент/быстрый скролл) — догружаем сразу.
          // Через таймаут, чтобы React успел закоммитить обновлённые page/hasMore.
          setTimeout(() => checkRef.current(), 80)
        }
      }
    },
    [category],
  )

  // v5.54: свежие ссылки для отложенных вызовов — эффект смены языка ждёт до 30с
  // освобождения busyRef и раньше звал УСТАРЕВШИЙ load (старая категория): смена
  // категории во время ожидания перезаписывала новую ленту постами старой
  const loadRef = useRef(load)
  const categoryRef = useRef(category)
  useEffect(() => {
    loadRef.current = load
    categoryRef.current = category
  }, [load, category])

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
    setQuery('') // поиски разных категорий/языков не смешиваются
    // Stale-while-revalidate: мгновенно показываем кэш, сеть догонит
    void loadFeedCache(category, lang).then((cached) => {
      if (cached.length > 0 && !itemsRef.current.length) {
        setItems(cached)
        setInitial(false)
      }
    })
    load(0, true)
    scrollRef.current?.scrollTo({ top: 0 })
    // ЯЗЫК НЕ В ЗАВИСИМОСТЯХ (v5.27): его смена обрабатывается ниже отдельным
    // эффектом — без скелетона и ресета, мгновенной подменой прогретого варианта
  }, [user, category, feedVersion, load])

  /* ---------- Смена языка: мгновенно, без «зачем загрузка» ----------
   * 1) прогретый prefetch — подмена без сети (0 мс);
   * 2) офлайн-кэш этого языка — мгновенный stale-paint, сеть догонит;
   * 3) сеть с тем же сидом — сервер отвечает из L0-кэша страницы (тепло от прогрева).
   * Старая лента всё это время на экране, сверху тонкий индикатор. */
  const langSwitchSeqRef = useRef(0)
  const langInitialRef = useRef(true)
  useEffect(() => {
    if (langInitialRef.current) {
      langInitialRef.current = false // на монтировании лента грузится основным эффектом
      return
    }
    if (!userRef.current) return
    const category_ = category
    const seq = ++langSwitchSeqRef.current
    setLangSwitching(true)
    const run = async () => {
      try {
        // Если уже идёт загрузка (смена категории/refresh) — ждём её конца,
        // иначе busyRef съест наш запрос и язык разъедется с данными
        for (let i = 0; busyRef.current && i < 200; i++) {
          await new Promise((r) => setTimeout(r, 150))
        }
        // За время ожидания сменилась категория или началась другая смена языка — выходим,
        // актуальную загрузку сделает эффект категории/новая смена языка
        if (seq !== langSwitchSeqRef.current || !userRef.current) return
        if (categoryRef.current !== category_) return
        const uid = userRef.current.id

        // 1) Мгновенная подмена прогретого варианта
        const hit = langPrefetch.get(prefetchKeyOf(uid, category_, lang, seedRef.current))
        if (hit && hit.exp > Date.now()) {
          const seen = new Set<string>()
          const incoming: PostDTO[] = []
          for (const p of hit.data.items) {
            if (!seen.has(p.id)) {
              seen.add(p.id)
              incoming.push(p)
            }
          }
          setItems(stitchNoRepeat(incoming, (p) => p.channel.id))
          emptyStreakRef.current = 0
          setPage(0)
          setHasMore(hit.data.hasMore)
          setLoadFailed(false)
          setOffline(false)
          void saveFeedCache(category_, incoming, lang)
          return
        }

        // 2) Stale-paint из офлайн-кэша (если текущий экран пуст)
        void loadFeedCache(category_, lang).then((cached) => {
          if (cached.length > 0 && !itemsRef.current.length) setInitial(false)
        })

        // 3) Сеть: тот же сид → серверный L0-кэш тёплый от прогрева
        await loadRef.current(0, true, false, { silent: true, keepSeed: true })
      } finally {
        if (seq === langSwitchSeqRef.current) setLangSwitching(false)
      }
    }
    void run()
  }, [lang])

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
  // там же императивно обновляем тонкий прогресс-бар чтения (без ререндеров).
  // v5.58 (60 FPS): rAF-троттлинг — тяжелее одного кадра не работаем, а
  // setShowTop зовём только при ПЕРЕСЕЧЕНИИ порога (не каждый кадр скролла).
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let raf = 0
    let lastShown = false
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const shouldShow = el.scrollTop > 700
        if (shouldShow !== lastShown) {
          lastShown = shouldShow
          setShowTop(shouldShow)
        }
        const max = el.scrollHeight - el.clientHeight
        const p = max > 0 ? Math.min(1, el.scrollTop / max) : 0
        if (progressRef.current) {
          progressRef.current.style.transform = `scaleX(${p})`
          progressRef.current.style.opacity = p > 0.005 ? '1' : '0'
        }
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
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
        `/api/feed/fresh?userId=${encodeURIComponent(userRef.current.id)}&category=${encodeURIComponent(category)}&after=${encodeURIComponent(latestTimeRef.current)}&lang=${langRef.current}`,
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
    // v5.89: 45с → 75с — экономим Fluid Active CPU (был 3ч9м из 4ч лимита):
    // каждый тик = функция (auth+SQL+парсер свежаков в after). Пилюля «новое»
    // догадывается на ~минуту позже — для ленты с тихим аппендом это незаметно
    const iv = setInterval(checkFresh, 75_000)
    const t = setTimeout(checkFresh, 6000)
    return () => {
      clearInterval(iv)
      clearTimeout(t)
    }
  }, [user, initial, checkFresh])

  // ---------- v5.88: ПОЛЛИНГ вместо SSE (срочная экономия Vercel Fluid) ----------
  // Раньше здесь открывался ВЕЧНЫЙ SSE-поток (/api/events, heartbeat 25с):
  // на Vercel Fluid compute каждое открытое соединение держит ~1 GB
  // provisioned memory ВСЁ время соединения — несколько онлайн-пользователей
  // сжигали сотни GB-hrs/мес (алерт «75% Fluid Provisioned Memory»).
  // Заменили дешёвым поллингом: свежие посты — checkFresh каждые 75с
  // (эффект выше), бейдж уведомлений — каждые 120с здесь (v5.89: 60с → 120с,
  // вторая причина — Fluid Active CPU 3ч9м/4ч). Задержка живости ≤2 мин,
  // активное время функций — на ~2 порядка ниже вечного SSE.
  useEffect(() => {
    if (!user) return
    const iv = setInterval(() => void fetchNotifCount(), 120_000)
    return () => clearInterval(iv)
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

  /* v5.35: защита от двойного тапа по лайку/закладке — пока запрос по этому посту
   * в полёте, повторные тапы игнорируются. Раньше быстрый двойной тап успевал
   * дважды перевернуть оптимистичный флаг и отправить два toggle-запроса:
   * лайк ставился и тут же снимался (двойной расход счётчика и запросов). */
  const inflightActionsRef = useRef<Set<string>>(new Set())
  const actionInflight = (key: string) => {
    if (inflightActionsRef.current.has(key)) return true
    inflightActionsRef.current.add(key)
    return false
  }
  const actionSettled = (key: string) => {
    inflightActionsRef.current.delete(key)
  }

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
      const key = `like:${post.id}`
      if (actionInflight(key)) return
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
      } finally {
        actionSettled(key)
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
      const key = `bm:${post.id}`
      if (actionInflight(key)) return
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
      } finally {
        actionSettled(key)
      }
    },
    [user, updatePost],
  )

  const onSubscribe = useCallback(
    async (post: PostDTO) => {
      if (!user) return
      // v5.54: гость не подписывается (раньше legacy-гость молча создавал записи)
      if (user.isGuest) {
        openAuthGate('subscribe')
        return
      }
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
      {/* v5.58 РЕДИЗАЙН ШАПКИ: разгрузка верхней части. Категории — аккуратные
          скроллящиеся пилюли лёгкого веса (вместо крупных заголовков с чертой),
          фильтры — с воздухом (gap/px увеличены). Справа — колокольчик.
          relative z-20 — пилюля «N новых» (z-10) выползает ИЗ-ПОД этой панели.
          На ПК (lg+) шапка центрируется с капом 1280 — на фулл-ширине окна
          поиск/чипы не тянутся на весь экран (владелец: «фулл, но не растянуто»). */}
      <header className="relative z-20 shrink-0 bg-tg-bg lg:mx-auto lg:w-full lg:max-w-[1280px]" data-noswipe>
        <div className="flex items-start pt-2.5">
          {/* Категории — скроллящиеся табы: лёгкий визуальный вес, крупная
              тач-зона (h-10), активная — мягкая заливка акцентом */}
          <div
            className="no-scrollbar fade-x flex min-w-0 flex-1 items-center gap-2 overflow-x-auto px-3 pb-1"
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
                    'relative flex h-10 shrink-0 items-center rounded-full px-4 text-[14.5px] leading-none transition-all active:scale-95',
                    active
                      ? 'bg-tg-link font-semibold text-white shadow-sm shadow-tg-link/25'
                      : 'bg-tg-surface/80 font-medium text-tg-hint',
                  )}
                >
                  {t.title}
                </button>
              )
            })}
          </div>

          {/* Колокольчик «Уведомления» — 40×40, бейдж: новые посты + активность (9+ при переполнении) */}
          <div className="shrink-0 px-3 pb-1">
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
        <div className="h-px w-full bg-tg-sep/50" aria-hidden />

        {/* Тулбар (v5.58): поиск — строка на всю ширину с воздухом, чипы — ниже
            с увеличенными отступами: элементы больше не слипаются */}
        <div className="px-3 pb-2 pt-2.5" data-noswipe>
          <div className="relative flex min-w-0 items-center">
            <Search
              className="pointer-events-none absolute left-3 h-4 w-4 text-tg-hint"
              aria-hidden
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('toolbar.search')}
              aria-label={t('toolbar.searchAria')}
              className="h-10 w-full rounded-full border border-tg-sep bg-tg-surface pl-9 pr-9 text-[14px] text-tg-text outline-none transition-colors placeholder:text-tg-hint focus:border-tg-link/40"
            />
            {query.length > 0 && (
              /* Тач-таргет 28px вокруг видимого кружка 20px — по нему реально
                 проще попасть пальцем, при этом визуально кнопка не изменилась */
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label={t('toolbar.clear')}
                className="absolute right-1.5 flex h-7 w-7 items-center justify-center rounded-full text-tg-hint active:scale-90"
              >
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-tg-sep">
                  <X className="h-3 w-3" aria-hidden />
                </span>
              </button>
            )}
          </div>
        </div>
        <div className="no-scrollbar fade-x flex items-center gap-2.5 overflow-x-auto px-3 pb-2.5 pt-1" data-noswipe>
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
          <FilterChip
            active={lang !== 'any'}
            onClick={cycleLang}
            label={langLabel}
            Icon={Languages}
            aria={t('toolbar.langAria')}
            busy={langSwitching}
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
            className="overflow-hidden bg-tg-star/10"
          >
            <div className="flex items-center justify-center gap-2 px-4 py-1.5 text-[12.5px] font-medium text-tg-star">
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
        {/* Смена языка (v5.27): тонкая бегущая полоска вместо скелетона — лента
            остаётся на экране, новый вариант подменяется как только готов */}
        {langSwitching && (
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-40 h-[2.5px] overflow-hidden">
            <div className="prof-langbar h-full w-1/4 bg-tg-link/80" />
          </div>
        )}
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
          <>
            <FeedSkeleton />
            {/* Долгая первая загрузка (холодная пересборка индекса): честный
                статус вместо мгновенной ошибки — лента готовится, уже тянем */}
            {slowLoad ? (
              <div className="pointer-events-none sticky bottom-24 z-20 flex justify-center">
                <span
                  role="status"
                  className="flex items-center gap-2 rounded-full bg-tg-surface/95 px-4 py-2 text-[13px] font-medium text-tg-hint shadow-lg shadow-black/10 backdrop-blur"
                >
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  Готовим ленту — это занимает до минуты
                </span>
              </div>
            ) : null}
          </>
        ) : items.length === 0 && loadFailed ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <span className="flex size-16 items-center justify-center rounded-full bg-tg-like/10 text-tg-like" aria-hidden>
              <AlertCircle className="size-8" strokeWidth={1.7} />
            </span>
            <p className="text-[15px] font-semibold text-tg-text">Не удалось загрузить ленту</p>
            <p className="text-snippet text-tg-hint">Проверьте соединение и попробуйте ещё раз</p>
            <button
              type="button"
              onClick={bumpFeed}
              className="press mt-1 h-10 rounded-full bg-tg-surface px-5 text-[14px] font-semibold text-tg-link"
            >
              Обновить
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <span className="flex size-16 items-center justify-center rounded-full bg-tg-link/10 text-tg-link" aria-hidden>
              <Inbox className="size-8" strokeWidth={1.7} />
            </span>
            <p className="text-[15px] font-semibold text-tg-text">Здесь пока пусто</p>
            <p className="text-snippet text-tg-hint">
              {lang !== 'any'
                ? `Для фильтра языка «${langLabel}» постов не нашлось. Нажмите «Язык» в тулбаре, чтобы показать все языки`
                : 'Подпишитесь на каналы или посмотрите популярные'}
            </p>
            {/* v6.1.3: честный выход одним тапом. Раньше пустота с языковым
                фильтром предлагала только «Открыть поиск» — а владелец с
                включённым «Русский» видел «0 из 0» без очевидного выхода. */}
            {lang !== 'any' ? (
              <div className="mt-1 flex flex-col items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    haptic('light')
                    saveLangPref('any')
                    setLang('any') // [lang]-эффект сам перезагрузит ленту (silent, без скелетона)
                  }}
                  className="press h-10 rounded-full bg-tg-button px-5 text-[14px] font-semibold text-white"
                >
                  Показать все языки
                </button>
                <button
                  type="button"
                  onClick={() => {
                    haptic('light')
                    bumpFeed()
                  }}
                  className="press h-10 rounded-full bg-tg-surface px-5 text-[14px] font-semibold text-tg-link"
                >
                  Обновить ленту
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  haptic('light')
                  openSearchWith('')
                }}
                className="press mt-1 h-10 rounded-full bg-tg-button px-5 text-[14px] font-semibold text-white"
              >
                Открыть поиск
              </button>
            )}
          </div>
        ) : visibleItems.length === 0 ? (
          /* Фильтры/поиск отсекли всё — предлагаем сброс */
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <span className="flex size-16 items-center justify-center rounded-full bg-tg-link/10 text-tg-link" aria-hidden>
              <Search className="size-8" strokeWidth={1.7} />
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
              className="press mt-1 h-10 rounded-full bg-tg-button px-5 text-[14px] font-semibold text-white"
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
                  /* v5.91: хендлеры передаются напрямую (useCallback, пост — аргументом):
                     memo(PostCard) пропускает рендер карточек при чейнджах вне их пропсов */
                  onLike={onLike}
                  onBookmark={onBookmark}
                  onSubscribe={onSubscribe}
                  onSummary={setSummaryPost}
                  onHide={hidePost}
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
            className="absolute bottom-24 right-4 z-20 flex h-11 w-11 items-center justify-center rounded-full bg-tg-button text-white shadow-lg shadow-black/25 transition active:scale-90 motion-reduce:transition-none"
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
        <div className="tg-shimmer h-[46px] w-[46px] rounded-full" />
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
        <div className="tg-shimmer h-[46px] w-[46px] rounded-full" />
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
