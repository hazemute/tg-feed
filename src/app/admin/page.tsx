'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Headset,
  LayoutDashboard,
  Lightbulb,
  LogOut,
  Megaphone,
  MonitorCog,
  Moon,
  Palette,
  RefreshCw,
  Server,
  ShieldAlert,
  Sun,
  Tv,
  Users,
  Wallet,
  Wrench,
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
import { ChannelsTab } from './components/channels-tab'
import { FinanceTab } from './components/finance-tab'
import { LoginScreen } from './components/login-screen'
import { ModerationTab } from './components/moderation-tab'
import { OverviewTab } from './components/overview-tab'
import { SupportTab } from './components/support-tab'
import { SystemTab } from './components/system-tab'
import { ToolsTab } from './components/tools-tab'
import { UsersTab } from './components/users-tab'

type AuthState = 'checking' | 'authed' | 'anon'
type TabKey =
  | 'overview'
  | 'finance'
  | 'channels'
  | 'moderation'
  | 'users'
  | 'support'
  | 'feedback'
  | 'ads'
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

  if (auth === 'checking') {
    return (
      <div data-adm-theme={theme || undefined} className="flex min-h-screen flex-col items-center justify-center gap-3">
        <img src="/logo.svg" alt="" className="h-10 w-10 animate-pulse" />
        <p className="text-xs text-slate-500">Проверка доступа…</p>
      </div>
    )
  }

  if (auth === 'anon') {
    return (
      <div data-adm-theme={theme || undefined}>
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

  const NAV: Array<{
    key: TabKey
    label: string
    icon: typeof LayoutDashboard
    badge?: number | string | null
    badgeTone?: 'accent' | 'amber'
  }> = [
    { key: 'overview', label: 'Обзор', icon: LayoutDashboard },
    { key: 'finance', label: 'Финансы', icon: Wallet },
    { key: 'channels', label: 'Каналы', icon: Tv },
    {
      key: 'moderation',
      label: 'Модерация',
      icon: ShieldAlert,
      badge: modCount !== null && modCount > 0 ? modCount : null,
      badgeTone: 'amber',
    },
    { key: 'users', label: 'Пользователи', icon: Users },
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
    {
      key: 'system',
      label: 'Система',
      icon: Server,
      badge: maintOn ? 'техработы' : null,
      badgeTone: 'amber',
    },
    { key: 'tools', label: 'Инструменты', icon: Wrench },
  ]

  const renderTab = () => {
    switch (active) {
      case 'overview':
        return <OverviewTab tick={tick} onSettled={handleSettled} onCounts={handleCounts} />
      case 'finance':
        return <FinanceTab tick={tick} onSettled={handleSettled} />
      case 'channels':
        return <ChannelsTab tick={tick} onSettled={handleSettled} />
      case 'moderation':
        return <ModerationTab tick={tick} onSettled={handleSettled} onCount={handleModerationCount} />
      case 'users':
        return <UsersTab tick={tick} onSettled={handleSettled} />
      case 'support':
        return <SupportTab tick={tick} onSettled={handleSettled} />
      case 'feedback':
        return <SupportTab tick={tick} onSettled={handleSettled} kind="feedback" />
      case 'ads':
        return <AdsTab tick={tick} onSettled={handleSettled} />
      case 'system':
        return <SystemTab tick={tick} onSettled={handleSettled} onMaintenance={handleMaintenance} />
      case 'tools':
        return <ToolsTab health={health} onRecheck={() => void loadHealth()} healthLoading={healthLoading} />
    }
  }

  const ThemeSwatches = (
    <div className="flex items-center gap-1.5" role="group" aria-label="Тема админ-панели">
      {(
        [
          { t: '' as AdminTheme, cls: 'bg-white border-slate-300' },
          { t: 'dark' as AdminTheme, cls: 'bg-[#17212b] border-slate-600' },
          { t: 'sepia' as AdminTheme, cls: 'bg-[#f0e6d2] border-amber-300' },
          { t: 'rose' as AdminTheme, cls: 'bg-[#fbe4eb] border-rose-300' },
        ]
      ).map(({ t, cls }) => (
        <button
          key={t}
          type="button"
          onClick={() => applyTheme(t)}
          title={THEME_LABEL[t]}
          aria-label={`Тема: ${THEME_LABEL[t]}`}
          aria-pressed={theme === t}
          className={cn(
            'flex size-6 items-center justify-center rounded-full border transition',
            cls,
            theme === t ? 'ring-2 ring-emerald-500 ring-offset-1' : 'opacity-70 hover:opacity-100',
          )}
        >
          {t === '' && <Sun className="size-3 text-slate-500" aria-hidden />}
          {t === 'dark' && <Moon className="size-3 text-white" aria-hidden />}
        </button>
      ))}
      <span className="ml-1 hidden text-[11px] text-slate-400 xl:inline">{THEME_LABEL[theme]}</span>
    </div>
  )

  return (
    <div data-adm-theme={theme || undefined} className="min-h-screen">
      {/* Шапка */}
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="flex h-14 w-full items-center gap-3 px-4 md:px-6">
          <img src="/logo.svg" alt="" className="h-7 w-7" />
          <h1 className="truncate text-sm font-semibold text-slate-900 md:text-base">
            Tg Swipe · Админ-панель
          </h1>
          <div className="ml-auto flex items-center gap-2">
            {/* Тема: компактный цикл на узких экранах, свотчи в сайдбаре */}
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

      {/* Сайдбар (lg+) + контент — приказ владельца: «для компа сделай сайдбар
          слева, а не вверху вкладки, потому что много вкладок горизонтальных
          в админ панели не красиво» */}
      <div className="flex w-full items-start px-4 md:px-6">
        <aside className="sticky top-[72px] mt-4 hidden w-52 shrink-0 flex-col gap-1 lg:flex">
          <nav className="flex flex-col gap-1 rounded-xl border border-slate-200 bg-white p-2" aria-label="Разделы панели">
            {NAV.map(({ key, label, icon: Icon, badge, badgeTone }) => {
              const isActive = active === key
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setActive(key)}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900',
                  )}
                >
                  <Icon className="size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-left">{label}</span>
                  {badge != null && badge !== 0 && badge !== '' && (
                    <span
                      className={cn(
                        'shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums',
                        badgeTone === 'amber'
                          ? 'bg-amber-100 text-amber-700'
                          : 'bg-emerald-600 text-white',
                      )}
                    >
                      {badge}
                    </span>
                  )}
                </button>
              )
            })}
          </nav>
          <div className="mt-2 rounded-xl border border-slate-200 bg-white p-3">
            <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              <MonitorCog className="size-3.5" aria-hidden /> Тема панели
            </p>
            {ThemeSwatches}
          </div>
        </aside>

        <main className="min-w-0 flex-1 py-4">
          {/* Мобильная навигация: горизонтальная полоса */}
          <div className="mb-4 flex gap-1.5 overflow-x-auto pb-1 no-scrollbar lg:hidden" role="tablist" aria-label="Разделы">
            {NAV.map(({ key, label, icon: Icon, badge, badgeTone }) => {
              const isActive = active === key
              return (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActive(key)}
                  className={cn(
                    'flex flex-none items-center gap-1.5 rounded-lg border px-3 py-2 text-[13px] font-medium transition-colors',
                    isActive
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                      : 'border-slate-200 bg-white text-slate-600',
                  )}
                >
                  <Icon className="size-3.5" aria-hidden />
                  {label}
                  {badge != null && badge !== 0 && badge !== '' && (
                    <span
                      className={cn(
                        'rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums',
                        badgeTone === 'amber' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-600 text-white',
                      )}
                    >
                      {badge}
                    </span>
                  )}
                </button>
              )
            })}
            {/* Тема на мобиле: свотчи в конце полосы */}
            <div className="flex flex-none items-center rounded-lg border border-slate-200 bg-white px-2.5">
              <span className="mr-1.5 text-[11px] text-slate-400">
                <Palette className="size-3.5" aria-hidden />
              </span>
              {ThemeSwatches}
            </div>
          </div>

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
      </div>

      <footer className="flex w-full items-center px-4 pb-6 text-xs text-slate-500 md:px-6">
        <span>Tg Swipe{apiVersion ? ` · API v${apiVersion}` : ''}</span>
      </footer>
    </div>
  )
}
