'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Bell,
  ChevronRight,
  Crown,
  Info,
  Loader2,
  MousePointerClick,
  Send,
  Settings,
  ShieldCheck,
  X,
  BarChart3,
  BookOpen,
  Eye,
  CheckCheck,
  Heart,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { formatCount, pluralRu } from '@/lib/format'
import { haptic } from '@/lib/tg'
import type { AdminStatsDTO, PostDTO, ProfileStatsResponse, SubscriptionDTO } from '@/lib/types'
import { Avatar } from '@/components/tg/Avatar'
import { BottomSheet } from '@/components/tg/BottomSheet'
import { Onboarding } from '@/components/tg/Onboarding'
import { PromoteSheet } from '@/components/tabs/PromoteSheet'

const CREATOR = 'tgfeed_creator'

/** Элемент списка закладок — приходит из /api/bookmarks с отметкой прочтения */
type BookmarkItem = PostDTO & { readAt: string | null }

/**
 * Экран «Профиль» по макету: шапка пользователя, статистика,
 * мои категории, подписки, настройки. Плюс кабинет админа и закладки.
 */
export function ProfileTab() {
  const { user, theme, setTheme, fontScale, setFontScale, categories, setTab, setCategory, openChannel } = useApp()
  const [profile, setProfile] = useState<{
    stats: { likes: number; subscriptions: number; views: number; bookmarks: number }
  } | null>(null)
  const [subs, setSubs] = useState<SubscriptionDTO[] | null>(null)
  const [bookmarks, setBookmarks] = useState<BookmarkItem[] | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [privacyOpen, setPrivacyOpen] = useState(false)
  const [notify, setNotify] = useState(true)

  const reload = () => {
    if (!user) return
    api<{ stats: { likes: number; subscriptions: number; views: number; bookmarks: number } }>(
      `/api/profile?userId=${encodeURIComponent(user.id)}`,
    )
      .then(setProfile)
      .catch(() => {})
    api<{ items: SubscriptionDTO[] }>(`/api/subscriptions?userId=${encodeURIComponent(user.id)}`)
      .then((d) => setSubs(d.items))
      .catch(() => setSubs([]))
    api<{ items: BookmarkItem[] }>(`/api/bookmarks?userId=${encodeURIComponent(user.id)}`)
      .then((d) => setBookmarks(d.items))
      .catch(() => setBookmarks([]))
  }

  useEffect(() => {
    if (editOpen) return
    reload()
     
  }, [user?.id, editOpen])

  // Непрочитанные закладки (открытие поста — отметка «прочитано»)
  const unreadCount = useMemo(
    () => (bookmarks ?? []).filter((b) => !b.readAt).length,
    [bookmarks],
  )

  if (!user) return null

  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Пользователь'
  const stats = profile?.stats

  const removeBookmark = async (p: PostDTO) => {
    setBookmarks((prev) => (prev ?? []).filter((x) => x.id !== p.id))
    try {
      await api('/api/bookmark', {
        method: 'POST',
        body: JSON.stringify({ userId: user.id, postId: p.id }),
      })
    } catch {
      toast.error('Не удалось убрать закладку')
    }
  }

  const markRead = (postId: string) => {
    setBookmarks((prev) =>
      (prev ?? []).map((b) =>
        b.id === postId && !b.readAt ? { ...b, readAt: new Date().toISOString() } : b,
      ),
    )
    void api('/api/bookmark/read', {
      method: 'POST',
      body: JSON.stringify({ userId: user.id, postId }),
    }).catch(() => {})
  }

  const markAllRead = async () => {
    setBookmarks((prev) => (prev ?? []).map((b) => ({ ...b, readAt: b.readAt ?? new Date().toISOString() })))
    haptic('light')
    try {
      await api('/api/bookmark/read', {
        method: 'POST',
        body: JSON.stringify({ userId: user.id, all: true }),
      })
      toast.success('Всё сохранённое прочитано')
    } catch {
      toast.error('Не удалось отметить прочитанным')
    }
  }

  const categoryTitle = (slug: string) => categories.find((c) => c.slug === slug)?.title ?? slug

  return (
    <div className="no-scrollbar h-full overflow-y-auto overscroll-contain pb-6">
      {/* Заголовок */}
      <header className="px-4 pb-2 pt-4">
        <h1 className="text-screen-title text-tg-text">Профиль</h1>
      </header>

      {/* Пользователь */}
      <section className="flex items-center gap-4 px-4 pt-2">
        <Avatar name={name} color="#0a84ff" src={user.photoUrl} size={80} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[22px] font-bold leading-tight text-tg-text">{name}</div>
          <div className="mt-0.5 truncate text-[15.5px] text-tg-hint">
            {user.username ? `@${user.username}` : 'Демо-режим'}
          </div>
          {!user.isDemo && (
            <div className="mt-1 text-[12px] font-medium text-tg-link">Telegram аккаунт</div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          aria-label="Настройки интерфейса"
          className="flex h-11 w-11 items-center justify-center rounded-full text-tg-text active:bg-tg-surface"
        >
          <Settings className="h-[26px] w-[26px]" strokeWidth={1.7} />
        </button>
      </section>

      {/* Статистика */}
      <section className="mt-5 flex items-stretch px-4" aria-label="Статистика">
        <StatBlock
          value={stats?.subscriptions}
          label="Подписки"
          onClick={() => {
            setTab('search')
            toast('Ваши каналы — во вкладке «Каналы»')
          }}
        />
        <div className="w-px shrink-0 bg-tg-sep" aria-hidden />
        <StatBlock value={user.categories.length} label="Категории" />
        <div className="w-px shrink-0 bg-tg-sep" aria-hidden />
        <StatBlock value={stats?.bookmarks} label="Сохранено" />
      </section>

      {/* Мои категории */}
      <section className="pt-7">
        <div className="flex items-center justify-between px-4">
          <h2 className="text-[19px] font-bold text-tg-text">Мои категории</h2>
          <button
            type="button"
            onClick={() => setEditOpen(true)}
            className="text-[15px] font-medium text-tg-link active:opacity-60"
          >
            Изменить
          </button>
        </div>
        <div className="flex flex-wrap gap-2 px-4 pt-3">
          {user.categories.length === 0 ? (
            <p className="text-snippet text-tg-hint">Ещё не выбраны — нажмите «Изменить»</p>
          ) : (
            user.categories.map((slug) => (
              <button
                key={slug}
                type="button"
                onClick={() => {
                  setCategory(slug)
                  setTab('feed')
                }}
                className="h-10 rounded-full bg-tg-surface px-4 text-[15px] font-medium text-tg-text transition active:scale-95"
              >
                {categoryTitle(slug)}
              </button>
            ))
          )}
        </div>
      </section>

      {/* Подписки */}
      <section className="pt-7">
        <div className="flex items-center justify-between px-4">
          <h2 className="text-[19px] font-bold text-tg-text">Подписки</h2>
          <button
            type="button"
            onClick={() => setTab('search')}
            className="text-[15px] font-medium text-tg-link active:opacity-60"
          >
            Все
          </button>
        </div>
        {subs === null ? (
          <div className="animate-pulse space-y-3 px-4 pt-3" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="h-12 w-12 rounded-full bg-tg-surface" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 w-1/3 rounded bg-tg-surface" />
                  <div className="h-3 w-1/4 rounded bg-tg-surface" />
                </div>
              </div>
            ))}
          </div>
        ) : subs.length === 0 ? (
          <p className="px-4 pt-3 text-snippet text-tg-hint">
            Вы пока не подписаны на каналы. Нажмите [+] в ленте — канал появится здесь.
          </p>
        ) : (
          <div className="pt-1">
            {subs.map((s, i) => (
              <button
                key={s.channelId}
                type="button"
                onClick={() => openChannel(s.channel.username)}
                aria-label={`Открыть канал ${s.channel.title}`}
                className={cn(
                  'flex w-full items-center gap-3 px-4 py-3 text-left active:bg-tg-surface/60',
                  i > 0 && 'border-t border-tg-sep/60',
                )}
              >
                <Avatar name={s.channel.title} color={s.channel.avatarColor} size={48} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[16.5px] font-semibold text-tg-text">
                    {s.channel.title}
                  </span>
                  <span className="block truncate text-[14px] text-tg-hint">
                    {formatCount(s.channel.subscribersCount)} подписчиков
                    {s.hidden && ' · скрыт из ленты'}
                  </span>
                </span>
                <ChevronRight className="h-5 w-5 shrink-0 text-tg-hint" />
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Сохранённые посты (с непрочитанными) */}
      {bookmarks !== null && bookmarks.length > 0 && (
        <section className="pt-7">
          <div className="flex items-center justify-between px-4">
            <h2 className="text-[19px] font-bold text-tg-text">Сохранённое</h2>
            <div className="flex items-center gap-2.5">
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={markAllRead}
                  className="flex items-center gap-1 rounded-full bg-tg-link/10 px-2.5 py-1 text-[12px] font-semibold text-tg-link transition active:scale-95"
                  aria-label="Отметить всё прочитанным"
                >
                  <CheckCheck className="h-3.5 w-3.5" />
                  Всё прочитано
                </button>
              )}
              <span className="text-[13px] font-medium text-tg-hint">{bookmarks.length}</span>
            </div>
          </div>
          <div className="pt-1">
            {bookmarks.map((p, i) => {
              const unread = !p.readAt
              return (
                <div
                  key={p.id}
                  className={cn(
                    'flex items-start gap-3 px-4 py-3',
                    i > 0 && 'border-t border-tg-sep/60',
                  )}
                >
                  <div className="relative shrink-0">
                    <Avatar name={p.channel.title} color={p.channel.avatarColor} size={40} />
                    {unread && (
                      <span
                        className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-tg-bg bg-tg-link"
                        aria-label="Непрочитано"
                      />
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      markRead(p.id)
                      openChannel(p.channel.username)
                    }}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span
                      className={cn(
                        'block truncate text-[14.5px] text-tg-text',
                        unread ? 'font-bold' : 'font-semibold',
                      )}
                    >
                      {p.channel.title}
                    </span>
                    <span
                      className={cn(
                        'mt-0.5 line-clamp-2 block text-[13.5px] leading-snug',
                        unread ? 'text-tg-text/80' : 'text-tg-hint',
                      )}
                    >
                      {p.text || 'медиа-пост'}
                    </span>
                    {unread && (
                      <span className="mt-1 inline-flex items-center rounded-full bg-tg-link/10 px-1.5 py-0.5 text-[10.5px] font-semibold text-tg-link">
                        новое
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeBookmark(p)}
                    aria-label="Убрать из сохранённых"
                    className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-tg-surface text-tg-hint active:scale-90"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Активность за 7 дней (после «Подписок» — верх профиля повторяет макет) */}
      <ActivityCard userId={user.id} />

      {/* Настройки */}
      <section className="pt-7">
        <h2 className="px-4 text-[19px] font-bold text-tg-text">Настройки</h2>
        <div className="mt-1">
          <SettingRow
            icon={<Bell className="h-[22px] w-[22px]" strokeWidth={1.7} />}
            label="Уведомления"
            right={
              <Switch
                checked={notify}
                onChange={(v) => {
                  setNotify(v)
                  toast(v ? 'Уведомления включены' : 'Уведомления выключены')
                }}
                label="Уведомления"
              />
            }
          />
          <SettingRow
            icon={<Settings className="h-[22px] w-[22px]" strokeWidth={1.7} />}
            label="Тёмная тема"
            right={
              <Switch
                checked={theme === 'dark'}
                onChange={(v) => {
                  setTheme(v ? 'dark' : 'light')
                  haptic('light')
                }}
                label="Тёмная тема"
              />
            }
          />
          <SettingRow
            icon={<ShieldCheck className="h-[22px] w-[22px]" strokeWidth={1.7} />}
            label="Конфиденциальность"
            onClick={() => setPrivacyOpen(true)}
          />
          <SettingRow
            icon={<Info className="h-[22px] w-[22px]" strokeWidth={1.7} />}
            label="О приложении"
            onClick={() => setAboutOpen(true)}
            last
          />
        </div>
      </section>

      <AdminZone />

      {/* Шиты */}
      <BottomSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Настройки интерфейса"
        subtitle="Оформление и размер текста"
      >
        <div className="space-y-4">
          <Segmented
            label="Тема"
            value={theme}
            onChange={(v) => setTheme(v as typeof theme)}
            options={[
              { value: 'auto', label: 'Авто' },
              { value: 'light', label: 'Светлая' },
              { value: 'dark', label: 'Тёмная' },
            ]}
          />
          <Segmented
            label="Размер шрифта постов"
            value={fontScale}
            onChange={(v) => setFontScale(v as typeof fontScale)}
            options={[
              { value: 'sm', label: 'A' },
              { value: 'md', label: 'A', big: true },
              { value: 'lg', label: 'A', big: true },
            ]}
          />
        </div>
      </BottomSheet>

      <BottomSheet
        open={aboutOpen}
        onClose={() => setAboutOpen(false)}
        title="TG-Feed"
        subtitle="Умная лента открытых Telegram-каналов"
      >
        <div className="space-y-2.5 text-snippet text-tg-text2">
          <Row label="Версия" value="4.1 · MVP" />
          <Row label="Источник контента" value="открытые TG-каналы" />
          <Row label="Ранжирование" value="взвешенный скоринг" />
          <Row label="Подписка" value="в один тап [+]" />
          <p className="pt-1 leading-relaxed text-tg-hint">
            Посты собираются из публичных каналов и раскладываются по темам. Лента ранжируется по
            свежести и вовлечённости, премиум-каналы получают приоритет.
          </p>
        </div>
      </BottomSheet>

      <BottomSheet
        open={privacyOpen}
        onClose={() => setPrivacyOpen(false)}
        title="Конфиденциальность"
        subtitle="Какие данные обрабатываются"
      >
        <div className="space-y-2.5 text-snippet leading-relaxed text-tg-text2">
          <p>
            Мы не собираем пароли и не просим доступ к переписке. При входе через Telegram
            используется только ваш публичный профиль: имя, @username и аватар.
          </p>
          <p>
            Лайки, подписки и закладки хранятся, чтобы восстановить вашу ленту на любом устройстве.
            Вы можете отписаться от канала или убрать закладку в любой момент.
          </p>
        </div>
      </BottomSheet>

      <Onboarding open={editOpen} mode="edit" onClose={() => setEditOpen(false)} />
    </div>
  )
}

/* ---------- Активность за 7 дней (мини-барчарт на CSS) ---------- */

/** Максимальная высота бара, px */
const BAR_MAX_PX = 52
/** Высота «базы» пустого бара, px */
const BAR_EMPTY_PX = 2

/**
 * Карточка «Активность за 7 дней»: мини-барчарт просмотров по дням
 * (сегодня — цветом tg-link), под ним легенда с итогами недели.
 * Пока данные грузятся — скелетон; при ошибке блок тихо скрывается.
 */
function ActivityCard({ userId }: { userId: string }) {
  const [stats, setStats] = useState<ProfileStatsResponse | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const ac = new AbortController()
    api<ProfileStatsResponse>(
      `/api/profile/stats?userId=${encodeURIComponent(userId)}`,
      { signal: ac.signal },
    )
      .then((d) => {
        setStats(d)
        setFailed(false)
      })
      .catch((err: unknown) => {
        // Отмена при unmount — не ошибка, остальное тихо скрывает блок
        if ((err as Error)?.name !== 'AbortError') setFailed(true)
      })
    return () => ac.abort()
  }, [userId])

  // Ошибка загрузки → не рендерим блок вовсе
  if (failed) return null

  const days = stats?.days ?? []
  const totals = stats?.totals
  // Сегодня по UTC — совпадает с тем, как сервер строит окно дней
  const todayKey = new Date().toISOString().slice(0, 10)
  const maxViews = Math.max(1, ...days.map((d) => d.views))
  const viewsWord = totals ? pluralRu(totals.views, 'просмотр', 'просмотра', 'просмотров') : ''
  const likesWord = totals ? pluralRu(totals.likes, 'лайк', 'лайка', 'лайков') : ''

  return (
    <section className="pt-7" aria-label="Активность за 7 дней">
      <h2 className="px-4 text-[19px] font-bold text-tg-text">Активность за 7 дней</h2>
      {!totals ? (
        /* Скелетон-строка на время загрузки */
        <div className="mx-4 mt-3 flex animate-pulse items-end gap-2" aria-hidden>
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
              <div
                className="w-full max-w-[26px] rounded-full bg-tg-surface"
                style={{ height: `${16 + ((i * 13) % 30)}px` }}
              />
              <div className="h-2.5 w-5 rounded bg-tg-surface" />
            </div>
          ))}
        </div>
      ) : (
        <div className="mx-4 mt-3 rounded-2xl bg-tg-surface p-4">
          {/* Барчарт: высота бара пропорциональна просмотрам дня */}
          <div
            className="flex items-end gap-2"
            role="img"
            aria-label={`Активность за 7 дней: ${totals.views} ${viewsWord}, ${totals.reads} прочитано, ${totals.likes} ${likesWord}`}
          >
            {days.map((d) => {
              const isToday = d.date === todayKey
              const h =
                d.views === 0
                  ? BAR_EMPTY_PX
                  : Math.max(4, Math.round((d.views / maxViews) * BAR_MAX_PX))
              return (
                <div key={d.date} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
                  <div className="flex w-full items-end justify-center" style={{ height: `${BAR_MAX_PX}px` }}>
                    <div
                      className={cn(
                        'w-full max-w-[26px] rounded-full',
                        isToday ? 'bg-tg-link' : 'bg-tg-sep',
                      )}
                      style={{ height: `${h}px` }}
                    />
                  </div>
                  <span
                    className={cn(
                      'text-[11px] leading-none',
                      isToday ? 'font-semibold text-tg-link' : 'text-tg-hint',
                    )}
                  >
                    {/* T00:00:00 — парсим как локальную полночь, чтобы день недели совпадал с датой */}
                    {new Date(`${d.date}T00:00:00`).toLocaleDateString('ru-RU', { weekday: 'short' })}
                  </span>
                </div>
              )
            })}
          </div>
          {/* Легенда: итоги недели (прочитано — несклоняемая форма) */}
          <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-tg-hint">
            <Eye className="h-3.5 w-3.5" aria-hidden />
            <span>
              {totals.views} {viewsWord}
            </span>
            <span aria-hidden>·</span>
            <BookOpen className="h-3.5 w-3.5" aria-hidden />
            <span>{totals.reads} прочитано</span>
            <span aria-hidden>·</span>
            <Heart className="h-3.5 w-3.5" aria-hidden />
            <span>
              {totals.likes} {likesWord}
            </span>
          </p>
        </div>
      )}
    </section>
  )
}

/* ---------- Кабинет админа (для админов: добавление канала, статистика) ---------- */

function AdminZone() {
  const { user } = useApp()
  const [isAdmin, setIsAdmin] = useState(false)
  const [stats, setStats] = useState<AdminStatsDTO[] | null>(null)
  const [promoteOpen, setPromoteOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const loadAdmin = () => {
    if (!user) return
    api<{ items: AdminStatsDTO[] }>(`/api/admin/stats?userId=${encodeURIComponent(user.id)}`)
      .then((d) => setStats(d.items))
      .catch(() => setStats([]))
  }

  useEffect(() => {
    if (isAdmin) loadAdmin()
     
  }, [isAdmin, user?.id])

  const myChannels = useMemo(() => stats ?? [], [stats])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!user || !username.trim() || submitting) return
    setSubmitting(true)
    try {
      await api('/api/admin/add_channel', {
        method: 'POST',
        body: JSON.stringify({ userId: user.id, username }),
      })
      setUsername('')
      loadAdmin()
      haptic('success')
      toast.success('Канал отправлен на модерацию')
    } catch (err) {
      toast.error((err as Error).message || 'Не удалось добавить канал')
      haptic('error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="pt-7">
      <div className="mx-4">
        <button
          type="button"
          role="switch"
          aria-checked={isAdmin}
          onClick={() => {
            haptic('light')
            setIsAdmin((v) => !v)
          }}
          className="flex w-full items-center gap-3 border-t border-tg-sep/60 py-4 text-left"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-tg-star/15">
            <Crown className="h-[18px] w-[18px] text-tg-star" />
          </span>
          <span className="flex-1 text-[16.5px] font-medium text-tg-text">Для админов каналов</span>
          <ChevronRight
            className={cn('h-5 w-5 text-tg-hint transition-transform', isAdmin && 'rotate-90')}
          />
        </button>
      </div>

      {isAdmin && (
        <div className="px-4 pb-2">
          {/* Дашборд */}
          {stats === null ? (
            <div className="flex justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-tg-hint" />
            </div>
          ) : myChannels.length === 0 ? (
            <p className="text-snippet leading-relaxed text-tg-hint">
              Добавьте свой канал — здесь появится статистика: просмотры в ленте, клики по [+] и
              CTR.
            </p>
          ) : (
            <div className="space-y-3">
              {myChannels.map((c) => (
                <div key={c.channelId} className="rounded-2xl bg-tg-surface p-4">
                  <div className="flex items-center gap-2.5">
                    <Avatar name={c.title} color={c.avatarColor} size={36} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14.5px] font-semibold text-tg-text">
                        {c.title}
                      </div>
                      <div className="text-[12px] text-tg-hint">
                        {c.posts} {pluralRu(c.posts, 'пост', 'поста', 'постов')} ·{' '}
                        {c.status === 'moderation' ? 'на модерации' : 'активен'}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-xl bg-tg-bg py-2.5">
                      <Eye className="mx-auto h-4 w-4 text-tg-hint" />
                      <div className="mt-1 text-[15px] font-bold leading-none text-tg-text">
                        {formatCount(c.views)}
                      </div>
                      <div className="mt-1 text-[10px] text-tg-hint">просмотры</div>
                    </div>
                    <div className="rounded-xl bg-tg-bg py-2.5">
                      <MousePointerClick className="mx-auto h-4 w-4 text-tg-hint" />
                      <div className="mt-1 text-[15px] font-bold leading-none text-tg-text">
                        {formatCount(c.clicks)}
                      </div>
                      <div className="mt-1 text-[10px] text-tg-hint">клики [+]</div>
                    </div>
                    <div className="rounded-xl bg-tg-bg py-2.5">
                      <BarChart3 className="mx-auto h-4 w-4 text-tg-hint" />
                      <div className="mt-1 text-[15px] font-bold leading-none text-tg-text">
                        {c.ctr}%
                      </div>
                      <div className="mt-1 text-[10px] text-tg-hint">CTR</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Продвижение */}
          <button
            type="button"
            onClick={() => {
              haptic('light')
              setPromoteOpen(true)
            }}
            className="mt-3.5 h-12 w-full rounded-full bg-tg-link text-[15px] font-semibold text-white transition active:scale-[0.98]"
          >
            Продвинуть в Топ
          </button>

          {/* Добавление канала */}
          <form onSubmit={submit} className="pt-4">
            <div className="text-[14px] font-semibold text-tg-text">Добавить свой канал</div>
            <div className="mt-2 flex gap-2">
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="@my_channel"
                aria-label="Юзернейм канала"
                className="h-11 min-w-0 flex-1 rounded-xl border border-tg-sep bg-tg-bg px-3.5 text-snippet text-tg-text outline-none placeholder:text-tg-hint focus:border-tg-link"
              />
              <button
                type="submit"
                disabled={submitting || !username.trim()}
                className={cn(
                  'flex h-11 shrink-0 items-center gap-1.5 rounded-full px-4 text-[14px] font-semibold transition active:scale-95',
                  submitting || !username.trim()
                    ? 'cursor-not-allowed bg-tg-surface text-tg-hint'
                    : 'bg-tg-link text-white',
                )}
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Отправить
              </button>
            </div>
          </form>
        </div>
      )}

      <PromoteSheet
        open={promoteOpen}
        onClose={() => setPromoteOpen(false)}
        channels={myChannels.filter((c) => c.status === 'active')}
      />
    </section>
  )
}

/* ---------- Вспомогательные ---------- */

function StatBlock({
  value,
  label,
  onClick,
}: {
  value?: number
  label: string
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn('flex flex-1 flex-col items-center py-1', onClick && 'active:opacity-60')}
    >
      <span className="text-[21px] font-bold leading-none text-tg-text tabular-nums">
        {value ?? '—'}
      </span>
      <span className="mt-1.5 text-[14px] text-tg-hint">{label}</span>
    </button>
  )
}

function SettingRow({
  icon,
  label,
  right,
  onClick,
  last,
}: {
  icon: React.ReactNode
  label: string
  right?: React.ReactNode
  onClick?: () => void
  last?: boolean
}) {
  const inner = (
    <>
      <span className="text-tg-text">{icon}</span>
      <span className="flex-1 text-[16.5px] text-tg-text">{label}</span>
      {right ?? <ChevronRight className="h-5 w-5 text-tg-hint" />}
    </>
  )
  const cls = cn(
    'flex w-full items-center gap-3.5 px-4 py-3.5 text-left',
    !last && 'border-b border-tg-sep/60',
    onClick && 'active:bg-tg-surface/60',
  )
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cls}>
        {inner}
      </button>
    )
  }
  return <div className={cls}>{inner}</div>
}

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-[30px] w-[51px] shrink-0 rounded-full transition-colors',
        checked ? 'bg-tg-green' : 'bg-tg-surface2',
      )}
    >
      <span
        className={cn(
          'absolute top-[2px] h-[26px] w-[26px] rounded-full bg-white shadow transition-all',
          checked ? 'left-[23px]' : 'left-[2px]',
        )}
      />
    </button>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-tg-hint">{label}</span>
      <span className="text-right font-medium text-tg-text">{value}</span>
    </div>
  )
}

function Segmented({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string; big?: boolean }[]
}) {
  return (
    <div>
      <div className="mb-1.5 text-[13px] text-tg-hint">{label}</div>
      <div className="flex rounded-xl bg-tg-surface p-1">
        {options.map((o, i) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            onClick={() => {
              onChange(o.value)
              haptic('light')
            }}
            className={cn(
              'h-9 flex-1 rounded-lg text-[14px] font-medium transition',
              value === o.value ? 'bg-tg-bg font-semibold text-tg-text shadow-sm' : 'text-tg-hint',
              o.big && i > 0 && 'text-[16px]',
              o.big && i === 2 && 'text-[18px]',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}
