'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, ArrowUpRight, Bell, BellOff, Check, Forward, Heart, ImageOff, Loader2, Plus, Sparkle } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { haptic, openTelegram, useBackButton } from '@/lib/tg'
import { openChannelToJoin } from '@/lib/tg-subscribe'
import { formatCount, timeAgoRu } from '@/lib/format'
import { useT } from '@/lib/i18n'
import type { ChannelDTO, PostDTO, RelatedChannelDTO, RelatedChannelsResponse } from '@/lib/types'
import { Avatar } from '@/components/tg/Avatar'
import { VerifiedBadge } from '@/components/tg/VerifiedBadge'
import { PostMedia } from '@/components/feed/PostMedia'
import { ExpandableText } from '@/components/feed/actions'

const PAGE_SIZE = 10

/** Вкладки экрана канала (как в Telegram) — фильтр на сервере (/api/channel?tab=) */
const CHANNEL_TABS = [
  { key: 'all', label: 'ch.tabPosts' },
  { key: 'media', label: 'ch.tabMedia' },
  { key: 'links', label: 'ch.tabLinks' },
] as const
type ChannelTab = (typeof CHANNEL_TABS)[number]['key']

/**
 * Экран канала внутри приложения (киллер-фича: подписка одной кнопкой).
 * Шапка с описанием и статистикой, лента постов канала, подписка без выхода в Telegram.
 * Открывается тапом по каналу в ленте, поиске и профиле.
 */
