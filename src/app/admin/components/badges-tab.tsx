'use client'

/**
 * Вкладка «Бейджи» (v5.19): центр выдачи статусов пользователям.
 *  - карточки по каждому виду бейджа (цвет, держателей);
 *  - быстрая выдача/снятие по @username или ID (+ причина, уведомление юзеру);
 *  - список держателей с точечным снятием;
 *  - лента последних операций (badge_grant/badge_revoke).
 */

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  AlertTriangle,
  BadgeCheck,
  BellOff,
  ClipboardCheck,
  Code2,
  Crown,
  HeartHandshake,
  RefreshCw,
  Search,
  SearchX,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { BADGES, BADGE_LIST, type BadgeSlug } from '@/lib/badges'

import {
  badgeAction,
  fetchBadges,
  fmtAgo,
  isAuthOrNetworkError,
  PanelError,
  type BadgesResponse,
} from './api'
import {
  EmptyState,
  Pagination,
  SkeletonRows,
  TabProps,
  btnOutlineDark,
  fadeUp,
  inputDark,
  panelCard,
  useDebouncedValue,
} from './bits'

const ICONS = {
  Code2,
  ClipboardCheck,
  ShieldCheck,
  HeartHandshake,
  Crown,
  Sparkles,
} as const

export function BadgesTab({ tick, onSettled }: TabProps) {
  const [badgeFilter, setBadgeFilter] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const debouncedQ = useDebouncedValue(q, 400)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<BadgesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [localTick, setLocalTick] = useState(0)
  const [busy, setBusy] = useState(false)

  // Форма быстрой выдачи
  const [handle, setHandle] = useState('')
  const [formBadge, setFormBadge] = useState<BadgeSlug>('developer')
  const [reason, setReason] = useState('')
  const [notify, setNotify] = useState(true)

  const load = async () => {
    try {
      const d = await fetchBadges({ badge: badgeFilter ?? undefined, q: debouncedQ, page })
      setData(d)
      setError(null)
      setLoading(false)
    } catch (e) {
      if (isAuthOrNetworkError(e)) return
      const msg = e instanceof PanelError ? e.message : 'Ошибка загрузки'
      if (data) toast.error(msg)
      else setError(msg)
      setLoading(false)
    } finally {
      onSettled()
    }
  }

  useEffect(() => {
    void load()
  }, [badgeFilter, debouncedQ, page, tick, localTick])

  const submit = async (mode: 'grant' | 'revoke') => {
    const h = handle.trim()
    if (!h) {
      toast.error('Укажите @username или ID пользователя')
      return
    }
    setBusy(true)
    try {
      const r = await badgeAction({
        handle: h.replace(/^@/, ''),
        badge: formBadge,
        mode,
        reason: reason.trim() || undefined,
        notify,
      })
      if (r.ok && 'unchanged' in r === false) {
        toast.success(
          mode === 'grant'
            ? `Бейдж «${BADGES[formBadge].label}» выдан`
            : `Бейдж «${BADGES[formBadge].label}» снят`,
        )
      } else {
        toast.info('У пользователя уже такое состояние')
      }
      setLocalTick((t) => t + 1)
    } catch (e) {
      if (!isAuthOrNetworkError(e)) {
        toast.error(e instanceof PanelError ? e.message : 'Не получилось')
      }
    } finally {
      setBusy(false)
    }
  }

  const revokeInline = async (userId: string, slug: string) => {
    setBusy(true)
    try {
      await badgeAction({ userId, badge: slug, mode: 'revoke' })
      toast.success(`Бейдж «${BADGES[slug as BadgeSlug]?.label ?? slug}» снят`)
      setLocalTick((t) => t + 1)
    } catch (e) {
      if (!isAuthOrNetworkError(e)) {
        toast.error(e instanceof PanelError ? e.message : 'Не получилось')
      }
    } finally {
      setBusy(false)
    }
  }

  const displayName = (u: BadgesResponse['items'][number]) =>
    [u.firstName, u.lastName].filter(Boolean).join(' ') || (u.username ? `@${u.username}` : u.id)

  return (
    <motion.div variants={fadeUp} initial="hidden" animate="show" className="space-y-4">
      {/* Карточки видов бейджей */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {BADGE_LIST.map((b) => {
          const Icon = ICONS[b.icon]
          const count = data?.counts[b.slug] ?? 0
          const active = badgeFilter === b.slug
          return (
            <button
              key={b.slug}
              type="button"
              onClick={() => {
                setBadgeFilter(active ? null : b.slug)
                setPage(1)
              }}
              aria-pressed={active}
              title={b.hint}
              className={cn(
                'rounded-xl border p-3 text-left transition',
                active
                  ? 'border-slate-300 bg-slate-50 ring-1 ring-slate-300'
                  : 'border-slate-200 bg-white hover:bg-slate-50',
              )}
            >
              <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold', b.solid)}>
                <Icon className="size-3" aria-hidden />
                {b.label}
              </span>
              <span className="mt-2 block text-xl font-bold tabular-nums text-slate-900">{count}</span>
              <span className="text-[11px] text-slate-500">держателей</span>
            </button>
          )
        })}
      </div>

      {/* Быстрая выдача/снятие */}
      <Card className={panelCard}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base text-slate-900">
            <BadgeCheck className="size-4 text-emerald-600" aria-hidden /> Быстрая выдача
          </CardTitle>
          <CardDescription className="text-xs text-slate-500">
            @username или ID (tg_… / guest_…) — бейдж сразу появится у имени в комментариях и профиле
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="text-xs font-semibold text-slate-700" htmlFor="badge-handle">
                Пользователь
              </label>
              <Input
                id="badge-handle"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder="@username или guest_… / tg_…"
                disabled={busy}
                className={cn('mt-1 h-9 text-sm', inputDark)}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-700" htmlFor="badge-reason">
                Причина (необязательно)
              </label>
              <Input
                id="badge-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="за поддержку, за баг-репорт…"
                maxLength={200}
                disabled={busy}
                className={cn('mt-1 h-9 text-sm', inputDark)}
              />
            </div>
          </div>

          {/* Выбор вида бейджа */}
          <div>
            <span className="text-xs font-semibold text-slate-700">Вид бейджа</span>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {BADGE_LIST.map((b) => {
                const Icon = ICONS[b.icon]
                return (
                  <button
                    key={b.slug}
                    type="button"
                    role="radio"
                    aria-checked={formBadge === b.slug}
                    disabled={busy}
                    onClick={() => setFormBadge(b.slug)}
                    title={b.hint}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold transition',
                      formBadge === b.slug
                        ? `${b.solid} border-transparent ring-2 ring-offset-1 ring-slate-300`
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                    )}
                  >
                    <Icon className="size-3.5" aria-hidden />
                    {b.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={busy || !handle.trim()}
              onClick={() => void submit('grant')}
              className="h-9 bg-emerald-600 text-white hover:bg-emerald-700"
            >
              <BadgeCheck className="size-4" aria-hidden /> Выдать
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !handle.trim()}
              onClick={() => void submit('revoke')}
              className={cn('h-9 hover:bg-red-50 hover:text-red-700', btnOutlineDark)}
            >
              Снять
            </Button>
            <label className="ml-1 flex cursor-pointer items-center gap-1.5 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={notify}
                disabled={busy}
                onChange={(e) => setNotify(e.target.checked)}
                className="size-3.5 accent-emerald-600"
              />
              уведомить пользователя <BellOff className={cn('size-3.5', notify && 'hidden')} aria-hidden />
            </label>
          </div>
        </CardContent>
      </Card>

      {/* Держатели */}
      <Card className={panelCard}>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base text-slate-900">
                Держатели{badgeFilter ? ` · ${BADGES[badgeFilter as BadgeSlug]?.label ?? badgeFilter}` : ''}
              </CardTitle>
              <CardDescription className="text-xs text-slate-500">
                Всего {data?.total ?? 0} · крестик снимает конкретный бейдж
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
                placeholder="ID, @username, имя"
                aria-label="Поиск держателей"
                className={cn('h-8 w-56 pl-8 text-sm', inputDark)}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading && !data ? (
            <SkeletonRows rows={6} />
          ) : error && !data ? (
            <EmptyState
              icon={AlertTriangle}
              title="Не удалось загрузить бейджи"
              hint={error}
              action={
                <Button variant="outline" size="sm" onClick={() => setLocalTick((t) => t + 1)} className={btnOutlineDark}>
                  <RefreshCw aria-hidden /> Повторить
                </Button>
              }
            />
          ) : data && data.items.length === 0 ? (
            <EmptyState
              icon={SearchX}
              title="Держателей не найдено"
              hint="Выдайте первый бейдж формой выше"
            />
          ) : data ? (
            <>
              <div className="admin-scroll max-h-[440px] overflow-auto rounded-md border border-slate-200">
                <table className="w-full text-sm">
                  <tbody>
                    {data.items.map((u) => (
                      <tr key={u.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                        <td className="max-w-[200px] px-3 py-2.5">
                          <p className="truncate font-medium text-slate-800">{displayName(u)}</p>
                          <p className="truncate font-mono text-[11px] text-slate-400">{u.id}</p>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex flex-wrap gap-1">
                            {u.badges.map((slug) => {
                              const b = BADGES[slug as BadgeSlug]
                              const Icon = b ? ICONS[b.icon] : ShieldCheck
                              return (
                                <span
                                  key={slug}
                                  className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-600"
                                >
                                  <Icon className="size-3" aria-hidden />
                                  {b?.label ?? slug}
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => void revokeInline(u.id, slug)}
                                    aria-label={`Снять бейдж ${b?.label ?? slug}`}
                                    className="ml-0.5 flex size-4 items-center justify-center rounded-full text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                                  >
                                    ×
                                  </button>
                                </span>
                              )
                            })}
                          </div>
                        </td>
                        <td className="hidden px-3 py-2.5 text-xs text-slate-400 md:table-cell">
                          {u.isGuest ? 'Гость' : 'Telegram'} · с {fmtAgo(u.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-4">
                <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onChange={setPage} />
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      {/* Последние операции */}
      {data && data.recent.length > 0 && (
        <Card className={panelCard}>
          <CardHeader>
            <CardTitle className="text-base text-slate-900">Последние операции</CardTitle>
            <CardDescription className="text-xs text-slate-500">Полная история — во вкладке «Журнал»</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1.5">
              {data.recent.map((r, i) => {
                const b = r.badge ? BADGES[r.badge as BadgeSlug] : null
                const Icon = b ? ICONS[b.icon] : BadgeCheck
                return (
                  <li key={i} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs">
                    <Icon className={cn('size-3.5 shrink-0', r.action === 'badge_grant' ? 'text-emerald-600' : 'text-red-500')} aria-hidden />
                    <span className="font-semibold text-slate-700">
                      {r.action === 'badge_grant' ? 'выдан' : 'снят'}
                      {b ? ` «${b.label}»` : ''}
                    </span>
                    <span className="truncate font-mono text-[11px] text-slate-500">{r.target}</span>
                    {r.reason && <span className="truncate text-slate-400">· {r.reason}</span>}
                    <span className="ml-auto shrink-0 text-slate-400">{fmtAgo(r.createdAt)}</span>
                  </li>
                )
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </motion.div>
  )
}
