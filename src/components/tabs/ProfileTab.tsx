'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Bell,
  ChevronRight,
  FileText,
  Headset,
  Info,
  Lightbulb,
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
  Star,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { stripMarkdown } from '@/lib/markdown'
import { formatCount, pluralRu } from '@/lib/format'
import { haptic, userAvatarUrl } from '@/lib/tg'
import type { PostDTO, ProfileStatsResponse, SubscriptionDTO } from '@/lib/types'
import { Avatar } from '@/components/tg/Avatar'
import { BottomSheet } from '@/components/tg/BottomSheet'
import { ThemeGallery } from '@/components/tg/ThemeGallery'
import { LANG_LIST, useT } from '@/lib/i18n'
import { APP_VERSION } from '@/lib/version'
import { Onboarding } from '@/components/tg/Onboarding'
import { LoginByTelegram } from '@/components/tg/LoginByTelegram'
import { THEMES, themeName } from '@/lib/themes'
import { SupportChat } from '@/components/support/SupportChat'


/** Элемент списка закладок — приходит из /api/bookmarks с отметкой прочтения */
type BookmarkItem = PostDTO & { readAt: string | null }

/**
 * Экран «Профиль» по макету: шапка пользователя, статистика,
 * мои категории, подписки, настройки. Плюс «Мой канал» и закладки.
 */
