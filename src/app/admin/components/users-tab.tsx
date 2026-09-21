'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import {
  AlertTriangle,
  Ban,
  BadgeCheck,
  Banknote,
  CalendarClock,
  Check,
  ClipboardCheck,
  Code2,
  Copy,
  Crown,
  Gem,
  Gift,
  HeartHandshake,
  Infinity as InfinityIcon,
  RefreshCw,
  Search,
  SearchX,
  Settings2,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Trash2,
  Wallet,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { BADGES, BADGE_LIST, type BadgeSlug } from '@/lib/badges'

import {
  fmtAgo,
  fmtNum,
  isAuthOrNetworkError,
  panelFetch,
  PanelError,
  userAction,
  type PanelUser,
  type UsersFilter,
  type UsersResponse,
} from './api'
import {
  Avatar,
  EmptyState,
  Pagination,
  SkeletonRows,
  TabProps,
  UserKindBadge,
  btnOutlineDark,
  fadeUp,
  inputDark,
  panelCard,
  useDebouncedValue,
} from './bits'

const PAGE_SIZE = 20

/** Фильтры v5.18: тип аккаунта / бан / подписка */
const FILTERS: Array<{ key: UsersFilter; label: string }> = [
  { key: 'all', label: 'Все' },
  { key: 'tg', label: 'Telegram' },
  { key: 'guests', label: 'Гости' },
  { key: 'plus', label: 'Plus' },
  { key: 'pro', label: 'Pro' },
  { key: 'expiring', label: 'Истекают ≤7д' },
  { key: 'banned', label: 'Бан' },
]

const FILTER_ALL = 'all'

/** Бейдж подписки: Plus (изумруд) / Pro (золото) + срок, красным если истекает ≤3д */
export function TierBadge({ tier, until }: { tier: PanelUser['tier']; until?: string | null }) {
  if (tier !== 'plus' && tier !== 'pro') return null
  const daysLeft = until ? Math.ceil((new Date(until).getTime() - Date.now()) / 86_400_000) : null
  const soon = daysLeft !== null && daysLeft <= 3
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
        tier === 'pro'
          ? 'bg-amber-100 text-amber-700'
          : 'bg-emerald-100 text-emerald-700',
        soon && 'bg-red-100 text-red-700',
      )}
      title={until ? `Подписка до ${new Date(until).toLocaleDateString('ru-RU')}` : undefined}
    >
      <Gem className="size-3" aria-hidden />
      {tier === 'pro' ? 'Pro' : 'Plus'}
      {daysLeft !== null && (soon || daysLeft < 30) && (
        <span className="font-normal opacity-80">
          · {daysLeft <= 0 ? 'истекает' : `${daysLeft}д`}
        </span>
      )}
      {daysLeft === null && <InfinityIcon className="size-3 opacity-70" aria-hidden />}
    </span>
  )
}

/** Мини-чип бейджа для таблиц/списков админки (цвета — lib/badges.ts) */
const BADGE_ICONS = {
  Code2: Code2,
  ClipboardCheck: ClipboardCheck,
  ShieldCheck: ShieldCheck,
  HeartHandshake: HeartHandshake,
  Crown: Crown,
  Sparkles: Sparkles,
} as const

export function AdminBadgeChip({ slug }: { slug: string }) {
  const def = BADGES[slug as BadgeSlug]
  if (!def) return null
  const Icon = BADGE_ICONS[def.icon]
  return (
    <span
      title={def.hint}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] font-semibold',
        def.solid,
      )}
    >
      <Icon className="size-3" aria-hidden />
      {def.label}
    </span>
  )
}

/* ===================== v5.62: карточка-секция модалки «Действия» ===================== */

type SectionTone = 'emerald' | 'violet' | 'slate' | 'red'

const SECTION_TONE: Record<SectionTone, string> = {
  emerald: 'bg-emerald-50 text-emerald-700',
  violet: 'bg-violet-50 text-violet-700',
  slate: 'bg-slate-100 text-slate-600',
  red: 'bg-red-50 text-red-600',
}

