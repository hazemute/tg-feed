'use client'

import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Bot,
  Gem,
  Gift,
  BadgeCheck,
  Command,
  Headset,
  History,
  LayoutDashboard,
  Lightbulb,
  ListChecks,
  LogOut,
  Megaphone,
  Menu,
  Moon,
  Palette,
  RefreshCw,
  Send,
  Server,
  ShieldAlert,
  Star,
  Sun,
  Ticket,
  Timer,
  Tv,
  Users,
  Wallet,
  Wrench,
  X,
  Check,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command'
import { cn } from '@/lib/utils'

import {
  clearAdminKey,
  getAdminKey,
  panelFetch,
  PanelError,
  UNAUTH_EVENT,
  type OverviewCounts,
  type PanelHealth,
  type SupportThreadItem,
} from './components/api'
import { btnOutlineDark } from './components/bits'
import { LoginScreen } from './components/login-screen'
import { OverviewTab } from './components/overview-tab'

/*
 * v5.86 — ЛЕНИВЫЕ ВКЛАДКИ АДМИНКИ: раньше ВСЕ 17 вкладок (10 000+ строк
 * компонентов) собирались в ОДИН чанк — открытие /admin качало мегабайты
 * JS, из которых 15 вкладок не нужны до первого тапа. Теперь статично
 * только «Обзор» (лендинг вкладка) и логин; остальные — next/dynamic с
 * скелетоном: чанк вкладки качается при первом выборе, повторные переключения
 * мгновенны (чанк в кэше браузера).
 */
import dynamic from 'next/dynamic'

function TabFallback() {
  return (
    <div className="space-y-3" role="status" aria-label="Загрузка раздела">
      <div className="h-8 w-56 animate-pulse rounded-lg bg-slate-200" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl bg-slate-200" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-xl bg-slate-200" />
    </div>
  )
}

/* Опции next/dynamic обязаны быть инлайн-литералом (требование Next) */
const FinanceTab = dynamic(() => import('./components/finance-tab').then((m) => m.FinanceTab), { ssr: false, loading: () => <TabFallback /> })
const SubscriptionsTab = dynamic(() => import('./components/subscriptions-tab').then((m) => m.SubscriptionsTab), { ssr: false, loading: () => <TabFallback /> })
const BadgesTab = dynamic(() => import('./components/badges-tab').then((m) => m.BadgesTab), { ssr: false, loading: () => <TabFallback /> })
const ChannelsTab = dynamic(() => import('./components/channels-tab').then((m) => m.ChannelsTab), { ssr: false, loading: () => <TabFallback /> })
const ModerationTab = dynamic(() => import('./components/moderation-tab').then((m) => m.ModerationTab), { ssr: false, loading: () => <TabFallback /> })
const UsersTab = dynamic(() => import('./components/users-tab').then((m) => m.UsersTab), { ssr: false, loading: () => <TabFallback /> })
const AuditTab = dynamic(() => import('./components/audit-tab').then((m) => m.AuditTab), { ssr: false, loading: () => <TabFallback /> })
const SupportTab = dynamic(() => import('./components/support-tab').then((m) => m.SupportTab), { ssr: false, loading: () => <TabFallback /> })
const AdsTab = dynamic(() => import('./components/ads-tab').then((m) => m.AdsTab), { ssr: false, loading: () => <TabFallback /> })
const GiveawaysTab = dynamic(() => import('./components/giveaways-tab').then((m) => m.GiveawaysTab), { ssr: false, loading: () => <TabFallback /> })
const QuestsTab = dynamic(() => import('./components/quests-tab').then((m) => m.QuestsTab), { ssr: false, loading: () => <TabFallback /> })
const PromosTab = dynamic(() => import('./components/promos-tab').then((m) => m.PromosTab), { ssr: false, loading: () => <TabFallback /> })
const SystemTab = dynamic(() => import('./components/system-tab').then((m) => m.SystemTab), { ssr: false, loading: () => <TabFallback /> })
const ToolsTab = dynamic(() => import('./components/tools-tab').then((m) => m.ToolsTab), { ssr: false, loading: () => <TabFallback /> })
const BotTab = dynamic(() => import('./components/bot-tab').then((m) => m.BotTab), { ssr: false, loading: () => <TabFallback /> })
const BroadcastTab = dynamic(() => import('./components/broadcast-tab').then((m) => m.BroadcastTab), { ssr: false, loading: () => <TabFallback /> })

