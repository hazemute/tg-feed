'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  ChevronRight,
  CreditCard,
  FileText,
  Headset,
  Info,
  Landmark,
  Lightbulb,
  Loader2,
  MousePointerClick,
  Radio,
  Send,
  Settings,
  ShieldCheck,
  X,
  BarChart3,
  BookOpen,
  Check,
  CheckCheck,
  Eye,
  Heart,
  Sparkles,
  Star,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { stripMarkdown } from '@/lib/markdown'
import { formatCount, pluralRu } from '@/lib/format'
import { haptic, openInvoiceUrl, userAvatarUrl } from '@/lib/tg'
import type { PostDTO, ProfileStatsResponse, SubscriptionDTO, TiersResponse } from '@/lib/types'
import { Avatar } from '@/components/tg/Avatar'
import { BottomSheet } from '@/components/tg/BottomSheet'
import { ThemeGallery } from '@/components/tg/ThemeGallery'
import { LANG_LIST, useT } from '@/lib/i18n'
import { APP_VERSION } from '@/lib/version'
import { Onboarding } from '@/components/tg/Onboarding'
import { LoginByTelegram } from '@/components/tg/LoginByTelegram'
import { THEMES, themeName } from '@/lib/themes'
import { SupportChat } from '@/components/support/SupportChat'
import { UserBadges } from '@/components/badges/UserBadges'
import { YooKassaWidget } from '@/components/payments/YooKassaWidget'


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
  const [requisitesOpen, setRequisitesOpen] = useState(false)
  // Меню-шиты (разгрузка профиля, приказ владельца): вместо пяти отдельных строк
  // в списке — две обзорные кнопки «Информация» и «Обратная связь», а конкретные
  // разделы открываются уже внутри них
  const [infoMenuOpen, setInfoMenuOpen] = useState(false)
  const [feedbackMenuOpen, setFeedbackMenuOpen] = useState(false)
  // Шит входа глобальный (zustand): открывается и отсюда, и из шторки лайка/закладки
  const loginOpen = useApp((s) => s.loginOpen)
  const setLoginOpen = useApp((s) => s.setLoginOpen)
  const [supportOpen, setSupportOpen] = useState(false)
  // Предложка/баг (v5.11): отдельный чат напрямую админу, без нейронки
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  // Тарифы Snap (v5.17): шит тарифов + свежие данные тира (для строки и бейджа в шапке)
  const [tiersOpen, setTiersOpen] = useState(false)
  const [tiersData, setTiersData] = useState<TiersResponse | null>(null)

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
  // Тир для UI: если шит тарифов уже грузил свежие данные (GET /api/tiers) —
  // приоритет им, иначе берём тир из стора (UserDTO.tier)
  const headerTier = tiersData?.tier ?? user.tier ?? 'free'

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
            {headerTier !== 'free' && (
              <span
                className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-tg-star/15 px-2 py-0.5 text-[11px] font-bold text-tg-star"
                title={TIER_NAMES[headerTier]}
              >
                <Zap className="h-3 w-3 fill-current" />
                {headerTier === 'plus' ? 'PLUS' : 'PRO'}
              </span>
            )}
          </div>
          {/* v5.19: бейджи статуса (разработчик/менеджер/спонсор…) — отдаёт /api/auth */}
          {user.badges && user.badges.length > 0 && (
            <div className="mt-1.5">
              <UserBadges badges={user.badges} max={5} />
            </div>
          )}
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
          <div className="space-y-3 px-4 pt-3" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="tg-shimmer h-12 w-12 rounded-full" />
                <div className="flex-1 space-y-2">
                  <div className="tg-shimmer h-3.5 w-1/3 rounded" />
                  <div className="tg-shimmer h-3 w-1/4 rounded" />
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
            icon={<Sparkles className="h-[22px] w-[22px]" strokeWidth={1.7} />}
            label="Тариф Snap"
            right={
              <span className="flex items-center gap-0.5 text-[15px]">
                <span
                  className={cn(
                    headerTier === 'free' ? 'text-tg-hint' : 'font-semibold text-tg-star',
                  )}
                >
                  {TIER_NAMES[headerTier]}
                </span>
                <ChevronRight className="h-4 w-4" strokeWidth={1.7} />
              </span>
            }
            onClick={() => {
              haptic('light')
              setTiersOpen(true)
            }}
          />
          {/* Одна строка вместо трёх: соглашение/конфиденциальность/о приложении —
              внутри шита «Информация» (приказ владельца: разгрузить профиль) */}
          <SettingRow
            icon={<Info className="h-[22px] w-[22px]" strokeWidth={1.7} />}
            label={t('profile.infoRow')}
            right={
              <span className="flex items-center gap-0.5 text-[15px] text-tg-hint">
                {t('profile.infoHint')}
                <ChevronRight className="h-4 w-4" strokeWidth={1.7} />
              </span>
            }
            onClick={() => setInfoMenuOpen(true)}
            last
          />
        </div>
      </section>

      {/* Мой канал — из навбара переехал в низ профиля (приказ владельца);
          v5.15: без описания, только название в одну строку */}
      <section className="pt-7">
        <h2 className="px-4 text-[19px] font-bold text-tg-text">Каналы</h2>
        <div className="mt-1">
          <SettingRow
            icon={<Radio className="h-[22px] w-[22px]" strokeWidth={1.7} />}
            label={t('profile.myChannelRow')}
            onClick={() => {
              haptic('light')
              setTab('mychannel')
            }}
          />
        </div>
      </section>

      {/* Обратная связь — одна кнопка вместо двух, разделы внутри шита */}
      <section className="pt-7 pb-6">
        <h2 className="px-4 text-[19px] font-bold text-tg-text">{t('profile.fbSheet')}</h2>
        <div className="mt-1">
          <SettingRow
            icon={<Headset className="h-[22px] w-[22px]" strokeWidth={1.7} />}
            label={t('profile.fbRow')}
            right={
              <span className="flex items-center gap-0.5 text-[15px] text-tg-hint">
                {t('profile.fbHint')}
                <ChevronRight className="h-4 w-4" strokeWidth={1.7} />
              </span>
            }
            onClick={() => setFeedbackMenuOpen(true)}
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
            <h3 className="text-[14.5px] font-bold text-tg-text">Общие положения</h3>
            <p className="mt-1.5 text-tg-hint">
              Сервис Tg Swipe — агрегатор публичных постов открытых Telegram-каналов с инструментами
              продвижения и подписками Snap. Исполнитель указан в разделе
              «Реквизиты и контакты». Настоящее соглашение — публичная оферта: начало использования
              сервиса означает согласие с её условиями.
            </p>
          </section>
          <section className="rounded-2xl bg-tg-surface/70 p-3.5">
            <h3 className="text-[14.5px] font-bold text-tg-text">Услуги и тарифы</h3>
            <ul className="mt-1.5 space-y-1 text-tg-hint">
              <li>• Free — бесплатно: лента, свайпы, 3 ИИ-поиска в день;</li>
              <li>• Snap Plus — 390 ₽/мес или 2 990 ₽/год: безлимитный ИИ-поиск,
              инкогнито, приоритетная скорость, премиум-эмодзи;</li>
              <li>• Snap Pro — 1 490 ₽/мес или 9 990 ₽/год: всё из Plus,
              ИИ-контентщик, продвижение до 7 постов в неделю, CTA-кнопка,</li>
              <li>• Реклама: внутренняя валюта «свайпы» (1 свайп = 1 ₽) — CPA-кампании
              за уникальных читателей.</li>
            </ul>
          </section>
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
            <h3 className="text-[14.5px] font-bold text-tg-text">Пополнение и оплата</h3>
            <p className="mt-1.5 text-tg-hint">
              Баланс пополняется в рублях (банковская карта или СБП), Telegram Stars или криптовалютой
              TON — от 100 рублей за операцию. Курс TON фиксируется в момент выставления счёта. Свайпы
              зачисляются на эскроу-счёт автоматически после подтверждения оплаты. Оплата картой
              проходит через платёжную форму ЮKassa, открываемую непосредственно на сайте — без
              переадресации на сторонние ресурсы. Подписка Snap действует до конца оплаченного
              периода; возврат средств за неиспользованный период — в порядке, предусмотренном
              законодательством РФ.
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

      {/* Реквизиты и контакты (требования СБ ЮKassa) */}
      <RequisitesSheet open={requisitesOpen} onClose={() => setRequisitesOpen(false)} />

      {/* Меню «Информация»: соглашение, конфиденциальность, о приложении */}
      <BottomSheet
        open={infoMenuOpen}
        onClose={() => setInfoMenuOpen(false)}
        title={t('profile.infoSheet')}
        subtitle={t('profile.infoSheetSub')}
      >
        <div className="-mx-2">
          <SettingRow
            icon={<FileText className="h-[22px] w-[22px]" strokeWidth={1.7} />}
            label="Пользовательское соглашение"
            right={
              <span className="flex items-center gap-0.5 text-[14px] text-tg-hint">
                валюта и условия
                <ChevronRight className="h-4 w-4" strokeWidth={1.7} />
              </span>
            }
            onClick={() => {
              setInfoMenuOpen(false)
              setTermsOpen(true)
            }}
          />
          <SettingRow
            icon={<ShieldCheck className="h-[22px] w-[22px]" strokeWidth={1.7} />}
            label="Конфиденциальность"
            onClick={() => {
              setInfoMenuOpen(false)
              setPrivacyOpen(true)
            }}
          />
          <SettingRow
            icon={<Landmark className="h-[22px] w-[22px]" strokeWidth={1.7} />}
            label="Реквизиты и контакты"
            right={
              <span className="flex items-center gap-0.5 text-[14px] text-tg-hint">
                исполнитель, поддержка
                <ChevronRight className="h-4 w-4" strokeWidth={1.7} />
              </span>
            }
            onClick={() => {
              setInfoMenuOpen(false)
              setRequisitesOpen(true)
            }}
          />
          <SettingRow
            icon={<Info className="h-[22px] w-[22px]" strokeWidth={1.7} />}
            label="О приложении"
            onClick={() => {
              setInfoMenuOpen(false)
              setAboutOpen(true)
            }}
            last
          />
        </div>
        <p className="mt-2 px-2 text-[12.5px] text-tg-hint">Tg Swipe · версия {APP_VERSION}</p>
      </BottomSheet>

      {/* Меню «Обратная связь»: поддержка и предложка/баги */}
      <BottomSheet
        open={feedbackMenuOpen}
        onClose={() => setFeedbackMenuOpen(false)}
        title={t('profile.fbSheet')}
        subtitle={t('profile.fbSheetSub')}
      >
        <div className="-mx-2">
          <SettingRow
            icon={<Headset className="h-[22px] w-[22px]" strokeWidth={1.7} />}
            label={t('support.profileRow')}
            right={
              <span className="flex items-center gap-0.5 text-[14px] text-tg-hint">
                {t('support.profileHint')}
                <ChevronRight className="h-4 w-4" strokeWidth={1.7} />
              </span>
            }
            onClick={() => {
              setFeedbackMenuOpen(false)
              setSupportOpen(true)
            }}
          />
          <SettingRow
            icon={<Lightbulb className="h-[22px] w-[22px]" strokeWidth={1.7} />}
            label={t('feedback.title')}
            right={
              <span className="flex items-center gap-0.5 text-[14px] text-tg-hint">
                {t('feedback.subtitle')}
                <ChevronRight className="h-4 w-4" strokeWidth={1.7} />
              </span>
            }
            onClick={() => {
              setFeedbackMenuOpen(false)
              setFeedbackOpen(true)
            }}
            last
          />
        </div>
      </BottomSheet>

      {/* Тарифы Snap: статус тира, лимит ИИ-поиска, покупка Plus/Pro через Stars */}
      <TiersSheet open={tiersOpen} onClose={() => setTiersOpen(false)} onLoaded={setTiersData} />

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

