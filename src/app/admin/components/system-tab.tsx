'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  AlertTriangle,
  Check,
  DatabaseZap,
  KeyRound,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  UserX,
  Wrench,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'

import {
  isAuthOrNetworkError,
  panelFetch,
  PanelError,
  type SystemInfo,
  type UsersResponse,
} from './api'
import {
  EmptyState,
  SkeletonRows,
  TabProps,
  UserKindBadge,
  btnOutlineDark,
  fadeUp,
  inputDark,
  panelCard,
  useDebouncedValue,
} from './bits'

/**
 * Вкладка «Система»: техработы (вкл/выкл), белый список допуска
 * (поиск по пользователям + добавление по Telegram ID) и кэш
 * (статус Redis, версии семейств, сброс).
 */
export function SystemTab({ tick, onSettled, onMaintenance }: TabProps & { onMaintenance?: (on: boolean) => void }) {
  const [data, setData] = useState<SystemInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [localTick, setLocalTick] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [tgId, setTgId] = useState('')

  const reload = async () => {
    try {
      const d = await panelFetch<SystemInfo>('/api/panel/system')
      setData(d)
      setError(null)
      onMaintenance?.(d.maintenance.enabled)
    } catch (e) {
      if (!isAuthOrNetworkError(e)) {
        const msg = e instanceof PanelError ? e.message : 'Ошибка загрузки'
        toast.error(msg)
      }
    } finally {
      setLoading(false)
      onSettled()
    }
  }

  useEffect(() => {
    let alive = true
    void reload()
    return () => {
      alive = false
    }
  }, [tick, localTick])

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    try {
      await fn()
      await reload()
    } catch (e) {
      if (!isAuthOrNetworkError(e)) {
        const msg = e instanceof PanelError ? e.message : 'Не получилось'
        toast.error(msg)
      }
    } finally {
      setBusy(null)
    }
  }

  const toggleMaintenance = (enabled: boolean) => {
    if (enabled) {
      const sure = window.confirm(
        'Включить техработы?\n\nОбычные пользователи увидят экран техработ, API закроется для всех, кроме админов и белого списка.',
      )
      if (!sure) return
    }
    void act('maint', () =>
      panelFetch('/api/panel/system', { json: { action: 'setEnabled', enabled } }),
    ).then(() => toast.success(enabled ? 'Техработы включены' : 'Техработы выключены'))
  }

  const addToAllow = (userId: string) =>
    act(`allow:${userId}`, () =>
      panelFetch('/api/panel/system', { json: { action: 'allow', userId } }),
    ).then(() => {
      toast.success('Допуск выдан')
    })

  const removeFromAllow = (userId: string) =>
    act(`disallow:${userId}`, () =>
      panelFetch('/api/panel/system', { json: { action: 'disallow', userId } }),
    ).then(() => {
      toast.success('Допуск отозван')
    })

  const addByTgId = () =>
    act('tgid', () =>
      panelFetch('/api/panel/system', { json: { action: 'allowByTgId', tgId } }),
    ).then(() => {
      toast.success('Пользователь допущен')
      setTgId('')
    })

  const resetCache = () =>
    act('cache', () =>
      panelFetch('/api/panel/system', { json: { action: 'resetCache' } }),
    ).then(() => {
      toast.success('Кэш сброшен — лента перестроится')
    })

  if (loading && !data) {
    return (
      <Card className={panelCard}>
        <CardContent className="pt-6">
          <SkeletonRows rows={6} />
        </CardContent>
      </Card>
    )
  }

  if (error && !data) {
    return (
      <Card className={panelCard}>
        <EmptyState icon={AlertTriangle} title="Не удалось загрузить системные настройки" hint={error} />
      </Card>
    )
  }

  if (!data) return null

  const maintOn = data.maintenance.enabled
  const allowUsers = data.allow.users

  return (
    <motion.div variants={fadeUp} initial="hidden" animate="show" className="space-y-4">
      {/* ------------------- Техработы ------------------- */}
      <Card className={cn(panelCard, maintOn && 'border-amber-300 ring-1 ring-amber-200')}>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2 text-base text-slate-900">
                <Wrench className={cn('size-4', maintOn ? 'text-amber-600' : 'text-slate-500')} aria-hidden />
                Технические работы
              </CardTitle>
              <CardDescription className="text-xs text-slate-500">
                Закрывает миниапп для всех, кроме админов и белого списка
              </CardDescription>
            </div>
            <div className="flex items-center gap-2.5">
              <span
                className={cn(
                  'text-sm font-medium',
                  maintOn ? 'text-amber-700' : 'text-slate-500',
                )}
              >
                {maintOn ? 'Включены' : 'Выключены'}
              </span>
              <Switch
                checked={maintOn}
                onCheckedChange={toggleMaintenance}
                disabled={busy === 'maint'}
                aria-label="Включить технические работы"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {maintOn && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                Миниапп закрыт: пользователи видят экран техработ, все API (кроме auth/panel/health)
                отвечают 503. Изменение применяется на всех инстансах в течение ~15 секунд.
              </span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-500">
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="size-3.5 text-emerald-600" aria-hidden />
              Админы (ADMIN_TG_IDS):{' '}
              <b className="font-semibold text-slate-700">
                {data.admins.length > 0 ? data.admins.length : 'нет в env'}
              </b>
            </span>
            <span>
              В белом списке: <b className="font-semibold text-slate-700">{allowUsers.length}</b>
              {data.allow.pendingIds.length > 0 && (
                <span className="text-slate-400"> + {data.allow.pendingIds.length} зарезерв.</span>
              )}
            </span>
            {data.maintenance.dbMirror !== maintOn && (
              <span className="text-amber-700">зеркало в БД расходится — включите и выключите режим</span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ------------------- Белый список ------------------- */}
      <AllowListCard
        data={data}
        busy={busy}
        tgId={tgId}
        setTgId={setTgId}
        onAdd={addToAllow}
        onRemove={removeFromAllow}
        onAddByTgId={addByTgId}
      />

      {/* ------------------- Кэш ------------------- */}
      <Card className={panelCard}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base text-slate-900">
            <DatabaseZap className="size-4 text-slate-500" aria-hidden />
            Кэш
          </CardTitle>
          <CardDescription className="text-xs text-slate-500">
            Redis: {data.cache.redis === 'upstash' ? 'Upstash подключён' : data.cache.redis === 'down' ? 'недоступен' : 'не настроен (только память)'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {Object.entries(data.cache.versions).map(([family, v]) => (
              <Badge key={family} variant="outline" className="border-slate-200 bg-slate-50 font-mono text-[10px] text-slate-600">
                {family}: v{v}
              </Badge>
            ))}
            {Object.keys(data.cache.versions).length === 0 && (
              <span className="text-xs text-slate-400">Версии недоступны</span>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={resetCache}
            disabled={busy === 'cache'}
            className={btnOutlineDark}
          >
            {busy === 'cache' ? <RefreshCw className="animate-spin" aria-hidden /> : <Trash2 aria-hidden />}
            Сбросить кэш
          </Button>
          <p className="text-xs leading-relaxed text-slate-400">
            Инвалидация по версиям: лента, тренды, каналы, категории и поиск перестроятся при следующем
            запросе. Пригодится после массовых правок в БД.
          </p>
        </CardContent>
      </Card>
    </motion.div>
  )
}

/* ===================== Белый список допуска ===================== */

function AllowListCard({
  data,
  busy,
  tgId,
  setTgId,
  onAdd,
  onRemove,
  onAddByTgId,
}: {
  data: SystemInfo
  busy: string | null
  tgId: string
  setTgId: (v: string) => void
  onAdd: (userId: string) => Promise<void>
  onRemove: (userId: string) => Promise<void>
  onAddByTgId: () => Promise<void>
}) {
  const [q, setQ] = useState('')
  const debouncedQ = useDebouncedValue(q, 400)
  const [search, setSearch] = useState<UsersResponse | null>(null)
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    let alive = true
    const query = debouncedQ.trim()
    if (query.length < 2) {
      // сброс — в микротаске, чтобы не дёргать setState синхронно в эффекте
      const t = setTimeout(() => {
        if (!alive) return
        setSearch(null)
        setSearching(false)
      }, 0)
      return () => {
        alive = false
        clearTimeout(t)
      }
    }
    const t = setTimeout(() => {
      if (!alive) return
      setSearching(true)
      panelFetch<UsersResponse>(`/api/panel/users?q=${encodeURIComponent(query)}&pageSize=8`)
        .then((d) => {
          if (!alive) return
          setSearch(d)
          setSearching(false)
        })
        .catch(() => {
          if (!alive) return
          setSearch(null)
          setSearching(false)
        })
    }, 250)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [debouncedQ])

  const displayName = (u: { firstName: string | null; lastName: string | null; username: string | null; id: string }) =>
    [u.firstName, u.lastName].filter(Boolean).join(' ') || (u.username ? `@${u.username}` : u.id)

  const inAllow = (id: string) =>
    data.allow.users.some((u) => u.id === id) || data.allow.pendingIds.includes(id)

  return (
    <Card className={panelCard}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-slate-900">
          <KeyRound className="size-4 text-slate-500" aria-hidden />
          Допуск мимо техработ
        </CardTitle>
        <CardDescription className="text-xs text-slate-500">
          Эти пользователи смогут пользоваться миниаппом, пока включены техработы
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Добавить по Telegram ID */}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={tgId}
            onChange={(e) => setTgId(e.target.value.replace(/[^\d]/g, ''))}
            placeholder="Telegram ID (цифры, узнать — @userinfobot)"
            aria-label="Telegram ID для допуска"
            className={cn('h-9 flex-1 text-sm', inputDark)}
            inputMode="numeric"
          />
          <Button
            size="sm"
            onClick={onAddByTgId}
            disabled={busy === 'tgid' || tgId.trim().length < 3}
            className="h-9 bg-emerald-600 text-white hover:bg-emerald-700"
          >
            <Plus aria-hidden /> Допустить
          </Button>
        </div>

        {/* Текущий список */}
        <div className="space-y-1">
          {data.allow.users.length === 0 && data.allow.pendingIds.length === 0 ? (
            <p className="px-1 py-2 text-xs text-slate-400">
              Пока никого. Найдите пользователя ниже или добавьте по Telegram ID — допустить можно и
              заранее, до первого захода в приложение.
            </p>
          ) : (
            data.allow.users.map((u) => (
              <div
                key={u.id}
                className="flex items-center gap-3 rounded-md border border-slate-100 bg-slate-50/60 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-slate-800">{displayName(u)}</span>
                    <UserKindBadge isDemo={u.isDemo} />
                  </div>
                  <span className="block truncate font-mono text-[11px] text-slate-500">{u.id}</span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onRemove(u.id)}
                  disabled={busy === `disallow:${u.id}`}
                  className="h-7 gap-1 border-slate-200 px-2 text-xs text-red-600 hover:bg-red-50 hover:text-red-700"
                  aria-label={`Отозвать допуск у ${displayName(u)}`}
                >
                  <UserX className="size-3.5" aria-hidden /> Отозвать
                </Button>
              </div>
            ))
          )}
          {data.allow.pendingIds.map((id) => (
            <div
              key={id}
              className="flex items-center gap-3 rounded-md border border-dashed border-slate-200 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[11px] text-slate-500">{id}</span>
                <span className="text-[11px] text-slate-400">допущен заранее, в приложении ещё не появлялся</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onRemove(id)}
                disabled={busy === `disallow:${id}`}
                className="h-7 gap-1 border-slate-200 px-2 text-xs text-red-600 hover:bg-red-50 hover:text-red-700"
                aria-label={`Отозвать допуск у ${id}`}
              >
                <UserX className="size-3.5" aria-hidden /> Отозвать
              </Button>
            </div>
          ))}
        </div>

        {/* Поиск по пользователям */}
        <div className="rounded-md border border-slate-200 p-3">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-slate-500"
              aria-hidden
            />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Найти пользователя: имя, @username или ID"
              aria-label="Поиск пользователей для допуска"
              className={cn('h-9 pl-8 text-sm', inputDark)}
            />
          </div>
          {searching && (
            <div className="pt-3">
              <SkeletonRows rows={2} />
            </div>
          )}
          {!searching && search && debouncedQ.trim().length >= 2 && (
            <div className="space-y-1 pt-3">
              {search.items.length === 0 ? (
                <p className="px-1 py-1 text-xs text-slate-400">Никого не найдено</p>
              ) : (
                search.items.map((u) => {
                  const added = inAllow(u.id)
                  return (
                    <div key={u.id} className="flex items-center gap-3 rounded-md px-1 py-1.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm text-slate-800">
                            {[u.firstName, u.lastName].filter(Boolean).join(' ') || (u.username ? `@${u.username}` : u.id)}
                          </span>
                          <UserKindBadge isDemo={u.isDemo} />
                          {added && (
                            <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-[10px] text-emerald-700">
                              <Check className="size-3" aria-hidden /> в списке
                            </Badge>
                          )}
                        </div>
                        <span className="block truncate font-mono text-[11px] text-slate-500">{u.id}</span>
                      </div>
                      {added ? (
                        <span className="shrink-0 text-xs text-emerald-700">допущен</span>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onAdd(u.id)}
                          disabled={busy === `allow:${u.id}`}
                          className="h-7 gap-1 border-slate-200 px-2 text-xs text-slate-700 hover:bg-slate-100"
                        >
                          <Plus className="size-3.5" aria-hidden /> Допустить
                        </Button>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