type AuthState = 'checking' | 'authed' | 'anon'

/* v5.89: единый источник ключей вкладок — и тип, и валидация закреплений */
const NAV_KEYS = [
  'overview',
  'bot',
  'finance',
  'subscriptions',
  'badges',
  'channels',
  'moderation',
  'users',
  'audit',
  'support',
  'feedback',
  'ads',
  'giveaways',
  'quests',
  'promos',
  'broadcast',
  'system',
  'tools',
] as const
type TabKey = (typeof NAV_KEYS)[number]
const NAV_KEY_SET = new Set<string>(NAV_KEYS)

/*
 * Темы админки (палитры как в миниаппе, приказ владельца v5.11):
 * '' — светлая; dark (Telegram), sepia, rose — раскрашиваются в layout.tsx.
 */
type AdminTheme = '' | 'dark' | 'sepia' | 'rose'
const THEME_KEY = 'tgfeed_admin_theme'
const THEME_CYCLE: AdminTheme[] = ['', 'dark', 'sepia', 'rose']
/* v5.89: закреплённые вкладки + автообновление — в localStorage */
const PIN_KEY = 'tgfeed_admin_pins'
const AUTO_REFRESH_KEY = 'tgfeed_admin_autoref'
const THEME_LABEL: Record<AdminTheme, string> = {
  '': 'Светлая',
  dark: 'Тёмная',
  sepia: 'Сепия',
  rose: 'Роза',
}

/* Элемент навигации (данные — те же, что раньше; группировка — ниже) */
type NavItem = {
  key: TabKey
  label: string
  icon: typeof LayoutDashboard
  badge?: number | string | null
  badgeTone?: 'accent' | 'amber'
}

/*
 * Группы сайдбара (v5.62): секции с крошечными uppercase-заголовками.
 * Порядок вкладок внутри групп фиксирован, ключи — все 16 вкладок панели.
 */
const NAV_GROUPS: Array<{ title?: string; keys: TabKey[] }> = [
  { keys: ['overview'] },
  { title: 'Деньги', keys: ['finance', 'subscriptions', 'ads'] },
  { title: 'Контент', keys: ['channels', 'moderation', 'feedback'] },
  { title: 'Люди', keys: ['users', 'badges', 'support'] },
  { title: 'Рост', keys: ['giveaways', 'quests', 'promos', 'broadcast'] },
  { title: 'Система', keys: ['audit', 'system', 'tools', 'bot'] },
]

