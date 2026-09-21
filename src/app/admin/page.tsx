'use client'

import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Bot,
  Gem,
  Gift,
  BadgeCheck,
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
  Server,
  ShieldAlert,
  Sun,
  Ticket,
  Tv,
  Users,
  Wallet,
  Wrench,
  X,
  Check,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
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
import { AdsTab } from './components/ads-tab'
import { AuditTab } from './components/audit-tab'
import { BadgesTab } from './components/badges-tab'
import { ChannelsTab } from './components/channels-tab'
import { FinanceTab } from './components/finance-tab'
import { GiveawaysTab } from './components/giveaways-tab'
import { QuestsTab } from './components/quests-tab'
import { LoginScreen } from './components/login-screen'
import { ModerationTab } from './components/moderation-tab'
import { OverviewTab } from './components/overview-tab'
import { SubscriptionsTab } from './components/subscriptions-tab'
import { SupportTab } from './components/support-tab'
import { SystemTab } from './components/system-tab'
import { BotTab } from './components/bot-tab'
import { PromosTab } from './components/promos-tab'
import { ToolsTab } from './components/tools-tab'
import { UsersTab } from './components/users-tab'

type AuthState = 'checking' | 'authed' | 'anon'
type TabKey =
  | 'overview'
  | 'bot'
  | 'finance'
  | 'subscriptions'
  | 'badges'
  | 'channels'
  | 'moderation'
  | 'users'
  | 'audit'
  | 'support'
  | 'feedback'
  | 'ads'
  | 'giveaways'
  | 'quests'
  | 'promos'
  | 'system'
  | 'tools'

/*
 * Темы админки (палитры как в миниаппе, приказ владельца v5.11):
 * '' — светлая; dark (Telegram), sepia, rose — раскрашиваются в layout.tsx.
 */
type AdminTheme = '' | 'dark' | 'sepia' | 'rose'
const THEME_KEY = 'tgfeed_admin_theme'
const THEME_CYCLE: AdminTheme[] = ['', 'dark', 'sepia', 'rose']
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
  { title: 'Рост', keys: ['giveaways', 'quests', 'promos'] },
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

  useEffect(() => {
    const saved = (window.localStorage.getItem(THEME_KEY) ?? '') as AdminTheme
    setTheme(THEME_CYCLE.includes(saved) ? saved : '')
  }, [])

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
      const h = await panelFetch<PanelHealth>('/api/panel/health')
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
        const h = await panelFetch<PanelHealth>('/api/panel/health')
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
        className="flex min-h-screen flex-col items-center justify-center gap-3 bg-slate-50"
      >
        <img src="/logo.svg" alt="" className="h-10 w-10 animate-pulse" />
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
        return <PromosTab onSettled={handleSettled} />
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
   */
  const renderNavGroups = () => (
    <div>
      {NAV_GROUPS.map((group, gi) => (
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
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => selectTab(key)}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'relative flex w-full items-center gap-2.5 rounded-lg py-2 pl-4 pr-2.5 text-sm font-medium transition-colors duration-150',
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
                </button>
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
    </div>
  )
}
