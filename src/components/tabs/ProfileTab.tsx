'use client'

import { useEffect, useState } from 'react'
import {
  Check,
  ChevronRight,
  CreditCard,
  FileText,
  Headset,
  Info,
  Landmark,
  Lightbulb,
  Loader2,
  MousePointerClick,
  Pencil,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Wallet,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { formatCount } from '@/lib/format'
import { haptic, openInvoiceUrl, userAvatarUrl } from '@/lib/tg'
import type { SubscriptionDTO, TiersResponse } from '@/lib/types'
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
import { WalletPage } from '@/components/tabs/WalletPage'
import { ProfileCustomizer } from '@/components/profile/ProfileCustomizer'
import { ProfileHeaderCover, ProfileTierChips } from '@/components/profile/ProfileHeaderCover'
import { LevelBar } from '@/components/profile/LevelBar'
import { LevelSheet } from '@/components/profile/LevelSheet'
import { GiveawayCard } from '@/components/profile/GiveawayCard'


/**
 * v5.35: SWR-кэш уровня модуля (паттерн v5.34 «кэш виден, сеть догоняет»).
 * Вкладка профиля размонтируется при переключении табов — без кэша каждое
 * возвращение мигало скелетонами и прочерками статистики. Теперь при монтировании
 * мгновенно рендерим прошлые данные, а сеть их тихо обновляет.
 */
type ProfileStats = { stats: { likes: number; subscriptions: number; views: number; bookmarks: number } }
let cachedStats: ProfileStats | null = null
let cachedSubs: SubscriptionDTO[] | null = null

/**
 * Экран «Профиль» по макету: шапка пользователя, статистика,
 * мои категории, подписки, настройки.
 * v5.58: «Мой канал» и Snap Ассистент переехали во вкладку «Канал».
 */
export function ProfileTab() {
  const { user, theme, fontScale, lang, setLang, setFontScale, categories, setTab, setCategory, openChannel } = useApp()
  const t = useT()
  const [profile, setProfile] = useState<ProfileStats | null>(() => cachedStats)
  const [subs, setSubs] = useState<SubscriptionDTO[] | null>(() => cachedSubs)
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
  // Оформление профиля (v5.27): отдельная полная страница кастомайзера
  const [customizerOpen, setCustomizerOpen] = useState(false)
  // v5.75: шит уровня (тап по XP-бару под ником)
  const [levelOpen, setLevelOpen] = useState(false)
  // Кошелёк v2 (v5.77): полная страница вместо плашки; пополнение живёт внутри неё
  const [walletOpen, setWalletOpen] = useState(false)

  const reload = () => {
    if (!user) return
    api<ProfileStats>(`/api/profile?userId=${encodeURIComponent(user.id)}`)
      .then((d) => {
        cachedStats = d
        setProfile(d)
      })
      .catch(() => {})
    api<{ items: SubscriptionDTO[] }>(`/api/subscriptions?userId=${encodeURIComponent(user.id)}`)
      .then((d) => {
        cachedSubs = d.items
        setSubs(d.items)
      })
      .catch(() => {
        // v5.54: сбой сети не затирает закэшированный список — раньше профиль
        // после сбоя навсегда показывал «Вы пока не подписаны»
      })
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

  // Кнопки «Тарифы» из кабинета («Мой канал») ведут в шит тарифов здесь:
  // флаг кладётся в sessionStorage ДО переключения вкладки (проверяем на
  // монтировании), событие ловим, если вкладка уже смонтирована.
  useEffect(() => {
    let t: number | undefined
    try {
      if (sessionStorage.getItem('tgfeed_open_tiers') === '1') {
        sessionStorage.removeItem('tgfeed_open_tiers')
        // Через таймаут: state-колбэки нельзя звать синхронно в теле эффекта
        // (react-hooks/set-state-in-effect) — открытие срабатывает сразу после коммита
        t = window.setTimeout(() => setTiersOpen(true), 0)
      }
    } catch {
      /* приватный режим */
    }
    const onOpenTiers = () => setTiersOpen(true)
    window.addEventListener('tgfeed:open-tiers', onOpenTiers)
    return () => {
      if (t !== undefined) window.clearTimeout(t)
      window.removeEventListener('tgfeed:open-tiers', onOpenTiers)
    }
  }, [])

  if (!user) return null

  const name = user.isGuest
    ? t('profile.reader')
    : [user.firstName, user.lastName].filter(Boolean).join(' ') || t('profile.name')
  const stats = profile?.stats
  // Тир для UI: если шит тарифов уже грузил свежие данные (GET /api/tiers) —
  // приоритет им, иначе берём тир из стора (UserDTO.tier)
  const headerTier = tiersData?.tier ?? user.tier ?? 'free'
  // v5.77: «В Tg Swipe с …» убрано — memberSinceLabel больше не нужен

  const categoryTitle = (slug: string) => categories.find((c) => c.slug === slug)?.title ?? slug

  return (
    <div className="no-scrollbar h-full w-full overflow-y-auto overscroll-contain pb-28">
      {/* Центрированная колонка: на широких мониторах секции профиля не должны
          растягиваться на весь экран (жалоба «слишком растянуто») */}
      <div className="mx-auto w-full max-w-[880px]">
      {/* Шапка-обложка (v5.27): палитра/узор/рамка из каталога оформления,
          ава по центру торчит наполовину из обложки — имя и статус идут ниже.
          Внешний заголовок «Профиль» убран: обложка сама говорит за себя. */}
      <section aria-label="Профиль">
        <ProfileHeaderCover
          paletteId={user.style?.palette}
          bgId={user.style?.bg}
          frameId={user.style?.frame}
          avatarName={name}
          avatarSrc={userAvatarUrl(user.id, user.photoUrl)}
          avatarSize={88}
          tier={user.tier}
          isPremium={user.isPremium}
          className="h-28 sm:h-32"
        >
          {/* Настройки интерфейса — слева-сверху */}
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label="Настройки интерфейса"
            className="absolute left-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-black/25 text-white backdrop-blur transition active:scale-90"
          >
            <Settings className="h-4.5 w-4.5" />
          </button>
          {/* Оформление профиля (кастомайзер) — справа-сверху */}
          <button
            type="button"
            onClick={() => {
              haptic('light')
              setCustomizerOpen(true)
            }}
            aria-label="Оформление профиля"
            className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-black/25 text-white backdrop-blur transition active:scale-90"
          >
            <Pencil className="h-4.5 w-4.5" />
          </button>
        </ProfileHeaderCover>

        {/* Ава выступает из обложки на size/2 (44px) → отступ под неё, всё по центру */}
        <div className="flex flex-col items-center px-4 pt-[54px] text-center">
          <div className="flex max-w-full items-center justify-center gap-1.5">
            <h1 className="truncate text-[20px] font-bold leading-tight text-tg-text">{name}</h1>
            <ProfileTierChips tier={headerTier} isPremium={user.isPremium} />
          </div>
          {/* v5.19: бейджи статуса (разработчик/менеджер/спонсор…) — по центру */}
          {user.badges && user.badges.length > 0 && (
            <div className="mt-1.5 flex justify-center">
              <UserBadges badges={user.badges} max={5} />
            </div>
          )}
          <div className="mt-0.5 truncate text-[15px] text-tg-hint">
            {user.username ? `@${user.username}` : user.isGuest ? t('profile.subGuestHint') : t('profile.noUsername')}
          </div>
          {/* v5.75: XP-бар уровня под ником (гостю рано — уровни после входа) */}
          {!user.isGuest && (
            <LevelBar
              xp={user.xp ?? 0}
              level={user.level ?? 1}
              className="mt-1.5"
              onClick={() => {
                haptic('light')
                setLevelOpen(true)
              }}
            />
          )}
          {/* v5.77: строка «В Tg Swipe с …» убрана — приказ «меньше текста везде» */}
          {!user.isGuest && (
            <div className="mt-1 flex items-center gap-1 text-[12px] font-medium text-tg-link">
              <ShieldCheck className="h-3.5 w-3.5" />
              Telegram подтверждён
            </div>
          )}
          {user.isGuest && (
            <button
              type="button"
              onClick={() => {
                haptic('light')
                setLoginOpen(true)
              }}
              className="press mt-2 flex h-9 items-center gap-1.5 rounded-full bg-tg-link px-3.5 text-[13px] font-bold text-white"
            >
              <Send className="h-3.5 w-3.5" />
              Вход по Telegram
            </button>
          )}
        </div>
      </section>

      {/* Статистика */}
      <section className="mt-5 flex items-stretch px-4" aria-label="Статистика">
        <StatBlock
          value={stats?.subscriptions}
          label="Подписки"
          onClick={() => {
            setTab('channel')
          }}
        />
        <div className="w-px shrink-0 bg-tg-sep" aria-hidden />
        <StatBlock value={user.categories.length} label="Категории" />
        <div className="w-px shrink-0 bg-tg-sep" aria-hidden />
        <StatBlock value={stats?.bookmarks} label="Сохранено" />
      </section>

      {/* Кошелёк v2 (v5.77): кнопка вместо плашки — полная страница открывается по тапу.
          v5.79.1: обёртка px-4 + w-full — <button> не растягивается на ширину контейнера
          сам (ширина «по контенту»), из-за этого кнопка висела узкой колбаской слева
          и не совпадала краями со статистикой/секциями. Теперь края ровно по px-4. */}
      {!user.isGuest && (
        <div className="mt-3 px-4">
          <button
            type="button"
            onClick={() => {
              haptic('light')
              setWalletOpen(true)
            }}
            className="flex w-full items-center gap-3 rounded-2xl border border-tg-sep/60 bg-tg-surface px-4 py-3.5 text-left transition active:scale-[0.99]"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-tg-link/15 text-tg-link">
              <Wallet className="h-5 w-5" strokeWidth={1.9} aria-hidden />
            </span>
            <span className="min-w-0 flex-1 text-[16px] font-semibold text-tg-text">Кошелёк</span>
            <ChevronRight className="h-5 w-5 shrink-0 text-tg-hint" aria-hidden />
          </button>
        </div>
      )}

      {/* v5.46: активный розыгрыш — билеты/задания/промокод (скрыт, если розыгрыша нет) */}
      <GiveawayCard />

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




      {/* Обратная связь — одна кнопка вместо двух, разделы внутри шита.
          v5.58: «Мой канал» и Snap Ассистент переехали во вкладку «Канал»
          (нижняя навигация) — профиль разгружен. */}
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
      {/* v5.69: полноэкранная страница (была полувысотная шторка — низ
          «шрифт/язык» на мобиле недолистывался). Скролл у самого контента. */}
      <BottomSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title={t('profile.settings')}
        subtitle={t('settings.subtitle')}
        variant="full"
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
            <span className="block text-[13px] font-medium text-tg-hint">{t('settings.theme')}</span>
            <span className="mt-0.5 flex items-center justify-between">
              <span className="text-[16px] font-semibold text-tg-text">{themeName(theme)}</span>
              <span className="text-[14px] font-medium text-tg-link">{t('settings.allThemes')} ({THEMES.length})</span>
            </span>
          </button>
          {/* v5.68: тариф и информация переехали сюда из профиля (дубли убраны) */}
          <button
            type="button"
            onClick={() => {
              setSettingsOpen(false)
              setTiersOpen(true)
            }}
            className="flex w-full items-center gap-3 rounded-2xl bg-tg-surface p-3.5 text-left active:opacity-80"
          >
            <Sparkles className="h-[20px] w-[20px] shrink-0 text-tg-star" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-tg-hint">{t('settings.tier')}</span>
              <span className="mt-0.5 block text-[16px] font-semibold text-tg-text">
                {TIER_NAMES[headerTier] ?? headerTier}
              </span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-tg-hint" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => {
              setSettingsOpen(false)
              setInfoMenuOpen(true)
            }}
            className="flex w-full items-center gap-3 rounded-2xl bg-tg-surface p-3.5 text-left active:opacity-80"
          >
            <Info className="h-[20px] w-[20px] shrink-0 text-tg-hint" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-tg-hint">{t('profile.infoRow')}</span>
              <span className="mt-0.5 block truncate text-[16px] font-semibold text-tg-text">{t('settings.legal')}</span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-tg-hint" aria-hidden />
          </button>
          <Segmented
            label={t('settings.font')}
            value={fontScale}
            onChange={(v) => setFontScale(v as typeof fontScale)}
            options={[
              { value: 'sm', label: 'A', aria: t('settings.fontSm') },
              { value: 'md', label: 'A', big: true, aria: t('settings.fontMd') },
              { value: 'lg', label: 'A', big: true, aria: t('settings.fontLg') },
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
          <Row label="Подписка" value="в один тап" />
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
          {/* v5.43: полная политика — постоянная ссылка на сайте */}
          <a
            href="/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="block rounded-2xl bg-tg-surface/70 p-3.5 text-[14px] font-semibold text-tg-link active:opacity-60"
          >
            Полная политика конфиденциальности — открыть на сайте ↗
          </a>
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
              <li>• Free — бесплатно: лента, свайпы, 3 запроса Snap Search в день;</li>
              <li>• Snap Plus — 390 ₽/мес или 2 990 ₽/год: безлимитный Snap Search,
              инкогнито, приоритетная скорость, премиум-эмодзи;</li>
              <li>• Snap Pro — 1 490 ₽/мес или 9 990 ₽/год: всё из Plus,
              ИИ-контентщик, продвижение до 7 постов в неделю, CTA-кнопка;</li>
            </ul>
          </section>
          <section className="rounded-2xl bg-tg-surface/70 p-3.5">
            <h3 className="text-[14.5px] font-bold text-tg-text">Валюты сервиса — рубли и свайпы</h3>
            <p className="mt-1.5 text-tg-hint">
              На балансе две валюты: <b className="text-tg-text">рубли</b> и{' '}
              <b className="text-tg-text">свайпы</b>. Курс всегда один:{' '}
              <b className="text-tg-text">500 свайпов = 1 рубль</b> (1 свайп = 0,2 копейки).
              Свайпы — валюта нейросетей: списываются за запросы к ИИ по токенам
              (как в OpenRouter — за реальные входные и выходные токены).
              Рублёвый баланс покупает всё в сервисе: свайпы, тарифы Snap,
              рекламные кампании — без оплаты картой на месте.
            </p>
          </section>
          <section className="rounded-2xl bg-tg-surface/70 p-3.5">
            <h3 className="text-[14.5px] font-bold text-tg-text">Пополнение и оплата</h3>
            <p className="mt-1.5 text-tg-hint">
              Баланс пополняется в рублях (банковская карта или СБП), Telegram Stars или криптовалютой
              TON — от 100 рублей за операцию. Курс TON фиксируется в момент выставления счёта.
              Деньги зачисляются на рублёвый баланс автоматически после подтверждения оплаты.
              Оплата картой
              проходит через платёжную форму ЮKassa, открываемую непосредственно на сайте — без
              переадресации на сторонние ресурсы. Подписка Snap действует до конца оплаченного
              периода; возврат средств за неиспользованный период — в порядке, предусмотренном
              законодательством РФ.
            </p>
          </section>
          <section className="rounded-2xl bg-tg-surface/70 p-3.5">
            <h3 className="text-[14.5px] font-bold text-tg-text">Списание и возврат</h3>
            <p className="mt-1.5 text-tg-hint">
              Свайпы списываются за запросы к нейросетям — по фактическим токенам OpenRouter
              (тяжёлые запросы стоят дороже, лёгкие дешевле). Рекламные кампании списывают
              рубли с баланса за уникальных читателей. Не израсходованный баланс остаётся
              на счёте. Рубли и свайпы — внутренняя валюта сервиса и не подлежат выводу
              в деньги, кроме случаев, предусмотренных законом.
            </p>
          </section>
          <section className="rounded-2xl bg-tg-surface/70 p-3.5">
            <h3 className="text-[14.5px] font-bold text-tg-text">Контент</h3>
            <p className="mt-1.5 text-tg-hint">
              Лента собирает публичные посты открытых Telegram-каналов. Права на контент остаются
              у авторов каналов. Скрыть свой канал из ленты можно по обращению в поддержку.
            </p>
          </section>
          {/* v5.43: полная редакция документа — постоянная ссылка на сайте */}
          <a
            href="/terms"
            target="_blank"
            rel="noopener noreferrer"
            className="block rounded-2xl bg-tg-surface/70 p-3.5 text-[14px] font-semibold text-tg-link active:opacity-60"
          >
            Полная редакция соглашения — открыть на сайте ↗
          </a>
        </div>
      </BottomSheet>

      {/* Реквизиты и контакты (требования СБ ЮKassa) */}
      <RequisitesSheet open={requisitesOpen} onClose={() => setRequisitesOpen(false)} />

      {/* Кошелёк v2 (v5.77): полная страница (баланс, счета с адресами, переводы, рефералка, история) */}
      <WalletPage open={walletOpen} onClose={() => setWalletOpen(false)} />

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

      {/* Тарифы Snap: статус тира, лимит Snap Search, покупка Plus/Pro через Stars.
          Из кастомайзера (z-90) шит открывается поверх — z-95, иначе слой под страницей */}
      <TiersSheet
        open={tiersOpen}
        zClass={customizerOpen ? 'z-[95]' : undefined}
        onClose={() => setTiersOpen(false)}
        onLoaded={setTiersData}
        onWalletChanged={() => {
          // v5.77: тихий рефетч баланса в store (покупка тира списала свайпы/₽)
          api<{ balanceKop: number; swipes: number }>('/api/wallet')
            .then((r) => useApp.getState().patchBalance({ balanceKop: r.balanceKop, swipes: r.swipes }))
            .catch(() => {})
        }}
      />

      {/* Оформление профиля: полная страница с вкладками Палитры/Фон/Рамка + кастомные цвета.
          Монтируется только при открытии — локальный стиль инициализируется свежими данными */}
      {customizerOpen && <ProfileCustomizer open onClose={() => setCustomizerOpen(false)} />}

      {/* Вход по Telegram (сайт + гости) */}
      <LoginByTelegram open={loginOpen} onClose={() => setLoginOpen(false)} />

      {/* v5.75: шит уровня — прогресс, правила XP, история начислений */}
      <LevelSheet
        open={levelOpen}
        onClose={() => setLevelOpen(false)}
        isGuest={!!user.isGuest}
        onLogin={() => setLoginOpen(true)}
      />

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
      'Безлимитный Snap Search',
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
      '1 бесплатное продвижение в месяц + пакеты (5 за 199 ₽)',
      'Бейдж Premium-автора',
      'Кастомная CTA-кнопка в постах',
    ],
  },
]

/** Копейки → «2 990 ₽» (цены из /api/tiers приходят в копейках) */
const kopToRub = (kop: number): string => `${(kop / 100).toLocaleString('ru-RU')} ₽`

/**
 * Шит «Тариф Snap»: карточка текущего тира (с лимитом Snap Search для free),
 * карточки Plus/Pro с выбором периода (месяц/год) и покупкой через
 * Telegram Stars — POST /api/tiers отдаёт invoiceUrl, открываем нативный
 * инвойс через openInvoiceUrl; по оплате ('paid') подтягиваем свежий тир.
 */
function TiersSheet({
  open,
  onClose,
  onLoaded,
  zClass,
  onWalletChanged,
}: {
  open: boolean
  onClose: () => void
  onLoaded: (d: TiersResponse) => void
  /** z-класс контейнера (нужен z-[95] при открытии поверх кастомайзера z-90) */
  zClass?: string
  /** Покупка с баланса списала рубли — кошелёк в профиле надо перечитать */
  onWalletChanged?: () => void
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

  /** ОПЛАТА С БАЛАНСА (v5.39): рублей хватает → тир активируется мгновенно,
   * без карты и Stars — «за баланс покупается всё в сервисе» */
  const buyBalance = async (plan: 'plus' | 'pro') => {
    if (buying) return
    setBuying(plan)
    haptic('light')
    try {
      const r = await api<{ ok: boolean; tier: string; tierUntil: string }>('/api/tiers', {
        method: 'POST',
        body: JSON.stringify({ plan, period: period[plan], method: 'balance' }),
      })
      haptic('success')
      toast.success(
        `Тариф активирован с баланса — до ${new Date(r.tierUntil).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}`,
      )
      refresh()
      onWalletChanged?.()
    } catch (e) {
      toast.error((e as Error).message || 'Не удалось оплатить с баланса')
    } finally {
      setBuying(null)
    }
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      zClass={zClass}
      title="Тариф Snap"
      subtitle="Snap Search, инкогнито и инструменты для канала"
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
            className="press mt-3 h-11 w-full rounded-xl bg-tg-link text-[15px] font-semibold text-white"
          >
            Повторить
          </button>
        </div>
      )}

      {!loading && !failed && data && (
        <>
          {/* Текущий статус */}
          <div className="card-soft rounded-2xl bg-tg-surface p-4">
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
                Использовано запросов Snap Search сегодня: {data.aiSearch.used} из {data.aiSearch.limit}
              </p>
            ) : null}
          </div>

          {/* Карточки Plus / Pro */}
          <div className="mt-3 space-y-3">
            {PLAN_META.map((meta) => {
              const price = data.prices[meta.plan]
              const p = period[meta.plan]
              return (
                <div key={meta.plan} className="card-soft rounded-2xl bg-tg-surface p-4">
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
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-tg-green" strokeWidth={2.5} />
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
                    className="press mt-2.5 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-tg-link text-[15px] font-semibold text-white disabled:bg-tg-sep/60 disabled:text-tg-hint"
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
                  {/* С БАЛАНСА (v5.39): показываем, когда рублей на кошельке хватает */}
                  {(data.wallet?.balanceKop ?? 0) >=
                    (p === 'month' ? price.monthKop : price.yearKop) && (
                    <button
                      type="button"
                      disabled={buying !== null}
                      onClick={() => buyBalance(meta.plan)}
                      className="press mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-tg-green text-[15px] font-semibold text-white disabled:opacity-50"
                    >
                      {buying === meta.plan ? (
                        <Loader2 className="h-4.5 w-4.5 animate-spin" />
                      ) : (
                        <Wallet className="h-4.5 w-4.5" strokeWidth={1.8} />
                      )}
                      С баланса · активируется сразу
                    </button>
                  )}
                  {/* Карта: виджет ЮKassa на сайте — показываем, когда эквайринг подключён (methods.card) */}
                  {data.methods.card && (
                    <button
                      type="button"
                      disabled={buying !== null}
                      onClick={() => buyCard(meta.plan)}
                      className="press mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-tg-sep bg-tg-bg text-[15px] font-semibold text-tg-text disabled:opacity-50"
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
            Оплата: с баланса кошелька (мгновенно), Telegram Stars или банковская карта
            (ЮKassa, форма открывается на сайте). Подписка действует до конца оплаченного периода.
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

  // v5.43 (требование Platega): персональные данные (ИП/ИНН) НЕ показываем —
  // вместо них полные документы по постоянным ссылкам на сайте
  const rows: Array<{ label: string; value: string }> = [
    { label: 'Сервис', value: legal?.name || 'Tg Swipe — умная лента Telegram-каналов' },
    { label: 'Поддержка', value: legal?.email || 'чат в приложении: Профиль → Обратная связь' },
  ]
  const docs: Array<[string, string]> = [
    ['/terms', 'Пользовательское соглашение'],
    ['/privacy', 'Политика конфиденциальности'],
    ['/pricing', 'Тарифы и цены'],
    ['/contacts', 'Поддержка и контакты'],
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
            Банковская карта (форма открывается прямо на сайте, без переадресаций), СБП,
            Telegram Stars, TON.
          </p>
        </div>
        <div className="rounded-2xl bg-tg-surface/70 p-3.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-tg-hint">Документы</p>
          <div className="mt-1.5 flex flex-col gap-1">
            {docs.map(([href, label]) => (
              <a
                key={href}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[14px] font-medium text-tg-link active:opacity-60"
              >
                {label} ↗
              </a>
            ))}
          </div>
        </div>
        <p className="px-1 text-[12px] leading-snug text-tg-hint">
          Полные условия оказания услуг и тарифы — в «Пользовательском соглашении» на сайте.
        </p>
      </div>
    </BottomSheet>
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
  options: { value: string; label: string; big?: boolean; aria?: string }[]
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
            aria-label={o.aria ?? o.label}
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