export default function AdminPage() {
  const [auth, setAuth] = useState<AuthState>('checking')
  const [health, setHealth] = useState<PanelHealth | null>(null)
  const [healthOk, setHealthOk] = useState<boolean | null>(null)
  const [healthLoading, setHealthLoading] = useState(false)
  const [tick, setTick] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [modCount, setModCount] = useState<number | null>(null)
  const [apiVersion, setApiVersion] = useState('')
  const [maintOn, setMaintOn] = useState(false)
  const [supportUnread, setSupportUnread] = useState(0)
  const [feedbackUnread, setFeedbackUnread] = useState(0)
  const [active, setActive] = useState<TabKey>('overview')
  const [navOpen, setNavOpen] = useState(false)
  // Тема: localStorage; undefined до монтирования — чтобы не мигнуло
  const [theme, setTheme] = useState<AdminTheme>('')
  // v5.89: палитра команд (⌘K/Ctrl+K), закреплённые вкладки, автообновление,
  // «обновлено Nс назад» в шапке
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [pinned, setPinned] = useState<TabKey[]>([])
  const [autoRef, setAutoRef] = useState(false)
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null)
  const [nowMs, setNowMs] = useState(0)

  useEffect(() => {
    const saved = (window.localStorage.getItem(THEME_KEY) ?? '') as AdminTheme
    setTheme(THEME_CYCLE.includes(saved) ? saved : '')
    // v5.89: восстанавливаем закрепления и автообновление
    try {
      const raw = window.localStorage.getItem(PIN_KEY)
      if (raw) {
        const arr: unknown = JSON.parse(raw)
        if (Array.isArray(arr)) setPinned(arr.filter((k): k is TabKey => NAV_KEY_SET.has(String(k))))
      }
      setAutoRef(window.localStorage.getItem(AUTO_REFRESH_KEY) === '1')
    } catch {
      /* приватный режим — без закреплений */
    }
  }, [])

  // v5.89: ⌘K / Ctrl+K — командная палитра (только для авторизованных)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (auth === 'authed') setPaletteOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [auth])

  // v5.89: тикер «обновлено Nс назад» — 1с, только на авторизованной панели
  useEffect(() => {
    if (auth !== 'authed') return
    setNowMs(Date.now())
    const iv = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [auth])

  // Атрибут на <html>: перекрашивает и фон layout'а (вне корневого div страницы)
  useEffect(() => {
    if (theme === '') document.documentElement.removeAttribute('data-adm')
    else document.documentElement.setAttribute('data-adm', theme)
    return () => document.documentElement.removeAttribute('data-adm')
  }, [theme])

  // Мобильный дровер: Esc закрывает, скролл body заблокирован, пока открыт
  useEffect(() => {
    if (!navOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpen(false)
    }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [navOpen])

  const applyTheme = useCallback((t: AdminTheme) => {
    setTheme(t)
    try {
      window.localStorage.setItem(THEME_KEY, t)
    } catch {
      /* приватный режим */
    }
  }, [])

  const cycleTheme = useCallback(() => {
    applyTheme(THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length])
  }, [theme, applyTheme])

  /* v5.89: закрепление вкладок (звёздочка в сайдбаре / палитра) */
  const togglePin = useCallback((key: TabKey) => {
    setPinned((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
      try {
        window.localStorage.setItem(PIN_KEY, JSON.stringify(next))
      } catch {
        /* приватный режим */
      }
      return next
    })
  }, [])

  /* v5.89: автообновление данных раз в минуту */
  const toggleAutoRef = useCallback(() => {
    setAutoRef((v) => {
      const next = !v
      try {
        window.localStorage.setItem(AUTO_REFRESH_KEY, next ? '1' : '0')
      } catch {
        /* приватный режим */
      }
      return next
    })
  }, [])

  const handleMaintenance = useCallback((on: boolean) => setMaintOn(on), [])

  // Непрочитанные обращения поддержки и предложок — бейджи на вкладках (раз в 30с)
  useEffect(() => {
    if (auth !== 'authed') return
    let alive = true
    const load = async () => {
      try {
        const items = await panelFetch<{ items: SupportThreadItem[] }>('/api/panel/support?unseen=1')
        if (!alive) return
        let sup = 0
        let fb = 0
        for (const t of items.items) {
          if (t.kind === 'feedback') fb += t.unreadAdmin
          else sup += t.unreadAdmin
        }
        setSupportUnread(sup)
        setFeedbackUnread(fb)
      } catch {
        /* панель переживает недоступность API */
      }
    }
    void load()
    const timer = setInterval(load, 30_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [auth, tick])

  const loadHealth = useCallback(async () => {
    setHealthLoading(true)
    try {
      // v5.89: таймаут 30с — зависший запрос не должен блокировать кнопку «Обновить»
      const h = await panelFetch<PanelHealth>('/api/panel/health', { timeoutMs: 30_000 })
      setHealth(h)
      setHealthOk(h.ok === true)
      if (h.version) setApiVersion(h.version)
    } catch (e) {
      if (e instanceof PanelError && e.status === 401) return // страница уже ушла на логин
      setHealth(null)
      setHealthOk(false)
    } finally {
      setHealthLoading(false)
      setRefreshing(false)
      setLastRefreshAt(Date.now())
    }
  }, [])

  // Первичная проверка: есть ключ — пробуем health, нет — экран логина.
  useEffect(() => {
    let alive = true
    const run = async () => {
      const hasKey = getAdminKey() !== null
      await Promise.resolve()
      if (!alive) return
      if (!hasKey) {
        setAuth('anon')
        return
      }
      try {
        // v5.89: таймаут 12с — зависший health не оставляет вечное «Проверка доступа…»
        const h = await panelFetch<PanelHealth>('/api/panel/health', { timeoutMs: 12_000 })
        if (!alive) return
        setHealth(h)
        setHealthOk(h.ok === true)
        if (h.version) setApiVersion(h.version)
        setAuth('authed')
      } catch {
        if (!alive) return
        setAuth('anon')
      }
    }
    void run()
    return () => {
      alive = false
    }
  }, [])

  // 401 от любого запроса -> экран логина.
  useEffect(() => {
    const on401 = () => {
      setAuth('anon')
      setHealth(null)
      setHealthOk(null)
      setModCount(null)
    }
    window.addEventListener(UNAUTH_EVENT, on401)
    return () => window.removeEventListener(UNAUTH_EVENT, on401)
  }, [])

  const refresh = useCallback(() => {
    setRefreshing(true)
    setTick((t) => t + 1)
    void loadHealth()
  }, [loadHealth])

  // v5.89: автообновление раз в 60с (переключается в шапке/палитре)
  useEffect(() => {
    if (auth !== 'authed' || !autoRef) return
    const iv = setInterval(() => {
      refresh()
    }, 60_000)
    return () => clearInterval(iv)
  }, [auth, autoRef, refresh])

  const handleSettled = useCallback(() => setRefreshing(false), [])

  const handleCounts = useCallback((c: OverviewCounts) => {
    setModCount(c.channelsModeration)
  }, [])

  const handleModerationCount = useCallback((n: number) => setModCount(n), [])

  const logout = useCallback(() => {
    clearAdminKey()
    setAuth('anon')
    setHealth(null)
    setHealthOk(null)
    setModCount(null)
    setNavOpen(false)
    toast.success('Выход выполнен — ключ удалён из сессии')
  }, [])

  const handleLoginSuccess = useCallback(
    (version: string) => {
      if (version) setApiVersion(version)
      setAuth('authed')
      void loadHealth()
    },
    [loadHealth],
  )

  const selectTab = useCallback((key: TabKey) => {
    setActive(key)
    // Дровер закрывается при выборе вкладки (на десктопе он и так закрыт)
    setNavOpen(false)
  }, [])

  if (auth === 'checking') {
    return (
      <div
        data-adm-theme={theme || 'light'}
        className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-50"
        role="status"
        aria-label="Проверка доступа"
      >
        <img src="/logo.svg" alt="" className="h-10 w-10" aria-hidden />
        <div
          className="size-6 animate-spin rounded-full border-2 border-slate-200 border-t-emerald-500"
          aria-hidden
        />
        <p className="text-xs text-slate-500">Проверка доступа…</p>
      </div>
    )
  }

  if (auth === 'anon') {
    return (
      <div data-adm-theme={theme || 'light'} className="min-h-screen bg-slate-50">
        <LoginScreen onSuccess={handleLoginSuccess} />
      </div>
    )
  }

  const pill =
    healthOk === null
      ? { dot: 'bg-slate-500', text: 'text-slate-500', label: 'API…', ring: 'border-slate-200 bg-slate-100' }
      : healthOk
        ? {
            dot: 'bg-emerald-400',
            text: 'text-emerald-700',
            label: 'API OK',
            ring: 'border-emerald-500/30 bg-emerald-50',
          }
        : {
            dot: 'bg-red-400',
            text: 'text-red-700',
            label: 'API недоступен',
            ring: 'border-red-500/30 bg-red-50',
          }

  const NAV: NavItem[] = [
    { key: 'overview', label: 'Обзор', icon: LayoutDashboard },
    { key: 'finance', label: 'Финансы', icon: Wallet },
    { key: 'subscriptions', label: 'Подписки', icon: Gem },
    { key: 'badges', label: 'Бейджи', icon: BadgeCheck },
    { key: 'channels', label: 'Каналы', icon: Tv },
    {
      key: 'moderation',
      label: 'Модерация',
      icon: ShieldAlert,
      badge: modCount !== null && modCount > 0 ? modCount : null,
      badgeTone: 'amber',
    },
    { key: 'users', label: 'Пользователи', icon: Users },
    { key: 'audit', label: 'Журнал', icon: History },
    {
      key: 'support',
      label: 'Поддержка',
      icon: Headset,
      badge: supportUnread > 0 ? supportUnread : null,
      badgeTone: 'accent',
    },
    {
      key: 'feedback',
      label: 'Предложки',
      icon: Lightbulb,
      badge: feedbackUnread > 0 ? feedbackUnread : null,
      badgeTone: 'amber',
    },
    { key: 'ads', label: 'Реклама', icon: Megaphone },
    { key: 'giveaways', label: 'Розыгрыши', icon: Gift },
    { key: 'quests', label: 'Задания', icon: ListChecks },
    { key: 'promos', label: 'Промокоды', icon: Ticket },
    { key: 'broadcast', label: 'Рассылка', icon: Send },
    {
      key: 'system',
      label: 'Система',
      icon: Server,
      badge: maintOn ? 'техработы' : null,
      badgeTone: 'amber',
    },
    { key: 'tools', label: 'Инструменты', icon: Wrench },
    { key: 'bot', label: 'Бот', icon: Bot },
  ]

  const navByKey = new Map<TabKey, NavItem>(NAV.map((item) => [item.key, item]))
  const activeLabel = NAV.find((item) => item.key === active)?.label ?? ''

  /* v5.89: «обновлено Nс назад» для шапки */
  const agoSec =
    lastRefreshAt && nowMs ? Math.max(0, Math.round((nowMs - lastRefreshAt) / 1000)) : null
  const agoLabel =
    agoSec === null
      ? ''
      : agoSec < 5
        ? 'только что'
        : agoSec < 60
          ? `${agoSec}с назад`
          : `${Math.floor(agoSec / 60)}м ${agoSec % 60}с назад`

  /* v5.89: закреплённые вкладки — отдельной секцией сверху, из исходных групп убраны */
  const pinnedSet = new Set<TabKey>(pinned)
  const pinnedValid = pinned.filter((k) => navByKey.has(k))
  const navGroups: Array<{ title?: string; keys: TabKey[] }> = []
  if (pinnedValid.length) navGroups.push({ title: 'Закреплённые', keys: pinnedValid })
  for (const g of NAV_GROUPS) {
    const keys = g.keys.filter((k) => !pinnedSet.has(k))
    if (keys.length) navGroups.push({ title: g.title, keys })
  }

  const renderTab = () => {
    switch (active) {
      case 'overview':
        return <OverviewTab tick={tick} onSettled={handleSettled} onCounts={handleCounts} />
      case 'finance':
        return <FinanceTab tick={tick} onSettled={handleSettled} />
      case 'subscriptions':
        return <SubscriptionsTab tick={tick} onSettled={handleSettled} />
      case 'badges':
        return <BadgesTab tick={tick} onSettled={handleSettled} />
      case 'channels':
        return <ChannelsTab tick={tick} onSettled={handleSettled} />
      case 'moderation':
        return <ModerationTab tick={tick} onSettled={handleSettled} onCount={handleModerationCount} />
      case 'users':
        return <UsersTab tick={tick} onSettled={handleSettled} />
      case 'audit':
        return <AuditTab tick={tick} onSettled={handleSettled} />
      case 'support':
        return <SupportTab tick={tick} onSettled={handleSettled} />
      case 'feedback':
        return <SupportTab tick={tick} onSettled={handleSettled} kind="feedback" />
      case 'ads':
        return <AdsTab tick={tick} onSettled={handleSettled} />
      case 'giveaways':
        return <GiveawaysTab tick={tick} onSettled={handleSettled} />
      case 'quests':
        return <QuestsTab tick={tick} onSettled={handleSettled} />
      case 'promos':
        return <PromosTab tick={tick} onSettled={handleSettled} />
      case 'broadcast':
        return <BroadcastTab tick={tick} onSettled={handleSettled} />
      case 'system':
        return <SystemTab tick={tick} onSettled={handleSettled} onMaintenance={handleMaintenance} />
      case 'tools':
        return <ToolsTab health={health} onRecheck={() => void loadHealth()} healthLoading={healthLoading} />
      case 'bot':
        return <BotTab tick={tick} onSettled={handleSettled} />
    }
  }

  const ThemeSwatches = (
    <div className="flex items-center gap-2" role="group" aria-label="Тема админ-панели">
      {(
        [
          // bg-[#ffffff], а не bg-white: в тёмной теме .bg-white перекрашивается
          // панелью — светлый свотч слился бы с тёмным
          { t: '' as AdminTheme, cls: 'border-slate-300 bg-[#ffffff]', icon: 'sun' },
          { t: 'dark' as AdminTheme, cls: 'border-slate-600 bg-[#111a24]', icon: 'moon' },
          { t: 'sepia' as AdminTheme, cls: 'border-amber-300 bg-[#f0e6d2]', icon: null },
          { t: 'rose' as AdminTheme, cls: 'border-rose-300 bg-[#fbe4eb]', icon: null },
        ] as const
      ).map(({ t, cls, icon }) => {
        const isActive = theme === t
        return (
          <button
            key={t}
            type="button"
            onClick={() => applyTheme(t)}
            title={THEME_LABEL[t]}
            aria-label={`Тема: ${THEME_LABEL[t]}`}
            aria-pressed={isActive}
            className={cn(
              'flex size-6 items-center justify-center rounded-full border shadow-sm transition-all duration-150',
              cls,
              isActive ? 'ring-2 ring-emerald-500 ring-offset-1' : 'opacity-75 hover:opacity-100',
            )}
          >
            {isActive ? (
              <Check
                className={cn('size-3', t === 'dark' ? 'text-sky-300' : 'text-slate-600')}
                aria-hidden
              />
            ) : icon === 'sun' ? (
              <Sun className="size-3 text-slate-500" aria-hidden />
            ) : icon === 'moon' ? (
              <Moon className="size-3 text-slate-300" aria-hidden />
            ) : null}
          </button>
        )
      })}
      <span className="ml-1 text-[11px] text-slate-400">{THEME_LABEL[theme]}</span>
    </div>
  )

  const BrandBlock = (
    <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4">
      <img src="/logo.svg" alt="Tg Swipe" className="h-9 w-9 shrink-0" />
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-slate-900">Tg Swipe</p>
        <p className="truncate text-xs text-slate-500">Админ-панель</p>
      </div>
    </div>
  )

  /*
   * Сгруппированное меню: крошечные uppercase-заголовки секций, активный
   * пункт — акцентная черта слева (3px) + тонированный фон + акцентный текст.
   * Используется и в десктопном сайдбаре, и в мобильном дровере.
   * v5.89: пункт — div[role=button] (внутри — настоящая кнопка-звёздочка
   * закрепления; button в button — невалидный HTML), пины — секцией сверху.
   */
  const renderNavGroups = () => (
    <div>
      {navGroups.map((group, gi) => (
        <div key={group.title ?? `group-${gi}`}>
          {group.title ? (
            <p className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">
              {group.title}
            </p>
          ) : (
            <div className="pt-1" aria-hidden />
          )}
          <div className="flex flex-col gap-0.5">
            {group.keys.map((key) => {
              const item = navByKey.get(key)
              if (!item) return null
              const { label, icon: Icon, badge, badgeTone } = item
              const isActive = active === key
              const isPinned = pinnedSet.has(key)
              return (
                <div
                  key={key}
                  role="button"
                  tabIndex={0}
                  onClick={() => selectTab(key)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      selectTab(key)
                    }
                  }}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'group relative flex w-full cursor-pointer items-center gap-2.5 rounded-lg py-2 pl-4 pr-2.5 text-sm font-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-emerald-500/40',
                    isActive
                      ? 'bg-emerald-50 text-emerald-700 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.10)]'
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900',
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-emerald-500 transition-opacity duration-150',
                      isActive ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                  <Icon className="size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-left">{label}</span>
                  {badge != null && badge !== 0 && badge !== '' && (
                    <span
                      className={cn(
                        'shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums',
                        badgeTone === 'amber' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-600 text-white',
                      )}
                    >
                      {badge}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      togglePin(key)
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                    aria-pressed={isPinned}
                    aria-label={isPinned ? `Открепить «${label}»` : `Закрепить «${label}»`}
                    title={isPinned ? `Открепить «${label}»` : `Закрепить «${label}»`}
                    className={cn(
                      'shrink-0 rounded p-1 transition-opacity duration-150',
                      isPinned
                        ? 'text-amber-500 opacity-100'
                        : 'text-slate-300 opacity-0 hover:!text-slate-500 focus-visible:opacity-100 group-hover:opacity-100',
                    )}
                  >
                    <Star className={cn('size-3.5', isPinned && 'fill-amber-400')} aria-hidden />
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )

  return (
    <div data-adm-theme={theme || 'light'} className="min-h-screen bg-slate-50">
      {/* Шапка: заголовок активной вкладки + статус API/обновление/тема/выход */}
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full items-center gap-2 px-4 md:gap-3 md:px-8">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setNavOpen(true)}
            aria-label="Открыть меню"
            className="text-slate-500 lg:hidden"
          >
            <Menu aria-hidden />
          </Button>
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900 md:text-[15px]">
            {activeLabel}
            <span className="ml-2 hidden text-xs font-normal text-slate-400 xl:inline">
              · Tg Swipe — Админ-панель
            </span>
          </h1>
          <div className="flex shrink-0 items-center gap-2">
            {/* v5.89: командная палитра + автообновление + «обновлено Nс назад» */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPaletteOpen(true)}
              aria-label="Командная палитра — Ctrl+K"
              title="Командная палитра (Ctrl+K)"
              className={cn(btnOutlineDark, 'gap-1.5 px-2.5')}
            >
              <Command aria-hidden />
              <span className="hidden text-[11px] font-normal text-slate-400 xl:inline">⌘K</span>
            </Button>
            {agoLabel && (
              <span className="hidden text-[11px] tabular-nums text-slate-400 lg:inline">
                {agoLabel}
              </span>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleAutoRef}
              aria-pressed={autoRef}
              aria-label="Автообновление раз в минуту"
              title={autoRef ? 'Автообновление: вкл (60с)' : 'Автообновление: выкл'}
              className={autoRef ? 'text-emerald-600' : 'text-slate-400'}
            >
              <Timer aria-hidden />
            </Button>
            {/* Тема: компактный цикл на узких экранах, свотчи — в сайдбаре/дровере */}
            <Button
              variant="ghost"
              size="icon"
              onClick={cycleTheme}
              aria-label={`Тема: ${THEME_LABEL[theme]} — переключить`}
              className="text-slate-500 lg:hidden"
            >
              {theme === 'dark' ? <Moon aria-hidden /> : theme === '' ? <Sun aria-hidden /> : <Palette aria-hidden />}
            </Button>
            <span
              className={cn(
                'flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium',
                pill.ring,
                pill.text,
              )}
              title={health ? `версия ${health.version} · uptime ${health.uptimeSec}с` : undefined}
            >
              <span className={cn('size-2 rounded-full', pill.dot, healthOk && 'animate-pulse')} aria-hidden />
              {pill.label}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={refresh}
              disabled={refreshing}
              aria-label="Обновить данные"
              className={btnOutlineDark}
            >
              <RefreshCw className={cn(refreshing && 'animate-spin')} aria-hidden />
              <span className="hidden md:inline">Обновить</span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={logout}
              aria-label="Выйти"
              className="text-slate-500 hover:bg-red-50 hover:text-red-700"
            >
              <LogOut aria-hidden />
            </Button>
          </div>
        </div>
      </header>

      {/* Сайдбар (lg+): фиксированная колонка на всю высоту — приказ владельца
          v5.11 «сайдбар слева, а не вверху вкладки» + v5.62 редизайн оболочки */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-slate-200 bg-white lg:flex">
        {BrandBlock}
        <nav className="admin-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2" aria-label="Разделы панели">
          {renderNavGroups()}
        </nav>
        <div className="border-t border-slate-100 px-4 py-3">
          {ThemeSwatches}
          <p className="mt-2 text-[11px] text-slate-400">{apiVersion ? `API v${apiVersion}` : 'API'}</p>
        </div>
      </aside>

      {/* Контент: компенсация ширины сайдбара, максимум 1440px по центру */}
      <div className="lg:pl-64">
        <main className="mx-auto w-full max-w-[1440px] px-4 py-5 md:px-8 md:py-6">
          <motion.div
            key={active}
            variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0 } }}
            initial="hidden"
            animate="show"
            transition={{ duration: 0.18 }}
          >
            {renderTab()}
          </motion.div>
        </main>

        <footer className="mx-auto flex w-full max-w-[1440px] items-center justify-between gap-3 px-4 pb-6 text-xs text-slate-500 md:px-8">
          <span>Tg Swipe · Админ-панель</span>
          <span className="tabular-nums">{apiVersion ? `v${apiVersion}` : ''}</span>
        </footer>
      </div>

      {/* Мобильное меню (<lg): выезжающий слева дровер с затемнением */}
      <AnimatePresence>
        {navOpen && (
          <>
            <motion.div
              key="adm-drawer-backdrop"
              className="fixed inset-0 z-40 bg-slate-950/50 backdrop-blur-sm lg:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              onClick={() => setNavOpen(false)}
              aria-hidden
            />
            <motion.aside
              key="adm-drawer"
              role="dialog"
              aria-modal="true"
              aria-label="Навигация панели"
              className="fixed inset-y-0 left-0 z-50 flex w-[280px] max-w-[86vw] flex-col border-r border-slate-200 bg-white lg:hidden"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'tween', duration: 0.22, ease: 'easeOut' }}
            >
              <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3">
                <img src="/logo.svg" alt="Tg Swipe" className="h-9 w-9 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-900">Tg Swipe</p>
                  <p className="truncate text-xs text-slate-500">Админ-панель</p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setNavOpen(false)}
                  aria-label="Закрыть меню"
                  className="text-slate-500"
                >
                  <X aria-hidden />
                </Button>
              </div>
              <nav className="admin-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2" aria-label="Разделы панели">
                {renderNavGroups()}
              </nav>
              <div className="border-t border-slate-100 px-4 py-3">
                {ThemeSwatches}
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="text-[11px] text-slate-400">{apiVersion ? `API v${apiVersion}` : ''}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={logout}
                    className="text-slate-500 hover:bg-red-50 hover:text-red-700"
                  >
                    <LogOut aria-hidden /> Выйти
                  </Button>
                </div>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* v5.89: командная палитра (⌘K/Ctrl+K) — разделы + быстрые действия */}
      <CommandDialog
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        title="Командная палитра"
        description="Переход по разделам и быстрые действия"
      >
        <CommandInput placeholder="Раздел или действие…" />
        <CommandList>
          <CommandEmpty>Ничего не найдено</CommandEmpty>
          <CommandGroup heading="Разделы">
            {NAV.map((item) => (
              <CommandItem
                key={item.key}
                value={`раздел ${item.label}`}
                onSelect={() => {
                  selectTab(item.key)
                  setPaletteOpen(false)
                }}
              >
                <item.icon aria-hidden />
                <span>{item.label}</span>
                {pinnedSet.has(item.key) && (
                  <Star className="ml-auto size-3.5 fill-amber-400 text-amber-400" aria-hidden />
                )}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Действия">
            <CommandItem
              value="обновить данные"
              onSelect={() => {
                setPaletteOpen(false)
                refresh()
              }}
            >
              <RefreshCw aria-hidden />
              Обновить данные
              <CommandShortcut>F5</CommandShortcut>
            </CommandItem>
            <CommandItem
              value={autoRef ? 'автообновление выключить' : 'автообновление включить'}
              onSelect={() => {
                const wasOn = autoRef
                toggleAutoRef()
                setPaletteOpen(false)
                toast.success(wasOn ? 'Автообновление выключено' : 'Автообновление: раз в минуту')
              }}
            >
              <Timer aria-hidden />
              Автообновление (60с)
              <CommandShortcut>{autoRef ? 'вкл' : 'выкл'}</CommandShortcut>
            </CommandItem>
            <CommandItem
              value={pinnedSet.has(active) ? 'открепить вкладку' : 'закрепить вкладку'}
              onSelect={() => {
                togglePin(active)
                setPaletteOpen(false)
                toast.success(
                  pinnedSet.has(active) ? `«${activeLabel}» откреплена` : `«${activeLabel}» закреплена`,
                )
              }}
            >
              <Star aria-hidden />
              {pinnedSet.has(active) ? `Открепить «${activeLabel}»` : `Закрепить «${activeLabel}»`}
            </CommandItem>
            <CommandSeparator />
            {THEME_CYCLE.map((t) => (
              <CommandItem
                key={t}
                value={`тема ${THEME_LABEL[t]}`}
                onSelect={() => {
                  applyTheme(t)
                  setPaletteOpen(false)
                }}
              >
                {t === '' ? <Sun aria-hidden /> : t === 'dark' ? <Moon aria-hidden /> : <Palette aria-hidden />}
                Тема: {THEME_LABEL[t]}
                {theme === t && <Check className="ml-auto text-emerald-600" aria-hidden />}
              </CommandItem>
            ))}
            <CommandItem
              value="выйти из панели"
              onSelect={() => {
                setPaletteOpen(false)
                logout()
              }}
              className="text-red-600 data-[selected=true]:bg-red-50 data-[selected=true]:text-red-700"
            >
              <LogOut aria-hidden />
              Выйти
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </div>
  )
}