/* ---------- Тарифы Snap (v5.17): статус + покупка Plus/Pro через Stars ---------- */

/** Названия тиров для UI */
const TIER_NAMES: Record<'free' | 'plus' | 'pro', string> = {
  free: 'Бесплатный',
  plus: 'Snap Plus',
  pro: 'Snap Pro',
}

/** Фичи тарифных карточек — текст с экрана «Тариф Snap» */
const PLAN_META: { plan: 'plus' | 'pro'; title: string; features: string[] }[] = [
  {
    plan: 'plus',
    title: 'Snap Plus',
    features: [
      'Безлимитный ИИ-поиск',
      'Режим «Инкогнито» — просмотры скрыты из статистики админов',
      'Приоритетная скорость медиа',
      'Анимированные премиум-эмодзи',
    ],
  },
  {
    plan: 'pro',
    title: 'Snap Pro',
    features: [
      'Всё из Snap Plus',
      'ИИ-контентщик: пост + картинка + публикация в канал',
      'Продвижение в ленте 7 раз в неделю',
      'Бейдж Premium-автора',
      'Кастомная CTA-кнопка в постах',
    ],
  },
]

/** Копейки → «2 990 ₽» (цены из /api/tiers приходят в копейках) */
const kopToRub = (kop: number): string => `${(kop / 100).toLocaleString('ru-RU')} ₽`

