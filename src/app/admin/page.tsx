'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { LogOut, RefreshCw, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

import {
  clearAdminKey,
  getAdminKey,
  panelFetch,
  PanelError,
  UNAUTH_EVENT,
  type OverviewCounts,
  type PanelHealth,
} from './components/api'
import { btnOutlineDark, panelCard } from './components/bits'
import { AdsTab } from './components/ads-tab'
import { ChannelsTab } from './components/channels-tab'
import { LoginScreen } from './components/login-screen'
import { ModerationTab } from './components/moderation-tab'
import { OverviewTab } from './components/overview-tab'
import { SystemTab } from './components/system-tab'
import { ToolsTab } from './components/tools-tab'
import { UsersTab } from './components/users-tab'

type AuthState = 'checking' | 'authed' | 'anon'

const TAB_TRIGGER =
  'flex-none gap-1.5 rounded-md px-3 py-1.5 text-sm text-slate-500 transition-colors ' +
  'data-[state=active]:bg-emerald-100 data-[state=active]:text-emerald-700 ' +
  'data-[state=active]:shadow-none'

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
  const handleMaintenance = useCallback((on: boolean) => setMaintOn(on), [])

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
      // «Обновить» крутится, пока идёт хотя бы health-запрос; вкладки дублируют
      // onSettled — на «Инструментах» (без fetch по tick) это единственная точка остановки.
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
        // 401 (ключ очищен) или сеть недоступна — показываем логин.
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
      <div className="flex min-h-screen flex-col items-center justify-center gap-3">
        <img src="/logo.svg" alt="" className="h-10 w-10 animate-pulse" />
        <p className="text-xs text-slate-500">Проверка доступа…</p>
      </div>
    )
  }

  if (auth === 'anon') {
    return <LoginScreen onSuccess={handleLoginSuccess} />
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

  return (
    <div className="min-h-screen">
      {/* Шапка */}
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-3 px-4 md:px-6">
          <img src="/logo.svg" alt="" className="h-7 w-7" />
          <h1 className="truncate text-sm font-semibold text-slate-900 md:text-base">
            Tg Swipe · Админ-панель
          </h1>
          <Badge
            variant="outline"
            className="hidden border-slate-200 bg-slate-100 text-slate-500 sm:inline-flex"
          >
            <ShieldCheck className="size-3" aria-hidden /> Локальный доступ
          </Badge>
          <div className="ml-auto flex items-center gap-2">
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

      {/* Контент */}
      <main className="mx-auto w-full max-w-7xl p-4 md:p-6">
        <Tabs defaultValue="overview">
          <TabsList
            className={cn(
              'h-auto w-full max-w-full justify-start overflow-x-auto rounded-lg border border-slate-200 bg-slate-100 p-1 no-scrollbar md:w-fit',
            )}
          >
            <TabsTrigger value="overview" className={TAB_TRIGGER}>
              Обзор
            </TabsTrigger>
            <TabsTrigger value="channels" className={TAB_TRIGGER}>
              Каналы
            </TabsTrigger>
            <TabsTrigger value="moderation" className={TAB_TRIGGER}>
              Модерация
              {modCount !== null && modCount > 0 ? (
                <span className="ml-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                  {modCount}
                </span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="users" className={TAB_TRIGGER}>
              Пользователи
            </TabsTrigger>
            <TabsTrigger value="ads" className={TAB_TRIGGER}>
              Реклама
            </TabsTrigger>
            <TabsTrigger value="system" className={TAB_TRIGGER}>
              Система
              {maintOn ? (
                <span className="ml-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                  техработы
                </span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="tools" className={TAB_TRIGGER}>
              Инструменты
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4 outline-none">
            <OverviewTab tick={tick} onSettled={handleSettled} onCounts={handleCounts} />
          </TabsContent>
          <TabsContent value="channels" className="mt-4 outline-none">
            <ChannelsTab tick={tick} onSettled={handleSettled} />
          </TabsContent>
          <TabsContent value="moderation" className="mt-4 outline-none">
            <ModerationTab tick={tick} onSettled={handleSettled} onCount={handleModerationCount} />
          </TabsContent>
          <TabsContent value="users" className="mt-4 outline-none">
            <UsersTab tick={tick} onSettled={handleSettled} />
          </TabsContent>
          <TabsContent value="ads" className="mt-4 outline-none">
            <AdsTab tick={tick} onSettled={handleSettled} />
          </TabsContent>
          <TabsContent value="system" className="mt-4 outline-none">
            <SystemTab tick={tick} onSettled={handleSettled} onMaintenance={handleMaintenance} />
          </TabsContent>
          <TabsContent value="tools" className="mt-4 outline-none">
            <ToolsTab health={health} onRecheck={() => void loadHealth()} healthLoading={healthLoading} />
          </TabsContent>
        </Tabs>
      </main>

      <footer className="mx-auto flex max-w-7xl items-center justify-between px-4 pb-6 text-xs text-slate-500 md:px-6">
        <span>
          Tg Swipe{apiVersion ? ` · API v${apiVersion}` : ''} · локальная админ-панель
        </span>
        <span className={cn(panelCard, 'rounded border px-2 py-0.5')}>sessionStorage: tgfeed_admin_key</span>
      </footer>
    </div>
  )
}
