'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, History, Plus, Search, SearchX, Trash2, TrendingUp, X, Check, Sparkles, RefreshCw } from 'lucide-react'
import { motion } from 'framer-motion'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api, apiCached, invalidateApiCache } from '@/lib/api'
import { useApp } from '@/lib/store'
import { stripMarkdown } from '@/lib/markdown'
import { formatCount, pluralRu, timeAgoRu } from '@/lib/format'
import { haptic } from '@/lib/tg'
import {
  clearSearchHistory,
  loadSearchHistory,
  removeSearchQuery,
  saveSearchQuery,
} from '@/lib/search-history'
import type { ChannelDTO, PostDTO, SearchResponse } from '@/lib/types'
import { Avatar } from '@/components/tg/Avatar'
import { VerifiedBadge } from '@/components/tg/VerifiedBadge'
import { AiChat } from '@/components/ai/AiChat'

type Filter = 'channels' | 'topics' | 'posts'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'channels', label: 'Каналы' },
  { id: 'topics', label: 'Темы' },
  { id: 'posts', label: 'Посты' },
]

/**
 * Экран «Поиск» по макету: крупный заголовок, поле, чипы Каналы/Темы/Посты,
 * каталог каналов с кнопками «+ Подписаться» + ОТДЕЛЬНЫЙ ЧАТ ИИ-ПОИСКА
 * (v5.21): кнопка «Спросить ИИ» открывает полноценный чат с инструментами,
 * markdown и источниками.
 */
