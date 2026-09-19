'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle, History, RefreshCw, ScrollText } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

import { fetchAudit, fmtAgo, isAuthOrNetworkError, PanelError, type AuditGroup, type AuditResponse } from './api'
import { EmptyState, Pagination, SkeletonRows, TabProps, btnOutlineDark, fadeUp, panelCard } from './bits'

/** Человекочитаемые названия действий (дублируют src/lib/admin-log.ts) */
const ACTION_META: Record<string, { label: string; cls: string }> = {
  tier_grant: { label: 'Выдана подписка', cls: 'bg-emerald-100 text-emerald-700' },
  tier_extend: { label: 'Продлена подписка', cls: 'bg-emerald-50 text-emerald-700' },
  tier_revoke: { label: 'Отозвана подписка', cls: 'bg-red-100 text-red-700' },
  premium_on: { label: 'TG Premium вкл', cls: 'bg-sky-100 text-sky-700' },
  premium_off: { label: 'TG Premium выкл', cls: 'bg-slate-100 text-slate-600' },
  swipes: { label: 'Баланс свайпов', cls: 'bg-violet-100 text-violet-700' },
  ban: { label: 'Бан', cls: 'bg-red-100 text-red-700' },
  unban: { label: 'Разбан', cls: 'bg-emerald-50 text-emerald-700' },
  bypass_on: { label: 'Допуск вкл', cls: 'bg-amber-100 text-amber-700' },
  bypass_off: { label: 'Допуск выкл', cls: 'bg-slate-100 text-slate-600' },
  ops: { label: 'Операция', cls: 'bg-slate-100 text-slate-600' },
  moderation: { label: 'Модерация', cls: 'bg-amber-50 text-amber-700' },
  comment: { label: 'Комментарий', cls: 'bg-slate-100 text-slate-600' },
}

const GROUPS: Array<{ key: AuditGroup; label: string }> = [
  { key: 'all', label: 'Всё' },
  { key: 'tier', label: 'Подписки' },
  { key: 'users', label: 'Пользователи' },
  { key: 'moderation', label: 'Модерация' },
]

function MetaChips({ meta }: { meta: Record<string, unknown> | null }) {
  if (!meta) return null
  const chips: string[] = []
  for (const [k, v] of Object.entries(meta)) {
    if (v === null || v === undefined) continue
    if (k === 'reason' && typeof v === 'string') chips.push(`«${v}»`)
    else if (k === 'until' && typeof v === 'string') chips.push(`до ${new Date(v).toLocaleDateString('ru-RU')}`)
    else if (k === 'days') chips.push(`${v} дн.`)
    else if (typeof v === 'string' || typeof v === 'number') chips.push(`${k}: ${v}`)
  }
  if (chips.length === 0) return null
  return (
    <span className="flex flex-wrap gap-1">
      {chips.map((c, i) => (
        <span key={i} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
          {c}
        </span>
      ))}
    </span>
  )
}

export function AuditTab({ tick, onSettled }: TabProps) {
  const [group, setGroup] = useState<AuditGroup>('all')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<AuditResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [localTick, setLocalTick] = useState(0)

  useEffect(() => {
    let alive = true
    const run = async () => {
      try {
        const d = await fetchAudit(group, page)
        if (!alive) return
        setData(d)
        setError(null)
        setLoading(false)
      } catch (e) {
        if (!alive || isAuthOrNetworkError(e)) return
        const msg = e instanceof PanelError ? e.message : 'Ошибка загрузки'
        if (data) setError(msg)
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
     
  }, [group, page, tick, localTick])

  return (
    <motion.div variants={fadeUp} initial="hidden" animate="show">
      <Card className={panelCard}>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base text-slate-900">
                <History className="size-4 text-slate-500" aria-hidden /> Журнал действий
              </CardTitle>
              <CardDescription className="text-xs text-slate-500">
                Аудит панели: кто и когда выдал подписку, забанил, поменял баланс
              </CardDescription>
            </div>
            <div className="flex gap-1.5" role="group" aria-label="Фильтр журнала">
              {GROUPS.map((g) => (
                <button
                  key={g.key}
                  type="button"
                  onClick={() => {
                    setGroup(g.key)
                    setPage(1)
                  }}
                  aria-pressed={group === g.key}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                    group === g.key
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                  )}
                >
                  {g.label}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading && !data ? (
            <SkeletonRows rows={8} />
          ) : error && !data ? (
            <EmptyState
              icon={AlertTriangle}
              title="Не удалось загрузить журнал"
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
              icon={ScrollText}
              title="Журнал пуст"
              hint="Здесь появятся все действия из панели: выдача подписок, баны, операции"
            />
          ) : data ? (
            <>
              {/* Счётчики по типам действий */}
              <div className="mb-3 flex flex-wrap gap-1.5">
                {Object.entries(data.byAction).map(([action, n]) => {
                  const meta = ACTION_META[action] ?? { label: action, cls: 'bg-slate-100 text-slate-600' }
                  return (
                    <span
                      key={action}
                      className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums', meta.cls)}
                    >
                      {meta.label}: {n}
                    </span>
                  )
                })}
              </div>

              <div className="admin-scroll max-h-[560px] space-y-1.5 overflow-y-auto">
                {data.items.map((l) => {
                  const meta = ACTION_META[l.action] ?? { label: l.action, cls: 'bg-slate-100 text-slate-600' }
                  return (
                    <div
                      key={l.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-slate-100 bg-white px-3 py-2"
                    >
                      <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold', meta.cls)}>
                        {meta.label}
                      </span>
                      <span className="max-w-[240px] truncate font-mono text-[11px] text-slate-500" title={l.target}>
                        {l.target}
                      </span>
                      <MetaChips meta={l.meta} />
                      <span className="ml-auto shrink-0 text-[11px] text-slate-400">{fmtAgo(l.createdAt)}</span>
                    </div>
                  )
                })}
              </div>

              <div className="mt-4">
                <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onChange={setPage} />
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>
    </motion.div>
  )
}