/** Секция модалки: белая карточка с иконкой в тонированном квадрате + заголовок + хинт */
function SectionCard({
  icon: Icon,
  tone,
  title,
  hint,
  right,
  footer,
  children,
  className,
}: {
  icon: LucideIcon
  tone: SectionTone
  title: string
  hint?: string
  right?: ReactNode
  footer?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('rounded-xl border border-slate-200 bg-white p-4', className)}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <span
            className={cn(
              'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg',
              SECTION_TONE[tone],
            )}
          >
            <Icon className="size-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <h3 className="text-[13px] font-semibold leading-tight text-slate-800">{title}</h3>
            {hint && <p className="mt-0.5 text-xs leading-snug text-slate-500">{hint}</p>}
          </div>
        </div>
        {right && <div className="shrink-0 text-right">{right}</div>}
      </div>
      <div className="mt-3">{children}</div>
      {footer && <div className="mt-3">{footer}</div>}
    </section>
  )
}

/** Детерминированный цвет аватара по ID (палитра бренда, инлайн-стиль — темы не задеты) */
const AVATAR_COLORS = [
  '#0ea5e9',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
  '#14b8a6',
  '#3b82f6',
  '#f97316',
  '#64748b',
] as const

function avatarColorFor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

export function UsersTab({ tick, onSettled }: TabProps) {
  const [q, setQ] = useState('')
  const debouncedQ = useDebouncedValue(q, 400)
  const [filter, setFilter] = useState<UsersFilter>(FILTER_ALL)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<UsersResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [localTick, setLocalTick] = useState(0)
  const [bypassBusy, setBypassBusy] = useState<string | null>(null)
  // v5.11: модалка действий над пользователем (бан/баланс/премиум)
  const [actionUser, setActionUser] = useState<PanelUser | null>(null)
  const [banReason, setBanReason] = useState('')
  const [swipesInput, setSwipesInput] = useState('')
  // v5.61: рублёвый баланс (ввод в ₽ с копейками, храним строкой из-за десятичной запятой)
  const [balanceInput, setBalanceInput] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  // v5.18: выдача подписки в модалке
  const [tierPlan, setTierPlan] = useState<'plus' | 'pro'>('plus')
  const [tierDays, setTierDays] = useState('30')
  const [tierForever, setTierForever] = useState(false)
  const [tierReason, setTierReason] = useState('')

  // Модалка закрывается по Esc (как AlertDialog) — кроме момента выполнения действия
  useEffect(() => {
    if (!actionUser) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !actionBusy) setActionUser(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actionUser, actionBusy])

  useEffect(() => {
    let alive = true
    const run = async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
      if (debouncedQ.trim()) params.set('q', debouncedQ.trim())
      if (filter !== FILTER_ALL) params.set('filter', filter)
      try {
        const d = await panelFetch<UsersResponse>(`/api/panel/users?${params.toString()}`)
        if (!alive) return
        setData(d)
        setError(null)
        setLoading(false)
      } catch (e) {
        if (!alive || isAuthOrNetworkError(e)) return
        const msg = e instanceof PanelError ? e.message : 'Ошибка загрузки'
        if (data) toast.error(msg)
        else setError(msg)
        setLoading(false)
      } finally {
        if (alive) onSettled()
      }
    }
    void run()
    return () => {
      alive = false
    }
     
  }, [debouncedQ, page, filter, tick, localTick])

  /** Переключить допуск пользователя мимо техработ (PATCH + оптимистичный апдейт) */
  const toggleBypass = async (u: PanelUser, next: boolean) => {
    setBypassBusy(u.id)
    const prev = data
    if (data) {
      setData({
        ...data,
        items: data.items.map((x) => (x.id === u.id ? { ...x, bypassMaintenance: next } : x)),
      })
    }
    try {
      await panelFetch('/api/panel/users', {
        method: 'PATCH',
        json: { userId: u.id, bypassMaintenance: next },
      })
      toast.success(next ? 'Допуск выдан' : 'Допуск отозван')
    } catch (e) {
      if (prev) setData(prev) // откат
      if (!isAuthOrNetworkError(e)) {
        const msg = e instanceof PanelError ? e.message : 'Не получилось'
        toast.error(msg)
      }
    } finally {
      setBypassBusy(null)
    }
  }

  const displayName = (u: PanelUser) =>
    [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || u.id

  /** Копировать ID юзера в буфер (кнопка в шапке модалки) */
  const copyUserId = (id: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(id)
        toast.success('ID скопирован')
      }
    } catch {
      /* приватный режим — без копирования */
    }
  }

  /** Действие v5.11/v5.18 с оптимистичным апдейтом */
  const runUserAction = async (
    u: PanelUser,
    payload: Parameters<typeof userAction>[0],
    okText: string,
    patch: Partial<PanelUser>,
  ) => {
    setActionBusy(true)
    const prev = data
    if (data) {
      setData({ ...data, items: data.items.map((x) => (x.id === u.id ? { ...x, ...patch } : x)) })
    }
    try {
      await userAction(payload)
      toast.success(okText)
      setActionUser(null)
      setBanReason('')
      setTierReason('')
    } catch (e) {
      if (prev) setData(prev)
      if (!isAuthOrNetworkError(e)) {
        toast.error(e instanceof PanelError ? e.message : 'Не получилось')
      }
    } finally {
      setActionBusy(false)
    }
  }

  const openAction = (u: PanelUser) => {
    setBanReason(u.banReason ?? '')
    setSwipesInput(u.swipes != null ? String(u.swipes) : '')
    setBalanceInput(u.balanceKop != null ? (u.balanceKop / 100).toFixed(2) : '')
    // Подписка: план/срок прематчиваем по текущему состоянию
    setTierPlan(u.tier === 'pro' ? 'pro' : 'plus')
    setTierDays('30')
    setTierForever(false)
    setTierReason('')
    setActionUser(u)
  }

  const grantDays = tierForever ? 36_500 : Math.max(1, Math.min(36_500, Math.round(Number(tierDays) || 0)))

  return (
    <motion.div variants={fadeUp} initial="hidden" animate="show">
      <Card className={panelCard}>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base text-slate-900">Пользователи</CardTitle>
              <CardDescription className="text-xs text-slate-500">
                Подписки, баны, балансы · «Действия» — выдача Plus/Pro на любой срок
              </CardDescription>
            </div>
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-slate-500"
                aria-hidden
              />
              <Input
                value={q}
                onChange={(e) => {
                  setQ(e.target.value)
                  setPage(1)
                }}
                placeholder="ID или @username"
                aria-label="Поиск пользователей"
                className={cn('h-8 w-64 pl-8 text-sm', inputDark)}
              />
            </div>
          </div>
          {/* Фильтры */}
          <div className="flex flex-wrap gap-1.5 pt-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => {
                  setFilter(f.key)
                  setPage(1)
                }}
                aria-pressed={filter === f.key}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                  filter === f.key
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {loading && !data ? (
            <SkeletonRows rows={8} />
          ) : error && !data ? (
            <EmptyState
              icon={AlertTriangle}
              title="Не удалось загрузить пользователей"
              hint={error}
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setLocalTick((t) => t + 1)}
                  className={btnOutlineDark}
                >
                  <RefreshCw aria-hidden /> Повторить
                </Button>
              }
            />
          ) : data && data.items.length === 0 ? (
            <EmptyState
              icon={SearchX}
              title="Пользователи не найдены"
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setQ('')
                    setFilter(FILTER_ALL)
                    setPage(1)
                  }}
                  className={btnOutlineDark}
                >
                  Сбросить фильтры
                </Button>
              }
            />
          ) : data ? (
            <>
              {/* Десктоп: таблица */}
              <div className="hidden md:block">
                <div className="admin-scroll max-h-[560px] overflow-auto rounded-md border border-slate-200">
                  <Table className="min-w-[1060px]">
                    <TableHeader>
                      <TableRow className="border-slate-200 hover:bg-transparent">
                        <TableHead className="text-xs text-slate-500">ID</TableHead>
                        <TableHead className="text-xs text-slate-500">Имя</TableHead>
                        <TableHead className="text-xs text-slate-500">Username</TableHead>
                        <TableHead className="text-xs text-slate-500">Тип</TableHead>
                        <TableHead className="text-xs text-slate-500">Бейджи</TableHead>
                        <TableHead className="text-xs text-slate-500">Подписка</TableHead>
                        <TableHead className="text-right text-xs text-slate-500">Лайки</TableHead>
                        <TableHead className="text-right text-xs text-slate-500">Закладки</TableHead>
                        <TableHead className="text-right text-xs text-slate-500">Просмотры</TableHead>
                        <TableHead className="text-right text-xs text-slate-500">Свайпы</TableHead>
                        <TableHead className="text-right text-xs text-slate-500">Рубли</TableHead>
                        <TableHead className="text-center text-xs text-slate-500">Статус</TableHead>
                        <TableHead className="text-center text-xs text-slate-500">Допуск</TableHead>
                        <TableHead className="text-center text-xs text-slate-500">Действия</TableHead>
                        <TableHead className="text-xs text-slate-500">Регистрация</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.items.map((u) => (
                        <TableRow key={u.id} className="border-slate-200 hover:bg-slate-50">
                          <TableCell className="max-w-[140px]">
                            <span title={u.id} className="block truncate font-mono text-xs text-slate-500">
                              {u.id}
                            </span>
                          </TableCell>
                          <TableCell className="max-w-[160px] truncate text-sm text-slate-800">
                            {displayName(u)}
                          </TableCell>
                          <TableCell className="max-w-[140px] truncate text-xs text-slate-500">
                            {u.username ? `@${u.username}` : '—'}
                          </TableCell>
                          <TableCell>
                            <UserKindBadge isGuest={u.isGuest} />
                          </TableCell>
                          <TableCell>
                            {u.badges && u.badges.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {u.badges.slice(0, 3).map((slug) => (
                                  <AdminBadgeChip key={slug} slug={slug} />
                                ))}
                                {u.badges.length > 3 && (
                                  <span className="text-[11px] font-semibold text-slate-400">+{u.badges.length - 3}</span>
                                )}
                              </div>
                            ) : (
                              <span className="text-xs text-slate-400">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <TierBadge tier={u.tier} until={u.tierUntil} />
                            {(!u.tier || u.tier === 'free') && (
                              <span className="text-xs text-slate-400">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-slate-700">{fmtNum(u.likes)}</TableCell>
                          <TableCell className="text-right tabular-nums text-slate-700">
                            {fmtNum(u.bookmarks)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-slate-700">
                            {fmtNum(u.views)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-slate-700">
                            {u.swipes != null ? fmtNum(u.swipes) : '—'}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-slate-700">
                            {u.balanceKop != null
                              ? (u.balanceKop / 100).toLocaleString('ru-RU', {
                                  minimumFractionDigits: 2,
                                  maximumFractionDigits: 2,
                                })
                              : '—'}
                          </TableCell>
                          <TableCell className="text-center">
                            {u.bannedAt ? (
                              <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700">бан</span>
                            ) : (
                              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">ок</span>
                            )}
                          </TableCell>
                          <TableCell className="text-center">
                            <Switch
                              checked={u.bypassMaintenance}
                              onCheckedChange={(v) => void toggleBypass(u, v)}
                              disabled={bypassBusy === u.id}
                              aria-label={`Допуск мимо техработ: ${displayName(u)}`}
                              className="mx-auto"
                            />
                          </TableCell>
                          <TableCell className="text-center">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openAction(u)}
                              aria-label={`Действия: ${displayName(u)}`}
                              className={cn('h-7 gap-1 px-2 text-xs', btnOutlineDark)}
                            >
                              <Settings2 className="size-3.5" aria-hidden /> Действия
                            </Button>
                          </TableCell>
                          <TableCell className="text-sm text-slate-500">{fmtAgo(u.createdAt)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>

              {/* Мобильные: карточки */}
              <div className="space-y-2 md:hidden">
                {data.items.map((u) => (
                  <div key={u.id} className="rounded-xl border border-slate-200 bg-white p-3.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-sm font-medium text-slate-900">{displayName(u)}</span>
                          <UserKindBadge isGuest={u.isGuest} />
                          <TierBadge tier={u.tier} until={u.tierUntil} />
                          {u.isPremium && (
                            <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-700">
                              TG Premium
                            </span>
                          )}
                          {u.bannedAt && (
                            <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700">
                              бан
                            </span>
                          )}
                        </div>
                        {u.badges && u.badges.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {u.badges.map((slug) => (
                              <AdminBadgeChip key={slug} slug={slug} />
                            ))}
                          </div>
                        )}
                        <span className="block truncate font-mono text-[11px] text-slate-500">{u.id}</span>
                      </div>
                      <Switch
                        checked={u.bypassMaintenance}
                        onCheckedChange={(v) => void toggleBypass(u, v)}
                        disabled={bypassBusy === u.id}
                        aria-label={`Допуск мимо техработ: ${displayName(u)}`}
                      />
                    </div>
                    <div className="mt-2 grid grid-cols-5 gap-1 text-center">
                      {(
                        [
                          ['Лайки', u.likes],
                          ['Закл.', u.bookmarks],
                          ['Взгл.', u.views],
                          ['Свайпы', u.swipes ?? 0],
                          ['Рубли', u.balanceKop != null ? u.balanceKop / 100 : 0],
                        ] as const
                      ).map(([label, v]) => (
                        <div key={label} className="rounded-lg bg-slate-50 py-1">
                          <div className="text-sm font-semibold tabular-nums text-slate-800">
                            {label === 'Рубли' ? Number(v).toFixed(2) : fmtNum(v)}
                          </div>
                          <div className="text-[11px] text-slate-500">{label}</div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-1.5 text-[11px] text-slate-500">
                      {u.username ? `@${u.username} · ` : ''}регистрация {fmtAgo(u.createdAt)}
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openAction(u)}
                        aria-label={`Действия: ${displayName(u)}`}
                        className={cn('h-7 gap-1 px-2 text-xs', btnOutlineDark)}
                      >
                        <Settings2 className="size-3.5" aria-hidden /> Действия
                      </Button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-4">
                <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onChange={setPage} />
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      {/* Модалка действий v5.62: sticky-шапка + 2 колонки карточек (подписка/бейджи | балансы/модерация) */}
      {actionUser && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center md:p-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby="user-action-title"
          onClick={() => !actionBusy && setActionUser(null)}
        >
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="flex max-h-[92dvh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-slate-200 bg-white shadow-xl md:max-h-[86dvh] md:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* ===== Sticky-шапка: аватар, имя, ID, бейджи ===== */}
            <header className="flex shrink-0 items-start gap-3 border-b border-slate-200 bg-white px-4 py-3.5 md:px-5">
              <Avatar
                color={avatarColorFor(actionUser.id)}
                title={displayName(actionUser)}
                className="size-10 text-base"
              />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <p
                    id="user-action-title"
                    className="truncate text-sm font-semibold text-slate-900 md:text-[15px]"
                  >
                    {displayName(actionUser)}
                  </p>
                  {actionUser.username && (
                    <span className="truncate text-xs text-slate-500">@{actionUser.username}</span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="inline-flex items-center gap-0.5 font-mono text-[11px] text-slate-500">
                    {actionUser.id}
                    <button
                      type="button"
                      onClick={() => copyUserId(actionUser.id)}
                      aria-label="Скопировать ID"
                      title="Скопировать ID"
                      className="rounded p-0.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-900"
                    >
                      <Copy className="size-3" aria-hidden />
                    </button>
                  </span>
                  <UserKindBadge isGuest={actionUser.isGuest} />
                  <TierBadge tier={actionUser.tier} until={actionUser.tierUntil} />
                  {actionUser.isPremium && (
                    <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-700">
                      TG Premium
                    </span>
                  )}
                  {actionUser.bannedAt && (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700">
                      бан
                    </span>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => !actionBusy && setActionUser(null)}
                disabled={actionBusy}
                aria-label="Закрыть"
                className="-mr-1 rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-900"
              >
                <X className="size-4" aria-hidden />
              </button>
            </header>

            {/* ===== Тело: грид карточек, скролл под шапкой ===== */}
            <div className="admin-scroll min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
              <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-2 md:gap-4">
                {/* Левая колонка: подписка + бейджи */}
                <div className="space-y-3 md:space-y-4">

                  {/* ===== v5.18: Подписка Snap Plus/Pro ===== */}
                  <SectionCard
                    icon={Gift}
                    tone="emerald"
                    title="Подписка Snap"
                    right={
                      actionUser.tier && actionUser.tier !== 'free' && actionUser.tierUntil ? (
                        <span className="text-[11px] text-slate-500">
                          до {new Date(actionUser.tierUntil).toLocaleDateString('ru-RU')}
                        </span>
                      ) : undefined
                    }
                    footer={
                      <p className="text-[11px] leading-snug text-slate-500">
                        Продление того же тарифа суммируется с текущим сроком. Отзыв сбрасывает тир в free.
                      </p>
                    }
                  >
                    {/* План: Plus / Pro — выбираемые плитки */}
                    <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Тариф подписки">
                      {(['plus', 'pro'] as const).map((p) => {
                        const active = tierPlan === p
                        return (
                          <button
                            key={p}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            disabled={actionBusy}
                            onClick={() => setTierPlan(p)}
                            className={cn(
                              'relative rounded-lg border px-3 py-2 text-left transition',
                              active
                                ? p === 'pro'
                                  ? 'border-amber-300 bg-amber-50 ring-1 ring-amber-300'
                                  : 'border-emerald-300 bg-emerald-50/70 ring-1 ring-emerald-300'
                                : 'border-slate-200 bg-white hover:border-slate-300',
                            )}
                          >
                            {active && (
                              <Check
                                className={cn(
                                  'absolute right-2 top-2 size-3.5',
                                  p === 'pro' ? 'text-amber-600' : 'text-emerald-600',
                                )}
                                aria-hidden
                              />
                            )}
                            <span
                              className={cn(
                                'flex items-center gap-1.5 text-sm font-semibold',
                                p === 'pro' ? 'text-amber-700' : 'text-emerald-700',
                              )}
                            >
                              <Gem className="size-3.5" aria-hidden /> {p === 'pro' ? 'Snap Pro' : 'Snap Plus'}
                            </span>
                            <span className="mt-0.5 block text-[11px] leading-snug text-slate-500">
                              {p === 'pro' ? 'Snap Ассистент, продвижение' : 'Безлимит Snap Search, инкогнито'}
                            </span>
                          </button>
                        )
                      })}
                    </div>

                    {/* Срок: чипы-сегменты + свой ввод + «навсегда» */}
                    <div className="mt-3">
                      <label className="text-xs font-semibold text-slate-700" htmlFor="tier-days">
                        <CalendarClock className="mr-1 inline size-3.5" aria-hidden /> Срок, дней
                      </label>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {[1, 7, 30, 90, 180, 365].map((d) => (
                          <button
                            key={d}
                            type="button"
                            disabled={actionBusy || tierForever}
                            onClick={() => {
                              setTierDays(String(d))
                              setTierForever(false)
                            }}
                            className={cn(
                              'rounded-lg border px-2.5 py-1 text-xs font-medium tabular-nums transition',
                              !tierForever && Number(tierDays) === d
                                ? 'border-emerald-300 bg-emerald-100 text-emerald-800'
                                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                              tierForever && 'opacity-40',
                            )}
                          >
                            {d === 1 ? 'сутки' : `${d}д`}
                          </button>
                        ))}
                        <Input
                          id="tier-days"
                          type="number"
                          min={1}
                          max={36500}
                          value={tierForever ? '' : tierDays}
                          disabled={actionBusy || tierForever}
                          onChange={(e) => setTierDays(e.target.value)}
                          className={cn('h-8 w-20 text-sm tabular-nums', inputDark)}
                          aria-label="Срок подписки в днях"
                        />
                        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-600">
                          <input
                            type="checkbox"
                            checked={tierForever}
                            disabled={actionBusy}
                            onChange={(e) => setTierForever(e.target.checked)}
                            className="size-3.5 accent-emerald-600"
                          />
                          навсегда
                        </label>
                      </div>
                    </div>

                    {/* Причина (необязательно) */}
                    <Input
                      value={tierReason}
                      onChange={(e) => setTierReason(e.target.value)}
                      placeholder="Заметка: бонус, компенсация…"
                      maxLength={200}
                      disabled={actionBusy}
                      className={cn('mt-3 h-9 text-sm', inputDark)}
                      aria-label="Заметка к выдаче подписки"
                    />

                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <Button
                        size="sm"
                        disabled={actionBusy || (!tierForever && (Number(tierDays) || 0) < 1)}
                        onClick={() =>
                          actionUser &&
                          void runUserAction(
                            actionUser,
                            { action: 'tier', userId: actionUser.id, tier: tierPlan, days: grantDays, mode: 'grant' },
                            `${tierPlan === 'pro' ? 'Snap Pro' : 'Snap Plus'} выдан на ${tierForever ? 'всё время' : `${grantDays} дн.`}`,
                            {
                              tier: tierPlan,
                              tierUntil: new Date(
                                Math.max(Date.now(), actionUser.tierUntil ? new Date(actionUser.tierUntil).getTime() : 0) +
                                  grantDays * 86_400_000,
                              ).toISOString(),
                            },
                          )
                        }
                        className="h-9 bg-emerald-600 text-white hover:bg-emerald-700"
                      >
                        <Gift className="size-4" aria-hidden />
                        {actionUser.tier === tierPlan && actionUser.tierUntil ? 'Продлить' : 'Выдать'}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={actionBusy || !actionUser.tier || actionUser.tier === 'free'}
                        onClick={() =>
                          actionUser &&
                          void runUserAction(
                            actionUser,
                            { action: 'tier', userId: actionUser.id, mode: 'revoke' },
                            'Подписка отозвана',
                            { tier: 'free', tierUntil: null },
                          )
                        }
                        className={cn('h-9 hover:bg-red-50 hover:text-red-700', btnOutlineDark)}
                      >
                        <Trash2 className="size-4" aria-hidden /> Отозвать
                      </Button>
                    </div>
                  </SectionCard>

                  {/* ===== v5.19: Бейджи (разработчик/менеджер/…) — клик выдаёт/снимает ===== */}
                  <SectionCard
                    icon={BadgeCheck}
                    tone="violet"
                    title="Бейджи"
                    hint="Клик по цветному — снять, по серому — выдать"
                    right={
                      actionUser.badges && actionUser.badges.length > 0 ? (
                        <span className="text-[11px] font-semibold text-violet-700">
                          {actionUser.badges.length} шт.
                        </span>
                      ) : undefined
                    }
                    footer={
                      <p className="text-[11px] leading-snug text-slate-500">
                        Юзер получает уведомление, бейдж виден у имени в комментариях и профиле.
                      </p>
                    }
                  >
                    <div className="flex flex-wrap gap-1.5">
                      {BADGE_LIST.map((b) => {
                        const has = actionUser.badges?.includes(b.slug) ?? false
                        const Icon = BADGE_ICONS[b.icon]
                        return (
                          <button
                            key={b.slug}
                            type="button"
                            disabled={actionBusy}
                            aria-pressed={has}
                            title={has ? 'Снять бейдж' : 'Выдать бейдж'}
                            onClick={() =>
                              actionUser &&
                              void runUserAction(
                                actionUser,
                                { action: 'badge', userId: actionUser.id, badge: b.slug, mode: has ? 'revoke' : 'grant' },
                                has ? `Бейдж «${b.label}» снят` : `Бейдж «${b.label}» выдан`,
                                {
                                  badges: has
                                    ? (actionUser.badges ?? []).filter((x) => x !== b.slug)
                                    : [...(actionUser.badges ?? []), b.slug],
                                },
                              )
                            }
                            className={cn(
                              'inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition',
                              has
                                ? `${b.solid} border-transparent`
                                : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:text-slate-700',
                            )}
                          >
                            <Icon className="size-3.5" aria-hidden />
                            {b.label}
                          </button>
                        )
                      })}
                    </div>
                  </SectionCard>
                </div>

                {/* Правая колонка: балансы + модерация */}
                <div className="space-y-3 md:space-y-4">

                  {/* Баланс свайпов */}
                  <SectionCard
                    icon={Wallet}
                    tone="slate"
                    title="Баланс свайпов"
                    hint="Абсолютное значение, не дельта"
                    right={
                      <div>
                        <div className="text-sm font-semibold tabular-nums text-slate-900">
                          {fmtNum(actionUser.swipes ?? 0)}
                        </div>
                        <div className="text-[11px] text-slate-500">сейчас</div>
                      </div>
                    }
                  >
                    <div className="flex gap-2">
                      <Input
                        id="swipes-input"
                        type="number"
                        min={0}
                        max={10000000}
                        value={swipesInput}
                        onChange={(e) => setSwipesInput(e.target.value)}
                        className={cn('h-9 flex-1 text-sm tabular-nums', inputDark)}
                        aria-label="Новый баланс свайпов"
                      />
                      <Button
                        size="sm"
                        disabled={actionBusy || swipesInput === '' || Number(swipesInput) === actionUser.swipes}
                        onClick={() =>
                          actionUser &&
                          void runUserAction(
                            actionUser,
                            { action: 'swipes', userId: actionUser.id, swipes: Number(swipesInput) },
                            `Баланс изменён на ${fmtNum(Number(swipesInput))} свайпов`,
                            { swipes: Number(swipesInput) },
                          )
                        }
                        className="h-9 shrink-0 bg-emerald-600 px-3 text-white hover:bg-emerald-700"
                      >
                        Сохранить
                      </Button>
                    </div>
                  </SectionCard>

                  {/* Баланс рублей (v5.61) */}
                  <SectionCard
                    icon={Banknote}
                    tone="emerald"
                    title="Баланс рублей — кошелёк"
                    right={
                      <div>
                        <div className="text-sm font-semibold tabular-nums text-slate-900">
                          {((actionUser.balanceKop ?? 0) / 100).toLocaleString('ru-RU', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}{' '}
                          ₽
                        </div>
                        <div className="text-[11px] text-slate-500">сейчас</div>
                      </div>
                    }
                    footer={
                      <p className="text-[11px] leading-snug text-slate-500">
                        Компенсации и корректировки кошелька. Юзер увидит операцию в истории кошелька.
                      </p>
                    }
                  >
                    <div className="flex gap-2">
                      <Input
                        id="balance-input"
                        type="number"
                        min={0}
                        max={1000000}
                        step={0.01}
                        value={balanceInput}
                        onChange={(e) => setBalanceInput(e.target.value)}
                        className={cn('h-9 flex-1 text-sm tabular-nums', inputDark)}
                        aria-label="Новый рублёвый баланс в рублях"
                        placeholder="0.00"
                      />
                      <Button
                        size="sm"
                        disabled={actionBusy || balanceInput === '' || Math.round(Number(balanceInput.replace(',', '.')) * 100) === (actionUser.balanceKop ?? 0)}
                        onClick={() => {
                          const kop = Math.round(Number(balanceInput.replace(',', '.')) * 100)
                          if (!Number.isFinite(kop) || kop < 0) return
                          if (actionUser)
                            void runUserAction(
                              actionUser,
                              { action: 'balance', userId: actionUser.id, balanceKop: kop },
                              `Рублёвый баланс изменён на ${(kop / 100).toFixed(2)} ₽`,
                              { balanceKop: kop },
                            )
                        }}
                        className="h-9 shrink-0 bg-emerald-600 px-3 text-white hover:bg-emerald-700"
                      >
                        Сохранить
                      </Button>
                    </div>
                  </SectionCard>

                  {/* ===== Модерация: TG Premium + бан/разбан (danger zone) ===== */}
                  <SectionCard icon={ShieldCheck} tone="red" title="Модерация" hint="Флаг TG Premium, бан и разбан">
                    {/* Telegram Premium (флаг) */}
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                        <Gem className="size-3.5 text-sky-600" aria-hidden /> TG Premium
                      </span>
                      {actionUser.isPremium ? (
                        <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-700">
                          активен
                        </span>
                      ) : (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
                          нет
                        </span>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={actionBusy}
                      onClick={() =>
                        actionUser &&
                        void runUserAction(
                          actionUser,
                          { action: 'premium', userId: actionUser.id },
                          actionUser.isPremium ? 'TG Premium снят' : 'TG Premium выдан',
                          { isPremium: !actionUser.isPremium },
                        )
                      }
                      className={cn('mt-2 w-full', btnOutlineDark)}
                    >
                      <Gem className="size-4" aria-hidden />
                      {actionUser.isPremium ? 'Снять флаг TG Premium' : 'Поставить флаг TG Premium'}
                    </Button>

                    {/* Бан/разбан — danger zone */}
                    <div className="mt-4">
                      {!actionUser.bannedAt ? (
                        <div className="rounded-lg border border-red-200 bg-red-50 p-3">
                          <label className="text-xs font-semibold text-red-700" htmlFor="ban-reason">
                            <Ban className="mr-1 inline size-3.5" aria-hidden /> Причина бана
                          </label>
                          <Input
                            id="ban-reason"
                            value={banReason}
                            onChange={(e) => setBanReason(e.target.value)}
                            placeholder="спам, абьюз…"
                            maxLength={200}
                            className={cn('mt-1.5 h-9 text-sm', inputDark)}
                          />
                          <Button
                            size="sm"
                            disabled={actionBusy || banReason.trim().length === 0}
                            onClick={() =>
                              actionUser &&
                              void runUserAction(
                                actionUser,
                                { action: 'ban', userId: actionUser.id, reason: banReason.trim() },
                                'Пользователь забанен — API отвечает ему 403',
                                { bannedAt: new Date().toISOString(), banReason: banReason.trim() },
                              )
                            }
                            className="mt-2 w-full bg-red-600 text-white hover:bg-red-700"
                          >
                            <Ban className="size-4" aria-hidden /> Забанить пользователя
                          </Button>
                        </div>
                      ) : (
                        <div className="rounded-lg border border-red-200 bg-red-50 p-3">
                          <p className="flex items-center gap-1.5 text-xs font-semibold text-red-700">
                            <Ban className="size-3.5" aria-hidden /> Пользователь забанен
                          </p>
                          {actionUser.banReason && (
                            <p className="mt-1 text-xs leading-snug text-red-600">
                              Причина: {actionUser.banReason}
                            </p>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={actionBusy}
                            onClick={() =>
                              actionUser &&
                              void runUserAction(
                                actionUser,
                                { action: 'unban', userId: actionUser.id },
                                'Пользователь разбанен',
                                { bannedAt: null, banReason: null },
                              )
                            }
                            className={cn('mt-2 w-full', btnOutlineDark)}
                          >
                            <ShieldOff className="size-4" aria-hidden /> Разбанить
                          </Button>
                        </div>
                      )}
                      <p className="mt-2 text-[11px] leading-snug text-slate-500">
                        Бан блокирует весь API (лента, комментарии, платежи) через Edge-зеркало; вход в миниапп
                        остаётся, чтобы пользователь видел бан.
                      </p>
                    </div>
                  </SectionCard>
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </motion.div>
  )
}