/**
 * Шит «Тариф Snap»: карточка текущего тира (с лимитом ИИ-поиска для free),
 * карточки Plus/Pro с выбором периода (месяц/год) и покупкой через
 * Telegram Stars — POST /api/tiers отдаёт invoiceUrl, открываем нативный
 * инвойс через openInvoiceUrl; по оплате ('paid') подтягиваем свежий тир.
 */
function TiersSheet({
  open,
  onClose,
  onLoaded,
}: {
  open: boolean
  onClose: () => void
  onLoaded: (d: TiersResponse) => void
}) {
  const [data, setData] = useState<TiersResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [period, setPeriod] = useState<{ plus: 'month' | 'year'; pro: 'month' | 'year' }>({
    plus: 'month',
    pro: 'month',
  })
  const [buying, setBuying] = useState<'plus' | 'pro' | null>(null)
  /** ЮKassa: confirmation_token открытого виджета оплаты картой (на сайте) */
  const [yk, setYk] = useState<{ token: string; title: string } | null>(null)

  // Загружаем состояние тарифов при каждом открытии шита (и по кнопке «Повторить»)
  useEffect(() => {
    if (!open) return
    const ac = new AbortController()
    setLoading(true)
    setFailed(false)
    api<TiersResponse>('/api/tiers', { signal: ac.signal })
      .then((d) => {
        setData(d)
        onLoaded(d)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if ((e as Error)?.name !== 'AbortError') {
          setFailed(true)
          setLoading(false)
        }
      })
    return () => ac.abort()
  }, [open, reloadKey, onLoaded])

  // Тихое обновление без скелетона: после создания счёта и после оплаты
  const refresh = () => {
    api<TiersResponse>('/api/tiers')
      .then((d) => {
        setData(d)
        onLoaded(d)
      })
      .catch(() => {})
  }

  const buy = async (plan: 'plus' | 'pro') => {
    if (buying) return
    setBuying(plan)
    haptic('light')
    try {
      const r = await api<{ ok: boolean; invoiceUrl: string; stars: number }>('/api/tiers', {
        method: 'POST',
        body: JSON.stringify({ plan, period: period[plan] }),
      })
      // Нативное окно оплаты Stars; статус 'paid' → подтягиваем свежий тир
      openInvoiceUrl(r.invoiceUrl, refresh)
      toast.success('Счёт создан — подтвердите оплату в Telegram')
      refresh()
    } catch (e) {
      toast.error((e as Error).message || 'Не удалось создать счёт')
    } finally {
      setBuying(null)
    }
  }

  /** Оплата картой через ЮKassa — виджет открывается прямо в приложении, без переадресаций (требование СБ) */
  const buyCard = async (plan: 'plus' | 'pro') => {
    if (buying) return
    setBuying(plan)
    haptic('light')
    try {
      const r = await api<{ ok: boolean; confirmationToken: string | null }>('/api/tiers', {
        method: 'POST',
        body: JSON.stringify({ plan, period: period[plan], method: 'card' }),
      })
      if (r.confirmationToken) {
        const p = data?.prices[plan]
        const rub = p ? kopToRub(period[plan] === 'month' ? p.monthKop : p.yearKop) : ''
        setYk({ token: r.confirmationToken, title: `${rub} · Snap ${plan === 'pro' ? 'Pro' : 'Plus'}` })
      }
    } catch (e) {
      toast.error((e as Error).message || 'Не удалось создать счёт')
    } finally {
      setBuying(null)
    }
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Тариф Snap"
      subtitle="ИИ-поиск, инкогнито и инструменты для канала"
    >
      {loading && (
        <div className="space-y-3" aria-hidden>
          <div className="tg-shimmer h-20 rounded-2xl" />
          <div className="tg-shimmer h-56 rounded-2xl" />
          <div className="tg-shimmer h-64 rounded-2xl" />
        </div>
      )}

      {!loading && failed && (
        <div className="rounded-2xl bg-tg-surface p-4 text-center">
          <p className="text-[14.5px] text-tg-hint">Не удалось загрузить тарифы</p>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="mt-3 h-11 w-full rounded-xl bg-tg-link text-[15px] font-semibold text-white transition active:scale-[0.98]"
          >
            Повторить
          </button>
        </div>
      )}

      {!loading && !failed && data && (
        <>
          {/* Текущий статус */}
          <div className="rounded-2xl bg-tg-surface p-4">
            <p className="text-[15.5px] font-bold text-tg-text">
              Ваш тариф: {TIER_NAMES[data.tier]}
            </p>
            {data.tier !== 'free' && data.tierUntil ? (
              <p className="mt-1 text-[13.5px] text-tg-hint">
                активен до{' '}
                {new Date(data.tierUntil).toLocaleDateString('ru-RU', {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                })}
              </p>
            ) : data.tier === 'free' && data.aiSearch.limit > 0 ? (
              <p className="mt-1 text-[13.5px] text-tg-hint">
                Использовано ИИ-поисков сегодня: {data.aiSearch.used} из {data.aiSearch.limit}
              </p>
            ) : null}
          </div>

          {/* Карточки Plus / Pro */}
          <div className="mt-3 space-y-3">
            {PLAN_META.map((meta) => {
              const price = data.prices[meta.plan]
              const p = period[meta.plan]
              return (
                <div key={meta.plan} className="rounded-2xl bg-tg-surface p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[17px] font-bold text-tg-text">{meta.title}</span>
                    {data.tier === meta.plan && (
                      <span className="shrink-0 rounded-full bg-tg-star/15 px-2 py-0.5 text-[11px] font-bold text-tg-star">
                        текущий
                      </span>
                    )}
                  </div>
                  {/* Цена активного периода + альтернатива */}
                  <div className="mt-2 flex items-baseline gap-1.5">
                    <span className="text-[21px] font-bold leading-none tabular-nums text-tg-text">
                      {kopToRub(p === 'month' ? price.monthKop : price.yearKop)}
                    </span>
                    <span className="text-[13.5px] text-tg-hint">/ {p === 'month' ? 'мес' : 'год'}</span>
                  </div>
                  <p className="mt-0.5 text-[13px] text-tg-hint">
                    или {kopToRub(p === 'month' ? price.yearKop : price.monthKop)} /{' '}
                    {p === 'month' ? 'год' : 'мес'}
                  </p>
                  <ul className="mt-3 space-y-2">
                    {meta.features.map((f) => (
                      <li
                        key={f}
                        className="flex items-start gap-2 text-[13.5px] leading-snug text-tg-text2"
                      >
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" strokeWidth={2.5} />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                  {/* Переключатель периода подписки */}
                  <div className="mt-3.5 flex rounded-xl bg-tg-sep/40 p-1">
                    {(['month', 'year'] as const).map((per) => (
                      <button
                        key={per}
                        type="button"
                        aria-pressed={p === per}
                        onClick={() => {
                          setPeriod((prev) =>
                            meta.plan === 'plus' ? { ...prev, plus: per } : { ...prev, pro: per },
                          )
                          haptic('light')
                        }}
                        className={cn(
                          'h-10 flex-1 rounded-lg text-[14px] font-medium transition',
                          p === per
                            ? 'bg-tg-bg font-semibold text-tg-text shadow-sm'
                            : 'text-tg-hint',
                        )}
                      >
                        {per === 'month' ? 'Месяц' : 'Год (выгодно)'}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    disabled={buying !== null}
                    onClick={() => buy(meta.plan)}
                    className="mt-2.5 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-tg-link text-[15px] font-semibold text-white transition active:scale-[0.98] disabled:bg-tg-sep/60 disabled:text-tg-hint"
                  >
                    {buying === meta.plan ? (
                      <>
                        <Loader2 className="h-4.5 w-4.5 animate-spin" />
                        Открываем счёт…
                      </>
                    ) : (
                      <>
                        Оформить за{' '}
                        {price[p === 'month' ? 'monthStars' : 'yearStars'].toLocaleString('ru-RU')} ⭐
                      </>
                    )}
                  </button>
                  {/* Карта: виджет ЮKassa на сайте — показываем, когда эквайринг подключён (methods.card) */}
                  {data.methods.card && (
                    <button
                      type="button"
                      disabled={buying !== null}
                      onClick={() => buyCard(meta.plan)}
                      className="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-tg-sep bg-tg-bg text-[15px] font-semibold text-tg-text transition active:scale-[0.98] disabled:opacity-50"
                    >
                      <CreditCard className="h-4.5 w-4.5" strokeWidth={1.8} />
                      Картой {kopToRub(p === 'month' ? price.monthKop : price.yearKop)}
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          <p className="mt-3 text-center text-[12px] leading-snug text-tg-hint">
            Оплата: Telegram Stars или банковская карта (ЮKassa, форма открывается на сайте).
            Подписка действует до конца оплаченного периода.
          </p>
        </>
      )}

      {/* ЮKassa: форма оплаты картой ПРЯМО ЗДЕСЬ (без переадресаций — требование СБ) */}
      <YooKassaWidget
        open={yk !== null}
        token={yk?.token ?? null}
        title={yk?.title ?? 'Оплата подписки'}
        onClose={() => setYk(null)}
        onSuccess={refresh}
      />
    </BottomSheet>
  )
}

/**
 * «Реквизиты и контакты» — обязательный документ для эквайринга (требования
 * СБ ЮKassa): данные исполнителя, способы оплаты и каналы связи.
 * Значения приходят из env (LEGAL_NAME / LEGAL_INN / SUPPORT_EMAIL) через
 * GET /api/tiers — источник истины у владельца, без пересборки интерфейса.
 */
function RequisitesSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [legal, setLegal] = useState<TiersResponse['legal'] | null>(null)

  useEffect(() => {
    if (!open) return
    api<TiersResponse>('/api/tiers')
      .then((d) => setLegal(d.legal))
      .catch(() => setLegal(null))
  }, [open])

  const rows: Array<{ label: string; value: string }> = [
    { label: 'Исполнитель', value: legal?.name || 'Индивидуальный предприниматель' },
    { label: 'ИНН', value: legal?.inn || '—' },
    { label: 'Сервис', value: 'Tg Swipe — умная лента Telegram-каналов' },
    { label: 'Поддержка', value: legal?.email || 'чат в приложении: Профиль → Обратная связь' },
  ]

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Реквизиты и контакты"
      subtitle="Исполнитель, способы оплаты, поддержка"
    >
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.label} className="rounded-2xl bg-tg-surface/70 p-3.5">
            <p className="text-[11px] font-medium uppercase tracking-wide text-tg-hint">{r.label}</p>
            <p className="mt-0.5 break-words text-[14px] font-semibold text-tg-text">{r.value}</p>
          </div>
        ))}
        <div className="rounded-2xl bg-tg-surface/70 p-3.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-tg-hint">
            Способы оплаты
          </p>
          <p className="mt-0.5 text-[14px] leading-snug text-tg-text">
            Банковская карта (ЮKassa — форма открывается прямо на сайте, без переадресаций),
            Telegram Stars, TON.
          </p>
        </div>
        <p className="px-1 text-[12px] leading-snug text-tg-hint">
          Полные условия оказания услуг и тарифы — в «Пользовательском соглашении».
        </p>
      </div>
    </BottomSheet>
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
        <div className="mx-4 mt-3 flex items-end gap-2" aria-hidden>
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
              <div
                className="tg-shimmer w-full max-w-[26px] rounded-full"
                style={{ height: `${16 + ((i * 13) % 30)}px` }}
              />
              <div className="tg-shimmer h-2.5 w-5 rounded" />
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
      <span className="shrink-0 text-tg-text">{icon}</span>
      {/* v5.15: название всегда в одну строку — длинные подписи обрезаются, не переносятся */}
      <span className="min-w-0 flex-1 truncate text-[16.5px] text-tg-text">{label}</span>
      {right ?? <ChevronRight className="h-5 w-5 shrink-0 text-tg-hint" />}
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