export function SearchTab() {
  const { user, categories, setCategory, setTab, openChannel, searchSeed, clearSearchSeed, openAuthGate } =
    useApp()
  // Внешний запрос (тап по хэштегу в ленте / «Открыть поиск» из пустой ленты)
  // приходит ВСЕГДА до монтирования экрана: хэштеги и пустая лента живут только
  // в FeedView, а вкладки размонтируются при переключении — поэтому seed читаем
  // в инициализаторах state. Эффект ниже ищет и сбрасывает seed.
  const [filter, setFilter] = useState<Filter>(() =>
    searchSeed !== null && searchSeed.trim().length >= 2 ? 'posts' : 'channels',
  )
  const [q, setQ] = useState(() => searchSeed ?? '')
  const needle = q.trim().toLowerCase()

  const [channels, setChannels] = useState<ChannelDTO[] | null>(null)
  const [posts, setPosts] = useState<{ q: string; items: PostDTO[] } | null>(null)
  const [searching, setSearching] = useState(false)
  // Поле в фокусе — показываем блок «Недавние запросы» при пустом запросе
  const [inputFocused, setInputFocused] = useState(false)
  // Экран рендерится только после клиентской авторизации (authReady), SSR не задет
  const [recent, setRecent] = useState<string[]>(() => loadSearchHistory())
  const inputRef = useRef<HTMLInputElement>(null)
  // Счётчик поисковых запросов: ответ устаревшего запроса игнорируется (защита от гонок)
  const searchSeq = useRef(0)
  // Тренды «Сейчас обсуждают» (топ-8 хэштегов: клики за 72ч + фолбэк из постов)
  const [trending, setTrending] = useState<{ tag: string; clicks: number }[] | null>(null)

  // ОТДЕЛЬНЫЙ ЧАТ Snap Search (v5.21): открыт/закрыт + seed-запрос для автоотправки
  const [aiChatOpen, setAiChatOpen] = useState(false)
  const [aiSeed, setAiSeed] = useState<string | null>(null)
  // Защита от двойного тапа по «Подписаться»: пока запрос в полёте, повторные
  // тапы игнорируются (иначе двойной тап успевает перевернуть флаг дважды —
  // «подписался и тут же отписался»; бэкенд идемпотентен, но UX ломается)
  const subInflightRef = useRef<Set<string>>(new Set())

  // Тренды хэштегов: кэшированный запрос (повторное открытие вкладки — мгновенно)
  useEffect(() => {
    let alive = true
    apiCached<{ items: { tag: string; clicks: number }[] }>('/api/hashtags/trending', 120_000)
      .then((r) => {
        if (alive) setTrending(r.items)
      })
      .catch(() => {
        // тихо — блок просто не покажется
      })
    return () => {
      alive = false
    }
  }, [])

  const query = q.trim()
  const postResults = posts && posts.q === query && query.length >= 2 ? posts.items : null
  // Блок истории — при фокусе поля и пустом запросе (иначе на его месте рельс популярных)
  const showHistory = q === '' && inputFocused && recent.length > 0
  const userId = user?.id

  /** Единая точка поиска по постам (используется дебаунсом и сабмитом) */
  const runPostsSearch = useCallback(
    (rawQuery: string) => {
      const term = rawQuery.trim()
      if (term.length < 2) return
      const seq = ++searchSeq.current
      setSearching(true)
      const qs = new URLSearchParams({ q: term })
      if (userId) qs.set('userId', userId)
      api<SearchResponse>(`/api/search?${qs.toString()}`)
        .then((r) => {
          if (searchSeq.current !== seq) return
          setPosts({ q: term, items: r.items })
          // Успешный поиск с непустым результатом — сохраняем запрос в историю
          if (r.items.length > 0) setRecent(saveSearchQuery(term))
        })
        .catch(() => {
          if (searchSeq.current === seq) toast.error('Поиск недоступен')
        })
        .finally(() => {
          if (searchSeq.current === seq) setSearching(false)
        })
    },
    // userId меняется один раз при авторизации — идентичность колбэка стабильна
    [userId],
  )

  // Поиск по постам (дебаунс 350мс)
  useEffect(() => {
    if (needle.length < 2) return
    const t = setTimeout(() => runPostsSearch(q), 350)
    return () => clearTimeout(t)
  }, [needle, q, runPostsSearch])

  // Внешний запрос: запускаем поиск по seed и сбрасываем его (поле и фильтр уже
  // заполнены в инициализаторах выше). Смена seed при УЖЕ смонтированном экране
  // в текущем приложении невозможна (источники seed — только вкладка ленты).
  useEffect(() => {
    if (searchSeed === null) return
    const seed = searchSeed
    clearSearchSeed() // сбрасываем сразу — защита от повторного срабатывания
    if (seed.trim().length < 2) return
    // Мгновенный запуск поиска — через таймаут, чтобы не звать state-колбэки
    // синхронно в теле эффекта (react-hooks/set-state-in-effect);
    // повторный дебаунс с тем же термом безвреден (seq-защита в runPostsSearch)
    const t = setTimeout(() => runPostsSearch(seed), 0)
    return () => clearTimeout(t)
  }, [searchSeed, clearSearchSeed, runPostsSearch])

  /** Тап по чипу недавних: подставляем запрос и сразу запускаем поиск */
  const applyQuery = (rq: string) => {
    haptic('light')
    setQ(rq)
    runPostsSearch(rq) // мгновенный запуск; повторный дебаунс с тем же термом безвреден (seq)
  }

  /** Enter в поле (submit формы): сохраняем запрос всегда, ищем сразу */
  const submitSearch = () => {
    const term = q.trim()
    if (!term) return
    haptic('light')
    setRecent(saveSearchQuery(term)) // сабмит сохраняет даже при пустых результатах
    runPostsSearch(term)
    inputRef.current?.blur() // прячем клавиатуру — смотрим результаты
  }

  /** Удалить один запрос из истории (крестик на чипе) */
  const removeOne = (rq: string) => {
    haptic('light')
    setRecent(removeSearchQuery(rq))
  }

  /** Полностью очистить историю */
  const clearAll = () => {
    haptic('light')
    setRecent(clearSearchHistory())
  }

  // Каталог каналов: кэшированный GET — вкладка «Поиск» открывается без ожидания
  // (фильтрация на клиенте — для кириллицы SQLite LIKE не подходит)
  // v5.76: РОТАЦИЯ КАТАЛОГА — дефолтный сид меняется ежечасно, кнопка
  // «Обновить» даёт полностью новый порядок каналов по требованию
  const [rotSeed, setRotSeed] = useState(() => String(Math.floor(Date.now() / 3_600_000)))
  const [rotating, setRotating] = useState(false)
  useEffect(() => {
    const qs = new URLSearchParams()
    if (user) qs.set('userId', user.id)
    qs.set('rot', rotSeed)
    let alive = true
    apiCached<{ items: ChannelDTO[] }>(`/api/channels?${qs.toString()}`, 90_000)
      .then((d) => {
        if (alive) setChannels(d.items)
      })
      .catch(() => {
        // v5.54: сетевой сбой ≠ пустой каталог — раньше сбой рендерил
        // «Каналы не найдены» и не оставлял шанса на повтор
        if (alive) setChannels((prev) => prev ?? [])
      })
    return () => {
      alive = false
    }
  }, [user?.id, rotSeed])

  /** Полностью перемешать каталог: новый сид → глобально другой порядок */
  const rotateCatalog = () => {
    haptic('select')
    setRotating(true)
    setRotSeed(String(Date.now()))
    window.setTimeout(() => setRotating(false), 450)
  }

  const matchedChannels = useMemo(() => {
    if (!channels) return null
    if (needle.length < 2) return channels
    return channels.filter((c) =>
      [c.title, c.username, c.description ?? '', c.categoryTitle ?? '']
        .join(' ')
        .toLowerCase()
        .includes(needle),
    )
  }, [channels, needle])

  const matchedTopics = useMemo(() => {
    if (needle.length < 2) return categories
    return categories.filter((c) => c.title.toLowerCase().includes(needle))
  }, [categories, needle])

  const toggleSub = async (ch: ChannelDTO) => {
    if (!user) return
    if (subInflightRef.current.has(ch.id)) return
    subInflightRef.current.add(ch.id)
    const next = !ch.subscribed
    setChannels((prev) =>
      (prev ?? []).map((c) =>
        c.id === ch.id
          ? {
              ...c,
              subscribed: next,
              subscribersCount: Math.max(0, c.subscribersCount + (next ? 1 : -1)),
            }
          : c,
      ),
    )
    haptic('light')
    try {
      await api('/api/subscribe', {
        method: 'POST',
        body: JSON.stringify({ userId: user.id, channelId: ch.id }),
      })
      // Каталог в кэше устарел (флаг подписки) — при следующем открытии перезагрузим
      invalidateApiCache('/api/channels')
      toast.success(next ? `Вы подписались на «${ch.title}»` : `Вы отписались от «${ch.title}»`)
    } catch {
      setChannels((prev) =>
        (prev ?? []).map((c) =>
          c.id === ch.id
            ? {
                ...c,
                subscribed: !next,
                subscribersCount: Math.max(0, c.subscribersCount + (next ? -1 : 1)),
              }
            : c,
        ),
      )
      toast.error('Ошибка подписки')
    } finally {
      subInflightRef.current.delete(ch.id)
    }
  }

  return (
    <div className="no-scrollbar h-full w-full overflow-y-auto overscroll-contain pb-24">
      {/* Центрированная колонка: поиск не растягивается на весь широкий экран */}
      <div className="mx-auto w-full max-w-[1000px]">
      {/* Заголовок */}
      <header className="px-4 pb-3 pt-4">
        <h1 className="text-screen-title text-tg-text">Поиск</h1>
        <p className="mt-1 text-[15px] text-tg-hint">Найти каналы и темы</p>
      </header>

      {/* Липкая шапка: поле + чипы остаются при прокрутке */}
      <div className="sticky top-0 z-10 bg-tg-bg px-4 pb-3">
        {/* Форма: Enter в поле — сабмит (мгновенный поиск + сохранение в историю) */}
        <form
          className="relative"
          onSubmit={(e) => {
            e.preventDefault()
            submitSearch()
          }}
        >
          <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-tg-hint" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            placeholder="Поиск каналов, тем, постов"
            aria-label="Поиск каналов, тем, постов"
            className="h-[52px] w-full rounded-[14px] border border-tg-sep bg-tg-bg pl-11 pr-[76px] text-[16px] text-tg-text outline-none transition placeholder:text-tg-hint focus:border-tg-link"
          />
          {/* v5.68: ИИ-поиск ПРЯМО В СТРОКЕ — кнопка-спарк справа: «Спросить нейросеть» */}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              haptic('light')
              inputRef.current?.blur()
              setAiSeed(q.trim().length >= 3 ? q.trim() : null)
              setAiChatOpen(true)
            }}
            aria-label="Спросить нейросеть по постам ленты"
            title="ИИ-поиск: спросить нейросеть по постам ленты"
            className="absolute right-2.5 top-1/2 flex h-9 -translate-y-1/2 items-center gap-1 rounded-full bg-tg-link/10 px-2.5 text-tg-link transition active:scale-95"
          >
            <Sparkles className="h-4.5 w-4.5" strokeWidth={2.2} aria-hidden />
            <span className="text-[12.5px] font-bold">ИИ</span>
          </button>
          {q && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault() /* не уводим фокус из поля */}
              onClick={() => setQ('')}
              aria-label="Очистить"
              className="absolute right-[68px] top-1/2 -translate-y-1/2 rounded-full p-1.5 text-tg-hint active:bg-tg-surface"
            >
              <X className="h-4.5 w-4.5" />
            </button>
          )}
        </form>

        {/* Чипы-фильтры + пилюля Snap Search (на узких экранах переносится ниже чипов) */}
        <div className="mt-4 flex flex-wrap items-center gap-2.5">
          <div className="flex gap-2.5" role="tablist" aria-label="Тип поиска">
            {FILTERS.map((f) => {
              const active = filter === f.id
              return (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    haptic('light')
                    setFilter(f.id)
                  }}
                  className={cn(
                    'h-10 rounded-full px-5 text-[15px] font-medium transition active:scale-95',
                    active ? 'bg-tg-link text-white' : 'bg-tg-surface text-tg-text',
                  )}
                >
                  {f.label}
                </button>
              )
            })}
          </div>
          <button
            type="button"
            onClick={() => {
              haptic('light')
              inputRef.current?.blur() // прячем клавиатуру — смотрим чат ИИ-поиска
              setAiSeed(query.length >= 3 ? query : null) // с текущим запросом — автоотправка
              setAiChatOpen(true)
            }}
            aria-label="ИИ-поиск: спросить нейросеть по постам ленты"
            title="ИИ-поиск: спросит по свежим постам ленты и ответит со ссылками на источники"
            className="flex h-10 shrink-0 items-center gap-1.5 rounded-[12px] border border-tg-link/35 bg-tg-link/10 px-4 text-[14.5px] font-semibold text-tg-link transition active:scale-95"
          >
            <Sparkles className="h-4 w-4" strokeWidth={2.2} />
            ИИ-поиск
          </button>
        </div>
      </div>

      {/* Недавние запросы — при фокусе поля и пустом запросе (fade+slide 200ms) */}
      {showHistory && (
        <motion.section
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="px-4 pb-2 pt-3"
          aria-label="Недавние запросы"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-semibold text-tg-text">Недавние запросы</h2>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault() /* не уводим фокус из поля */}
              onClick={clearAll}
              aria-label="Очистить историю поиска"
              className="flex h-7 items-center gap-1 rounded-full px-2 text-[13px] font-medium text-tg-link transition active:scale-95 active:opacity-60"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Очистить
            </button>
          </div>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {recent.map((rq) => (
              <div
                key={rq}
                className="flex h-8 items-center gap-0.5 rounded-full border border-tg-sep bg-tg-surface pl-3 pr-1"
              >
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault() /* чип не уводит фокус из поля */}
                  onClick={() => applyQuery(rq)}
                  aria-label={`Искать «${rq}»`}
                  className="flex min-w-0 items-center gap-1.5 text-sm text-tg-text transition active:scale-95"
                >
                  <History className="h-3.5 w-3.5 shrink-0 text-tg-hint" />
                  <span className="max-w-40 truncate">{rq}</span>
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.stopPropagation()
                    removeOne(rq)
                  }}
                  aria-label={`Удалить запрос ${rq}`}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-tg-hint transition active:scale-90 active:bg-tg-surface2"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        </motion.section>
      )}

      {/* Сейчас обсуждают — трендовые хэштеги (клики за 72ч + частотные из постов) */}
      {filter === 'channels' && q === '' && !showHistory && trending !== null && trending.length > 0 && (
        <section className="pb-2 pt-1" aria-label="Сейчас обсуждают">
          <h2 className="px-4 text-[15px] font-semibold text-tg-text">Сейчас обсуждают</h2>
          <div className="no-scrollbar mt-2 flex gap-2 overflow-x-auto px-4" data-noswipe>
            {trending.map((t) => (
              <button
                key={t.tag}
                type="button"
                onClick={() => {
                  haptic('light')
                  applyQuery(t.tag)
                }}
                aria-label={`Искать по теме ${t.tag}`}
                className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-tg-sep bg-tg-surface px-3 text-sm text-tg-text transition active:scale-95"
              >
                <TrendingUp className="h-3.5 w-3.5 shrink-0 text-tg-hint" />
                <span className="max-w-32 truncate">{t.tag}</span>
                <span className="text-[12px] font-medium text-tg-hint">{formatCount(t.clicks)}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* v5.35: дубль-рельс «Популярные каналы» (топ-6) убран — при пустом
          запросе он повторял первые строки КАТАЛОГА каналов ниже, и один и тот же
          канал приходилось листать дважды. Каталог — единственный список каналов. */}

      {/* Контент */}
      {filter === 'channels' && (
        <section className="mt-2 pb-6" aria-label="Каналы">
          {/* v5.76: шапка секции с кнопкой ротации — новый порядок каналов */}
          <div className="flex items-center justify-between px-4 pb-2">
            <span className="text-[13px] font-semibold uppercase tracking-wide text-tg-hint">
              Каналы · обновляется каждый час
            </span>
            <button
              type="button"
              onClick={rotateCatalog}
              aria-label="Обновить подборку каналов"
              className="flex h-8 items-center gap-1.5 rounded-full bg-tg-surface px-3 text-[13px] font-medium text-tg-link transition active:scale-95"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', rotating && 'animate-spin')} aria-hidden />
              Другие
            </button>
          </div>
          {matchedChannels === null ? (
            <ChannelRowsSkeleton />
          ) : matchedChannels.length === 0 ? (
            <Empty text="Каналы не найдены" />
          ) : (
            matchedChannels.map((c, i) => (
              <ChannelRow key={c.id} index={i} channel={c} onToggle={() => toggleSub(c)} onOpen={() => openChannel(c.username)} />
            ))
          )}
        </section>
      )}

      {filter === 'topics' && (
        <section className="mt-2 pb-6" aria-label="Темы">
          {matchedTopics.length === 0 ? (
            <Empty text="Темы не найдены" />
          ) : (
            matchedTopics.map((c, i) => (
              <button
                key={c.slug}
                type="button"
                onClick={() => {
                  haptic('light')
                  setCategory(c.slug)
                  setTab('feed')
                }}
                className={cn(
                  'flex w-full items-center gap-3 px-4 py-3.5 text-left active:bg-tg-surface/60',
                  i > 0 && 'border-t border-tg-sep/60',
                )}
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-tg-surface text-[15px] font-bold text-tg-text2">
                  {c.title.slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[16.5px] font-semibold text-tg-text">{c.title}</span>
                  <span className="block text-[13.5px] text-tg-hint">
                    {c.channelCount} {pluralRu(c.channelCount, 'канал', 'канала', 'каналов')}
                    {c.todayCount > 0 && ` · ${c.todayCount} новых за сегодня`}
                  </span>
                </span>
                <ChevronRight className="h-5 w-5 shrink-0 text-tg-hint" />
              </button>
            ))
          )}
        </section>
      )}

      {filter === 'posts' && (
        <section className="mt-2 pb-6" aria-label="Посты">
          {/* Snap Search: скелетон / ответ с источниками / лимит / ошибка — НАД обычной выдачей */}
          {/* ОТДЕЛЬНЫЙ ЧАТ Snap Search (v5.21): кнопка «Спросить ИИ» выше открывает
              полноэкранный чат с инструментами, markdown и источниками — inline-блок больше не нужен */}

          {query.length < 2 ? (
            <Empty text="Введите запрос — найдём нужный пост" />
          ) : searching || postResults === null ? (
            <div className="px-4 py-6 text-center text-snippet text-tg-hint">Ищем…</div>
          ) : postResults.length === 0 ? (
            <Empty text={`По запросу «${query}» ничего не найдено`} />
          ) : (
            postResults.map((p, i) => (
              <button
                key={p.id}
                type="button"
                onClick={() => openChannel(p.channel.username)}
                aria-label={`Открыть канал ${p.channel.title}`}
                className={cn(
                  'flex w-full items-start gap-3 px-4 py-3.5 text-left active:bg-tg-surface/60',
                  i > 0 && 'border-t border-tg-sep/60',
                )}
              >
                <Avatar name={p.channel.title} color={p.channel.avatarColor} src={p.channel.avatarUrl} size={44} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="flex min-w-0 items-center gap-1">
                      <span className="truncate text-[15px] font-semibold text-tg-text">
                        {p.channel.title}
                      </span>
                      {p.channel.verified && <VerifiedBadge size={13} />}
                    </span>
                    <span className="shrink-0 text-[12px] text-tg-hint">
                      {timeAgoRu(p.publishedAt)}
                    </span>
                  </span>
                  <span className="mt-0.5 line-clamp-2 text-[14px] leading-snug text-tg-hint">
                    {p.text ? stripMarkdown(p.text) || 'медиа-пост' : 'медиа-пост'}
                  </span>
                </span>
              </button>
            ))
          )}
        </section>
      )}
      </div>

      {/* ОТДЕЛЬНЫЙ ЧАТ Snap Search (v5.21): полноэкранный, с инструментами/markdown/источниками */}
      <AiChat
        kind="search"
        open={aiChatOpen}
        onClose={() => setAiChatOpen(false)}
        seedQuery={aiSeed}
        onSeedConsumed={() => setAiSeed(null)}
      />
    </div>
  )
}

/* ---------- Строка канала как в макете ---------- */

function ChannelRow({
  channel,
  onToggle,
  onOpen,
  index = 0,
}: {
  channel: ChannelDTO
  onToggle: () => void
  onOpen: () => void
  index?: number
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 px-4 py-3',
        index > 0 && 'border-t border-tg-sep/60',
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Открыть канал ${channel.title}`}
        className="shrink-0"
      >
        <Avatar name={channel.title} color={channel.avatarColor} src={channel.avatarUrl} size={52} />
      </button>
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 text-left"
      >
        <span className="flex w-full items-center gap-1">
          <span className="block truncate text-[16.5px] font-bold leading-snug text-tg-text">
            {channel.title}
          </span>
          {channel.verified && <VerifiedBadge size={15} />}
        </span>
        {channel.description && (
          <span className="mt-0.5 line-clamp-2 text-[14px] leading-snug text-tg-hint">
            {channel.description}
          </span>
        )}
        {channel.subscribersCount > 0 && (
          <span className="mt-0.5 block text-[13px] text-tg-hint">
            {formatCount(channel.subscribersCount)} подписчиков
          </span>
        )}
      </button>
      <SubscribePill subscribed={channel.subscribed} onClick={onToggle} />
    </div>
  )
}

function SubscribePill({ subscribed, onClick }: { subscribed: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={subscribed}
      className={cn(
        'flex h-10 shrink-0 items-center gap-1 rounded-full px-3.5 text-[14px] font-medium transition active:scale-95',
        subscribed ? 'bg-tg-surface text-tg-hint' : 'bg-tg-surface text-tg-text',
      )}
    >
      {subscribed ? (
        <span className="flex items-center gap-1">
          <Check className="h-4 w-4 text-tg-green" strokeWidth={2.4} />
          Есть
        </span>
      ) : (
        <span className="flex items-center gap-0.5">
          <Plus className="h-4 w-4" strokeWidth={2.6} />
          Подписаться
        </span>
      )}
    </button>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center px-8 py-14 text-center">
      <span
        className="flex size-16 items-center justify-center rounded-full bg-tg-link/10 text-tg-link"
        aria-hidden
      >
        <SearchX className="size-8" strokeWidth={1.7} />
      </span>
      <p className="mt-3 max-w-[300px] text-[14.5px] leading-relaxed text-tg-hint">{text}</p>
    </div>
  )
}

function ChannelRowsSkeleton() {
  return (
    <div aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <div className="tg-shimmer h-13 w-13 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <div className="tg-shimmer h-4 w-1/3 rounded-md" />
            <div className="tg-shimmer h-3 w-2/3 rounded-md" />
          </div>
          <div className="tg-shimmer h-9 w-28 rounded-full" />
        </div>
      ))}
    </div>
  )
}