export function ChannelSheet() {
  const username = useApp((s) => s.channelUsername)
  const closeChannel = useApp((s) => s.closeChannel)
  const user = useApp((s) => s.user)
  const open = !!username

  // Нативная кнопка «назад» Telegram закрывает экран канала
  useBackButton(open, closeChannel)

  return (
    <AnimatePresence>
      {open && username && (
        <motion.div
          key={username}
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%' }}
          transition={{ type: 'spring', damping: 32, stiffness: 330 }}
          className="fixed inset-0 z-[70] mx-auto flex w-full max-w-[430px] flex-col overflow-hidden bg-tg-bg lg:bottom-auto lg:top-[6vh] lg:h-[88vh] lg:max-w-[720px] lg:rounded-3xl lg:border lg:border-tg-sep lg:shadow-[0_24px_90px_rgba(0,0,0,0.30)]"
          role="dialog"
          aria-modal="true"
          aria-label={`Канал ${username}`}
        >
          <ChannelScreen username={username} userId={user?.id ?? null} onClose={closeChannel} />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function ChannelScreen({
  username,
  userId,
  onClose,
}: {
  username: string
  userId: string | null
  onClose: () => void
}) {
  const [channel, setChannel] = useState<ChannelDTO | null>(null)
  const [items, setItems] = useState<PostDTO[]>([])
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [tab, setTab] = useState<ChannelTab>('all')
  const bumpFeed = useApp((s) => s.bumpFeed) // синхронизация ленты после подписки/колокольчика в шите
  const [loading, setLoading] = useState(true)
  const [initial, setInitial] = useState(true)
  const [error, setError] = useState(false)
  const t = useT()
  // Колокольчик уведомлений (актуален только при активной подписке)
  const [notify, setNotify] = useState(true)
  /* Большая СТАТИСТИКА — только для СВОЕГО канала (вкладка «Мой канал»).
   * Чужой канал — это профиль + посты, без кабинета. */

  const busyRef = useRef(false)
  /* Порядковый номер запроса: смена вкладки перезапускает загрузку, НЕ дожидаясь
   * предыдущей (эффект сбрасывает busyRef) — ответ старой вкладки не должен
   * перезаписать список свежей (иначе посты «Посты» показывались на вкладке «Медиа»). */
  const loadSeqRef = useRef(0)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const userRef = useRef(userId)
  userRef.current = userId
  // Ленивая регистрация: гость? шторка входа
  const isGuest = useApp((s) => s.user?.isGuest ?? false)
  const openAuthGate = useApp((s) => s.openAuthGate)
  // Защита от двойного тапа (лайк/закладка/подписка): пока запрос в полёте,
  // повторные тапы по тому же объекту игнорируются — иначе оптимистичный флаг
  // переворачивается дважды и «действие отменяет само себя»
  const inflightRef = useRef<Set<string>>(new Set())

  const load = useCallback(
    async (p: number, replace: boolean) => {
      if (busyRef.current) return
      busyRef.current = true
      const seq = ++loadSeqRef.current
      setLoading(true)
      try {
        const qs = new URLSearchParams({ username, page: String(p), limit: String(PAGE_SIZE), tab })
        if (userRef.current) qs.set('userId', userRef.current)
        const data = await api<{ channel: ChannelDTO; items: PostDTO[]; hasMore: boolean }>(
          `/api/channel?${qs.toString()}`,
        )
        // Ответ устарел (вкладка/канал сменились, пока летел запрос) — молча discard
        if (seq !== loadSeqRef.current) return
        setChannel(data.channel)
        setItems((prev) => (replace ? data.items : [...prev, ...data.items]))
        setHasMore(data.hasMore)
        setPage(p)
        setError(false)
        // При активной подписке подтягиваем реальное состояние колокольчика
        if (data.channel.subscribed && userRef.current) {
          api<{ subscribed: boolean; notify: boolean }>(
            `/api/subscribe?userId=${encodeURIComponent(userRef.current)}&channelId=${encodeURIComponent(data.channel.id)}`,
          )
            .then((r) => setNotify(r.notify))
            .catch(() => {})
        }
      } catch {
        // Ошибка устаревшего запроса — не трогаем состояние свежей загрузки
        if (seq !== loadSeqRef.current) return
        if (replace) setError(true)
        else toast.error('Не удалось загрузить посты')
      } finally {
        // busy/спиннеры сбрасывает только СВЕЖИЙ запрос — иначе поздний ответ
        // старой вкладки снимал бы скелетон новой
        if (seq === loadSeqRef.current) {
          busyRef.current = false
          setLoading(false)
          setInitial(false)
          setTimeout(() => checkRef.current(), 80)
        }
      }
    },
    [username, tab],
  )

  useEffect(() => {
    setInitial(true)
    busyRef.current = false
    load(0, true)
  }, [load])

  // Догрузка: ручная проверка видимости сентинела (как в ленте)
  const checkLoadMore = useCallback(() => {
    if (!hasMore || busyRef.current) return
    const el = sentinelRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.top < (window.innerHeight || 800) + 900) load(page + 1, false)
  }, [hasMore, page, load])

  const checkRef = useRef(checkLoadMore)
  checkRef.current = checkLoadMore

  useEffect(() => {
    const el = sentinelRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(() => checkRef.current(), { rootMargin: '900px' })
    io.observe(el)
    return () => io.disconnect()
  }, [initial])

  const updatePost = (id: string, patch: Partial<PostDTO>) =>
    setItems((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)))

  const onLike = async (post: PostDTO) => {
    const uid = userRef.current
    if (!uid) return
    // Ленивая регистрация: лайк гостя → шторка входа за 2 секунды
    if (isGuest) {
      openAuthGate('like')
      haptic('light')
      return
    }
    const key = `like:${post.id}`
    if (inflightRef.current.has(key)) return
    inflightRef.current.add(key)
    const nextLiked = !post.liked
    updatePost(post.id, { liked: nextLiked, likesCount: Math.max(0, post.likesCount + (nextLiked ? 1 : -1)) })
    try {
      const r = await api<{ liked: boolean; likesCount: number }>('/api/like', {
        method: 'POST',
        body: JSON.stringify({ userId: uid, postId: post.id }),
      })
      updatePost(post.id, r)
    } catch {
      updatePost(post.id, { liked: post.liked, likesCount: post.likesCount })
    } finally {
      inflightRef.current.delete(key)
    }
  }

  const onBookmark = async (post: PostDTO) => {
    const uid = userRef.current
    if (!uid) return
    // Ленивая регистрация: сохранение гостя → шторка входа
    if (isGuest) {
      openAuthGate('bookmark')
      haptic('light')
      return
    }
    const key = `bm:${post.id}`
    if (inflightRef.current.has(key)) return
    inflightRef.current.add(key)
    const next = !post.bookmarked
    updatePost(post.id, {
      bookmarked: next,
      bookmarksCount: Math.max(0, post.bookmarksCount + (next ? 1 : -1)),
    })
    haptic(next ? 'success' : 'light')
    try {
      await api('/api/bookmark', {
        method: 'POST',
        body: JSON.stringify({ userId: uid, postId: post.id }),
      })
      toast.success(next ? 'Сохранено' : 'Убрано из сохранённых')
    } catch {
      updatePost(post.id, {
        bookmarked: !next,
        bookmarksCount: Math.max(0, post.bookmarksCount + (next ? -1 : 1)),
      })
    } finally {
      inflightRef.current.delete(key)
    }
  }

  const onSubscribe = async () => {
    const uid = userRef.current
    if (!uid || !channel) return
    if (inflightRef.current.has('sub')) return
    inflightRef.current.add('sub')
    const next = !channel.subscribed
    if (next) setNotify(true) // новая подписка — звук включён по умолчанию
    setChannel({ ...channel, subscribed: next, subscribersCount: Math.max(0, channel.subscribersCount + (next ? 1 : -1)) })
    setItems((prev) =>
      prev.map((p) => ({
        ...p,
        channel: { ...p.channel, subscribed: next, subscribersCount: Math.max(0, p.channel.subscribersCount + (next ? 1 : -1)) },
      })),
    )
    haptic(next ? 'success' : 'light')
    if (!next) toast.info('Подписка в ленте отключена')
    try {
      await api('/api/subscribe', {
        method: 'POST',
        body: JSON.stringify({ userId: uid, channelId: channel.id }),
      })
      // Синхронизация ленты: SubscribeCircle в шапке поста должен увидеть
      // новую подписку, иначе его toggle отменит её (баг qa18 №1)
      bumpFeed()
      // Подписка в один тап: открываем канал в Telegram, чтобы пользователь
      // нажал родную «Подписаться»; после возврата членство сверится тихо
      if (next) openChannelToJoin(channel.username)
    } catch {
      setChannel((c) =>
        c ? { ...c, subscribed: !next, subscribersCount: Math.max(0, c.subscribersCount + (next ? -1 : 1)) } : c,
      )
      toast.error('Ошибка подписки')
    } finally {
      inflightRef.current.delete('sub')
    }
  }

  // Колокольчик: переключение режима уведомлений (звук/тихо)
  const onNotify = async () => {
    const uid = userRef.current
    if (!uid || !channel) return
    const next = !notify
    setNotify(next) // оптимистично
    haptic('light')
    try {
      const r = await api<{ ok: boolean; subscribed: boolean; notify: boolean }>('/api/subscribe', {
        method: 'POST',
        body: JSON.stringify({ userId: uid, username: channel.username, action: 'notify' }),
      })
      setNotify(r.notify)
      toast.success(r.notify ? 'Уведомления включены' : 'Уведомления выключены')
    } catch {
      setNotify(!next) // откат при ошибке
      toast.error('Не удалось изменить уведомления')
    }
  }

  return (
    <>
      {/* Шапка экрана */}
      <header className="flex shrink-0 items-center gap-2 border-b border-tg-sep/60 bg-tg-bg px-2 py-2">
        <button
          type="button"
          onClick={onClose}
          aria-label="Назад"
          className="flex h-11 w-11 items-center justify-center rounded-full text-tg-text active:bg-tg-surface"
        >
          <ArrowLeft className="h-5.5 w-5.5" />
        </button>
        <span className="flex-1 text-[17px] font-semibold text-tg-text">Канал</span>
        {channel && (
          <button
            type="button"
            onClick={() => openTelegram(channel.username)}
            aria-label="Открыть в Telegram"
            className="mr-1 flex h-9 w-9 items-center justify-center rounded-full bg-tg-surface text-tg-hint active:scale-90"
          >
            <ArrowUpRight className="h-4.5 w-4.5" />
          </button>
        )}
      </header>

      {/* Контент */}
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {initial ? (
          <ChannelSkeleton />
        ) : error || !channel ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <span className="flex size-16 items-center justify-center rounded-full bg-tg-like/10 text-tg-like" aria-hidden>
              <AlertCircle className="size-8" strokeWidth={1.7} />
            </span>
            <p className="text-[15px] font-semibold text-tg-text">Канал не найден</p>
            <p className="text-snippet text-tg-hint">Возможно, он ещё проходит модерацию</p>
            <button
              type="button"
              onClick={onClose}
              className="press mt-1 h-10 rounded-full bg-tg-surface px-5 text-[14px] font-semibold text-tg-link"
            >
              Вернуться назад
            </button>
          </div>
        ) : (
          <>
            {/* Профиль канала */}
            <div className="px-4 pb-1 pt-5">
              <div className="flex items-center gap-4">
                <Avatar name={channel.title} color={channel.avatarColor} src={channel.avatarUrl} size={76} />
                <div className="min-w-0 flex-1">
                  <h1 className="flex min-w-0 items-center gap-1.5 text-[21px] font-bold leading-tight text-tg-text">
                    <span className="truncate">{channel.title}</span>
                    {channel.verified && <VerifiedBadge size={18} />}
                  </h1>
                  <div className="mt-0.5 text-[14px] text-tg-link">@{channel.username}</div>
                  <div className="mt-1.5 flex items-center gap-4 text-[13.5px] text-tg-hint">
                    {channel.subscribersCount > 0 && (
                      <span>
                        <b className="font-semibold text-tg-text2">{formatCount(channel.subscribersCount)}</b>{' '}
                        подписчиков
                      </span>
                    )}
                    <span>
                      <b className="font-semibold text-tg-text2">{channel.postsCount ?? items.length}</b>{' '}
                      постов
                    </span>
                  </div>
                </div>
              </div>

              {channel.description && (
                <p className="mt-3.5 text-[15px] leading-snug text-tg-text2">{channel.description}</p>
              )}

              {channel.categoryTitle && (
                <div className="mt-3">
                  <span className="inline-flex h-8 items-center rounded-full bg-tg-surface px-3.5 text-[13px] font-medium text-tg-text2">
                    {channel.categoryTitle}
                  </span>
                </div>
              )}

              {/* Подписка одной кнопкой — главная кнопка экрана; рядом колокольчик (как в Telegram) */}
              <div className="mt-4 flex items-center gap-2">
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.98 }}
                  onClick={onSubscribe}
                  aria-pressed={channel.subscribed}
                  className={cn(
                    'flex h-12 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[14px] text-[16px] font-semibold transition-colors active:opacity-90',
                    channel.subscribed ? 'bg-tg-surface text-tg-text2' : 'bg-tg-link text-white shadow-sm',
                  )}
                >
                  {channel.subscribed ? (
                    <>
                      <Check className="h-5 w-5 text-tg-green" strokeWidth={2.5} />
                      Вы подписаны
                    </>
                  ) : (
                    <>
                      <Plus className="h-5 w-5" strokeWidth={2.6} />
                      Подписаться
                    </>
                  )}
                </motion.button>

                {channel.subscribed && (
                  <button
                    type="button"
                    onClick={onNotify}
                    aria-pressed={notify}
                    aria-label={notify ? 'Уведомления включены' : 'Уведомления выключены'}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-tg-sep bg-tg-surface transition active:scale-90"
                  >
                    {notify ? (
                      <Bell className="h-5 w-5 text-tg-link" strokeWidth={1.9} />
                    ) : (
                      <BellOff className="h-5 w-5 text-tg-hint" strokeWidth={1.9} />
                    )}
                  </button>
                )}
              </div>

              {/* Посты — единственный раздел чужого канала: большая статистика только у владельца (вкладка «Мой канал») */}
            </div>

            <>
            {/* ВКЛАДКИ (жалоба владельца: «вниз листается бесконечно как будто»):
                Посты / Медиа / Ссылки — как в Telegram; фильтр серверный.
                Липкая полоса — держится при прокрутке ленты канала. */}
            <div className="sticky top-0 z-10 border-b border-tg-sep/60 bg-tg-bg/95 px-3 backdrop-blur">
              <div className="flex" role="tablist" aria-label={t('ch.tabsAria')}>
                {CHANNEL_TABS.map((tb) => {
                  const active = tab === tb.key
                  return (
                    <button
                      key={tb.key}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => {
                        if (!active) {
                          haptic('light')
                          setTab(tb.key)
                        }
                      }}
                      className={cn(
                        'relative min-h-[44px] flex-1 px-2 text-[14px] font-semibold transition-colors',
                        active ? 'text-tg-link' : 'text-tg-hint active:opacity-70',
                      )}
                    >
                      {t(tb.label)}
                      {active && (
                        <motion.span
                          layoutId="ch-tab-underline"
                          className="absolute inset-x-4 bottom-0 h-[2.5px] rounded-t-full bg-tg-link"
                          transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                        />
                      )}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="mt-1 divide-y divide-tg-sep/50">
              {items.map((p) => (
                <ChannelPost key={p.id} post={p} onLike={() => onLike(p)} onBookmark={() => onBookmark(p)} />
              ))}
            </div>

            {!initial && !loading && items.length === 0 && (
              <div className="flex flex-col items-center gap-2.5 py-10 text-center">
                <span className="flex size-14 items-center justify-center rounded-full bg-tg-link/10 text-tg-link" aria-hidden>
                  <ImageOff className="size-6" strokeWidth={1.7} />
                </span>
                <p className="text-[14px] text-tg-hint">{t('ch.tabEmpty')}</p>
              </div>
            )}

              <div ref={sentinelRef} className="h-2" aria-hidden />

              {loading && !initial && (
                <div className="flex justify-center py-5">
                  <Loader2 className="h-5 w-5 animate-spin text-tg-hint" />
                </div>
              )}

              {!hasMore && items.length > 0 && (
                <p className="py-6 text-center text-snippet text-tg-hint">Это все посты канала</p>
              )}

              {/* Похожие каналы — рельс в конце списка постов (сам скрывается, если похожих нет) */}
              <RelatedChannels username={username} userId={userId} />
            </>
          </>
        )}
      </div>
    </>
  )
}

/* ---------- Компактная карточка поста внутри канала ---------- */

function ChannelPost({
  post,
  onLike,
  onBookmark,
}: {
  post: PostDTO
  onLike: () => void
  onBookmark: () => void
}) {
  // Приказ владельца: «чтоб я прям вообще все посты мог в истории делать — даже
  // со своего канала и в профиле любого канала». Кнопка «Поделиться» открывает
  // глобальный шит, внутри него «В историю» (картинка /api/story + виджет).
  const openShareSheet = useApp((s) => s.openShareSheet)
  return (
    <article className="px-4 py-4">
      <div className="flex items-center gap-1.5 text-[12.5px] text-tg-hint">
        <span>{timeAgoRu(post.publishedAt)}</span>
        <span aria-hidden>·</span>
        <span className="tabular-nums">
          {formatCount(post.viewsCount)}
          {post.viewsTg != null ? ' в канале' : ' просмотров'}
        </span>
      </div>

      <div className="mt-2.5 flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <PostMedia post={post} />
          {post.text && (
            <div className="mt-0.5">
              <ExpandableText text={post.text} />
            </div>
          )}
        </div>

        <div className="flex w-10 shrink-0 flex-col items-center gap-4 pt-1" aria-label="Действия">
            <motion.button
              type="button"
              whileTap={{ scale: 1.2 }}
              transition={{ type: 'spring', stiffness: 500, damping: 15 }}
              onClick={() => {
                haptic('light')
                onLike()
              }}
              aria-label="Нравится"
              aria-pressed={post.liked}
              className="flex flex-col items-center gap-1"
            >
              <Heart
                className={cn('h-[26px] w-[26px]', post.liked ? 'fill-tg-like text-tg-like' : 'text-tg-text')}
                strokeWidth={post.liked ? 2 : 1.7}
              />
              {post.likesCount > 0 && (
                <span className="text-[12px] font-medium leading-none text-tg-text2 tabular-nums">
                  {formatCount(post.likesCount)}
                </span>
              )}
            </motion.button>

            <motion.button
              type="button"
              whileTap={{ scale: 1.2 }}
              transition={{ type: 'spring', stiffness: 500, damping: 15 }}
              onClick={() => {
                haptic('light')
                onBookmark()
              }}
              aria-label="Сохранить"
              aria-pressed={post.bookmarked}
              className="flex flex-col items-center gap-1"
            >
              <Sparkle
                className={cn(
                  'h-[26px] w-[26px]',
                  post.bookmarked ? 'fill-tg-link text-tg-link' : 'text-tg-text',
                )}
                strokeWidth={post.bookmarked ? 2 : 1.7}
              />
              {post.bookmarksCount > 0 && (
                <span className="text-[12px] font-medium leading-none text-tg-text2 tabular-nums">
                  {formatCount(post.bookmarksCount)}
                </span>
              )}
            </motion.button>

            <motion.button
              type="button"
              whileTap={{ scale: 1.2 }}
              transition={{ type: 'spring', stiffness: 500, damping: 15 }}
              onClick={() => {
                haptic('light')
                openShareSheet(post)
              }}
              aria-label="Поделиться — отправить в Telegram, историю или скопировать ссылку"
              className="flex flex-col items-center gap-1"
            >
              <Forward className="h-[26px] w-[26px] text-tg-text" strokeWidth={1.7} />
            </motion.button>
        </div>
      </div>
    </article>
  )
}

/* ---------- Скелетон ---------- */

function ChannelSkeleton() {
  return (
    <div className="px-4 pt-5" aria-hidden>
      <div className="flex items-center gap-4">
        <div className="tg-shimmer h-[76px] w-[76px] rounded-full" />
        <div className="flex-1 space-y-2.5">
          <div className="tg-shimmer h-5 w-2/3 rounded-md" />
          <div className="tg-shimmer h-3.5 w-1/3 rounded-md" />
          <div className="tg-shimmer h-3.5 w-1/2 rounded-md" />
        </div>
      </div>
      <div className="tg-shimmer mt-4 h-12 w-full rounded-[14px]" />
      <div className="mt-7 space-y-3">
        <div className="tg-shimmer h-4 w-1/4 rounded-md" />
        <div className="tg-shimmer h-52 w-full rounded-[14px]" />
        <div className="tg-shimmer h-3.5 w-full rounded-md" />
        <div className="tg-shimmer h-3.5 w-4/5 rounded-md" />
      </div>
    </div>
  )
}

/* ---------- Похожие каналы: горизонтальный рельс в конце списка постов ---------- */

function RelatedChannels({ username, userId }: { username: string; userId: string | null }) {
  // null — загрузка или «секции нет» (пусто/ошибка → тихо не рендерим)
  const [items, setItems] = useState<RelatedChannelDTO[] | null>(null)
  const [failed, setFailed] = useState(false)
  const openChannel = useApp((s) => s.openChannel)
  const bumpFeed = useApp((s) => s.bumpFeed)

  // Загрузка при открытии листа (по username). Лист пересоздаётся при смене канала
  // (key={username} у motion.div), поэтому состояние всегда свежее; гонки гасим AbortController.
  useEffect(() => {
    const ac = new AbortController()
    const qs = new URLSearchParams({ username, limit: '5' })
    if (userId) qs.set('userId', userId)
    api<RelatedChannelsResponse>(`/api/channel/related?${qs.toString()}`, { signal: ac.signal })
      .then((r) => setItems(r.items))
      .catch(() => {
        // Прерывание — не ошибка (лист закрылся/переключился); реальная ошибка — тихо скрываем секцию
        if (!ac.signal.aborted) setFailed(true)
      })
    return () => ac.abort()
  }, [username, userId])

  /** Подписка/отписка в один тап — как у основной кнопки экрана, но по username (id в DTO нет).
   *  Двойной тап защищён inflight-набором: повторный тап по тому же каналу до ответа игнорируется. */
  const inflightRef = useRef<Set<string>>(new Set())
  const toggleSub = async (c: RelatedChannelDTO) => {
    const uid = userId
    if (!uid) return
    if (inflightRef.current.has(c.username)) return
    inflightRef.current.add(c.username)
    const next = !c.subscribed
    setItems((prev) =>
      prev
        ? prev.map((x) =>
            x.username === c.username
              ? { ...x, subscribed: next, subscribers: Math.max(0, x.subscribers + (next ? 1 : -1)) }
              : x,
          )
        : prev,
    )
    haptic(next ? 'success' : 'light')
    try {
      await api('/api/subscribe', {
        method: 'POST',
        body: JSON.stringify({ userId: uid, username: c.username }),
      })
      if (!next) toast.info(`«${c.title}» убран из подписок`)
      // Подписка в один тап: открываем канал в Telegram для родной кнопки
      if (next) openChannelToJoin(c.username)
      bumpFeed() // лента зависит от подписок — пересобрать
    } catch {
      setItems((prev) =>
        prev
          ? prev.map((x) =>
              x.username === c.username
                ? { ...x, subscribed: !next, subscribers: Math.max(0, x.subscribers + (next ? -1 : 1)) }
                : x,
            )
          : prev,
      )
      toast.error('Ошибка подписки')
    } finally {
      inflightRef.current.delete(c.username)
    }
  }

  // Ошибка — секция просто не рендерится
  if (failed) return null

  return (
    <section className="mt-2 pb-6" aria-label="Похожие каналы">
      <h2 className="px-4 text-[15px] font-semibold text-tg-text">Похожие каналы</h2>
      {items === null ? (
        <RelatedSkeleton />
      ) : items.length === 0 ? null : (
        <div
          className="no-scrollbar mt-3 flex snap-x gap-3 overflow-x-auto px-4 pb-1"
          data-noswipe
          role="list"
          aria-label="Похожие каналы"
        >
          {items.map((c) => (
            <RelatedCard
              key={c.username}
              channel={c}
              onOpen={() => openChannel(c.username)}
              onToggle={() => toggleSub(c)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/* ---------- Карточка похожего канала (стиль рельса «Популярные каналы» в поиске) ---------- */

function RelatedCard({
  channel,
  onOpen,
  onToggle,
}: {
  channel: RelatedChannelDTO
  onOpen: () => void
  onToggle: () => void
}) {
  return (
    <div
      role="listitem"
      className="relative flex w-[150px] shrink-0 snap-start flex-col items-center gap-2 rounded-2xl border border-tg-sep/60 px-3 py-4"
    >
      <Avatar name={channel.title} color={channel.avatarColor} src={channel.avatarUrl} size={56} />
      <span className="line-clamp-1 flex w-full items-center justify-center gap-1 text-center text-[14px] font-bold leading-tight text-tg-text">
        <span className="truncate">{channel.title}</span>
        {channel.verified && <VerifiedBadge size={13} />}
      </span>
      <span className="whitespace-nowrap text-[11.5px] leading-none text-tg-hint">
        {formatCount(channel.subscribers)} подписчиков
      </span>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={channel.subscribed}
        aria-label={
          channel.subscribed ? `Вы подписаны на канал ${channel.title}` : `Подписаться на канал ${channel.title}`
        }
        className={cn(
          'relative z-10 mt-0.5 flex h-8 shrink-0 items-center justify-center whitespace-nowrap rounded-full px-3 text-[12.5px] font-medium transition active:scale-95',
          channel.subscribed ? 'bg-tg-surface text-tg-hint' : 'bg-tg-link text-white',
        )}
      >
        {channel.subscribed ? (
          <span className="flex items-center gap-1">
            <Check className="h-3.5 w-3.5 text-tg-green" strokeWidth={2.4} />
            Вы подписаны
          </span>
        ) : (
          <span className="flex items-center gap-0.5">
            <Plus className="h-3.5 w-3.5" strokeWidth={2.6} />
            Подписаться
          </span>
        )}
      </button>
      {/* Оверлей поверх карточки (последний в DOM — выше статичного контента): тап в любом
          месте, кроме мини-кнопки подписки (z-10), открывает канал */}
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Открыть канал ${channel.title}`}
        className="absolute inset-0 rounded-2xl active:bg-tg-surface/40"
      />
    </div>
  )
}

/* ---------- Скелетон рельса «Похожие каналы» ---------- */

function RelatedSkeleton() {
  return (
    <div className="mt-3 flex gap-3 overflow-hidden px-4 pb-1" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="flex w-[150px] shrink-0 flex-col items-center gap-2 rounded-2xl border border-tg-sep/60 px-3 py-4"
        >
          <div className="tg-shimmer h-14 w-14 rounded-full" />
          <div className="tg-shimmer h-3.5 w-4/5 rounded-md" />
          <div className="tg-shimmer h-3 w-3/5 rounded-md" />
          <div className="tg-shimmer h-8 w-full rounded-full" />
        </div>
      ))}
    </div>
  )
}