export function ProfileTab() {
  const { user, theme, fontScale, lang, setLang, setFontScale, categories, setTab, setCategory, openChannel } = useApp()
  const t = useT()
  const [profile, setProfile] = useState<{
    stats: { likes: number; subscriptions: number; views: number; bookmarks: number }
  } | null>(null)
  const [subs, setSubs] = useState<SubscriptionDTO[] | null>(null)
  const [bookmarks, setBookmarks] = useState<BookmarkItem[] | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [themesOpen, setThemesOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [privacyOpen, setPrivacyOpen] = useState(false)
  const [termsOpen, setTermsOpen] = useState(false)
  // Шит входа глобальный (zustand): открывается и отсюда, и из шторки лайка/закладки
  const loginOpen = useApp((s) => s.loginOpen)
  const setLoginOpen = useApp((s) => s.setLoginOpen)
  const [supportOpen, setSupportOpen] = useState(false)
  // Предложка/баг (v5.11): отдельный чат напрямую админу, без нейронки
  const [feedbackOpen, setFeedbackOpen] = useState(false)
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

  // Событие из инбокса «Активность» (уведомление поддержки): открыть чат поддержки.
  // Чат смонтирован во вкладке профиля, уведомление переключает вкладку и шлёт событие.
  useEffect(() => {
    const onOpenSupport = () => setSupportOpen(true)
    window.addEventListener('tgfeed:open-support', onOpenSupport)
    return () => window.removeEventListener('tgfeed:open-support', onOpenSupport)
  }, [])

  // Непрочитанные закладки (открытие поста — отметка «прочитано»)
  const unreadCount = useMemo(
    () => (bookmarks ?? []).filter((b) => !b.readAt).length,
    [bookmarks],
  )

  if (!user) return null

  const name = user.isGuest
    ? t('profile.reader')
    : [user.firstName, user.lastName].filter(Boolean).join(' ') || t('profile.name')
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
    <div className="no-scrollbar h-full w-full overflow-y-auto overscroll-contain pb-28">
      {/* Центрированная колонка: на широких мониторах секции профиля не должны
          растягиваться на весь экран (жалоба «слишком растянуто») */}
      <div className="mx-auto w-full max-w-[880px]">
      {/* Заголовок */}
      <header className="px-4 pb-2 pt-4">
        <h1 className="text-screen-title text-tg-text">Профиль</h1>
      </header>

      {/* Пользователь */}
      <section className="flex items-center gap-4 px-4 pt-2">
        <Avatar
          name={name}
          color="#0a84ff"
          src={userAvatarUrl(user.id, user.photoUrl)}
          size={80}
          className="ring-2 ring-tg-sep/70"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[22px] font-bold leading-tight text-tg-text">{name}</span>
            {user.isPremium && (
              <span
                className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-tg-star/15 px-2 py-0.5 text-[11px] font-bold text-tg-star"
                title="Telegram Premium"
              >
                <Star className="h-3 w-3 fill-current" /> Premium
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[15.5px] text-tg-hint">
            {user.username ? `@${user.username}` : user.isGuest ? t('profile.subGuestHint') : t('profile.noUsername')}
          </div>
          {!user.isGuest && (
            <div className="mt-1 flex items-center gap-1 text-[12px] font-medium text-tg-link">
              <ShieldCheck className="h-3.5 w-3.5" />
              Telegram аккаунт подтверждён
            </div>
          )}
          {user.isGuest && (
            <button
              type="button"
              onClick={() => {
                haptic('light')
                setLoginOpen(true)
              }}
              className="mt-2 flex h-9 items-center gap-1.5 rounded-full bg-tg-link px-3.5 text-[13px] font-bold text-white transition active:scale-95"
            >
              <Send className="h-3.5 w-3.5" />
              Вход по Telegram
            </button>
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
                <Avatar name={s.channel.title} color={s.channel.avatarColor} src={s.channel.avatarUrl} size={48} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[16.5px] font-semibold text-tg-text">
                    {s.channel.title}
                  </span>
                  <span className="block truncate text-[14px] text-tg-hint">
                    {s.channel.subscribersCount > 0 && `${formatCount(s.channel.subscribersCount)} подписчиков`}
                    {s.hidden && `${s.channel.subscribersCount > 0 ? ' · ' : ''}скрыт из ленты`}
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
                    <Avatar name={p.channel.title} color={p.channel.avatarColor} src={p.channel.avatarUrl} size={40} />
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
                        'mt-0.5 line-clamp-2 text-[13.5px] leading-snug',
                        unread ? 'text-tg-text/80' : 'text-tg-hint',
                      )}
                    >
                      {p.text ? stripMarkdown(p.text) || 'медиа-пост' : 'медиа-пост'}
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
            label="Тема оформления"
            right={
              <span className="flex items-center gap-0.5 text-[15px] text-tg-hint">
                {themeName(theme)}
                <ChevronRight className="h-4 w-4" strokeWidth={1.7} />
              </span>
            }
            onClick={() => setThemesOpen(true)}
          />
          <SettingRow
            icon={<FileText className="h-[22px] w-[22px]" strokeWidth={1.7} />}
            label="Пользовательское соглашение"
            right={
              <span className="flex items-center gap-0.5 text-[15px] text-tg-hint">
                валюта и условия
                <ChevronRight className="h-4 w-4" strokeWidth={1.7} />
              </span>
            }
            onClick={() => setTermsOpen(true)}
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
          />
        </div>
      </section>

      {/* Поддержка — в самом низу профиля */}
      <section className="pt-7 pb-6">
        <h2 className="px-4 text-[19px] font-bold text-tg-text">{t('support.section')}</h2>
        <div className="mt-1">
          <SettingRow
            icon={<Headset className="h-[22px] w-[22px]" strokeWidth={1.7} />}
            label={t('support.profileRow')}
            right={
              <span className="flex items-center gap-1 text-[15px] text-tg-hint">
                {t('support.profileHint')}
                <ChevronRight className="h-4 w-4" strokeWidth={1.7} />
              </span>
            }
            onClick={() => {
              haptic('light')
              setSupportOpen(true)
            }}
            last={false}
          />
          <SettingRow
            icon={<Lightbulb className="h-[22px] w-[22px]" strokeWidth={1.7} />}
            label={t('feedback.title')}
            right={
              <span className="flex items-center gap-1 text-[15px] text-tg-hint">
                {t('feedback.subtitleIdle')}
                <ChevronRight className="h-4 w-4" strokeWidth={1.7} />
              </span>
            }
            onClick={() => {
              haptic('light')
              setFeedbackOpen(true)
            }}
            last
          />
        </div>
      </section>
      </div>

      {/* Шиты */}
      <BottomSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Настройки интерфейса"
        subtitle="Оформление и размер текста"
      >
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => {
              setSettingsOpen(false)
              setThemesOpen(true)
            }}
            className="w-full rounded-2xl bg-tg-surface p-3.5 text-left active:opacity-80"
          >
            <span className="block text-[13px] font-medium text-tg-hint">Тема</span>
            <span className="mt-0.5 flex items-center justify-between">
              <span className="text-[16px] font-semibold text-tg-text">{themeName(theme)}</span>
              <span className="text-[14px] font-medium text-tg-link">Все темы ({THEMES.length})</span>
            </span>
          </button>
          <Segmented
            label={t('settings.font')}
            value={fontScale}
            onChange={(v) => setFontScale(v as typeof fontScale)}
            options={[
              { value: 'sm', label: 'A' },
              { value: 'md', label: 'A', big: true },
              { value: 'lg', label: 'A', big: true },
            ]}
          />
          <Segmented
            label={t('profile.language')}
            value={lang}
            onChange={(v) => setLang(v as typeof lang)}
            options={LANG_LIST.map((l) => ({ value: l.id, label: l.native }))}
          />
        </div>
      </BottomSheet>

      <BottomSheet
        open={aboutOpen}
        onClose={() => setAboutOpen(false)}
        title="Tg Swipe"
        subtitle="Умная лента открытых Telegram-каналов"
      >
        <div className="space-y-2.5 text-snippet text-tg-text2">
          <Row label="Версия" value={APP_VERSION} />
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
            (в миниаппе или на сайте через нашего бота) используется только ваш публичный
            профиль: имя, @username и аватар.
          </p>
          <p>
            Лайки, подписки и закладки хранятся, чтобы восстановить вашу ленту на любом устройстве.
            Вы можете отписаться от канала или убрать закладку в любой момент.
          </p>
        </div>
      </BottomSheet>

      {/* Пользовательское соглашение: валюта «Свайпы» и условия */}
      <BottomSheet
        open={termsOpen}
        onClose={() => setTermsOpen(false)}
        title="Пользовательское соглашение"
        subtitle="Валюта, платежи и условия сервиса"
      >
        <div className="space-y-3 text-snippet leading-relaxed text-tg-text2">
          <section className="rounded-2xl bg-tg-surface/70 p-3.5">
            <h3 className="text-[14.5px] font-bold text-tg-text">Валюта сервиса — Свайпы</h3>
            <p className="mt-1.5 text-tg-hint">
              Внутренняя валюта Tg Swipe — <b className="text-tg-text">свайпы</b>. Курс всегда
              один: <b className="text-tg-text">1 свайп = 1 рубль</b>. Свайпы тратятся на
              продвижение Telegram-каналов: рекламные кампании в ленте (оплата за уникальных
              читателей, CPA) и premium-размещение.
            </p>
          </section>
          <section className="rounded-2xl bg-tg-surface/70 p-3.5">
            <h3 className="text-[14.5px] font-bold text-tg-text">Пополнение</h3>
            <p className="mt-1.5 text-tg-hint">
              Баланс пополняется в рублях (банковская карта или СБП), Telegram Stars или криптовалютой
              TON — от 100 рублей за операцию. Курс TON фиксируется в момент выставления счёта. Свайпы
              зачисляются на эскроу-счёт автоматически после подтверждения оплаты.
            </p>
          </section>
          <section className="rounded-2xl bg-tg-surface/70 p-3.5">
            <h3 className="text-[14.5px] font-bold text-tg-text">Списание и возврат</h3>
            <p className="mt-1.5 text-tg-hint">
              Списание идёт только за реальные уникальные переходы читателей (эскроу). Не
              израсходованный баланс остаётся на счёте. Свайпы — внутренняя валюта сервиса и не
              подлежат обмену обратно на деньги, кроме случаев, предусмотренных законом.
            </p>
          </section>
          <section className="rounded-2xl bg-tg-surface/70 p-3.5">
            <h3 className="text-[14.5px] font-bold text-tg-text">Контент</h3>
            <p className="mt-1.5 text-tg-hint">
              Лента собирает публичные посты открытых Telegram-каналов. Права на контент остаются
              у авторов каналов. Скрыть свой канал из ленты можно по обращению в поддержку.
            </p>
          </section>
        </div>
      </BottomSheet>

      {/* Вход по Telegram (сайт + гости) */}
      <LoginByTelegram open={loginOpen} onClose={() => setLoginOpen(false)} />

      <Onboarding open={editOpen} mode="edit" onClose={() => setEditOpen(false)} />
      {/* Галерея тем оформления */}
      <ThemeGallery open={themesOpen} onClose={() => setThemesOpen(false)} />

      {/* Чат поддержки (телеграм-стиль) */}
      <SupportChat open={supportOpen} onClose={() => setSupportOpen(false)} />
      <SupportChat open={feedbackOpen} onClose={() => setFeedbackOpen(false)} kind="feedback" />
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
