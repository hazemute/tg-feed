'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Banknote, Megaphone, TrendingUp, Users, Activity, Wallet, RefreshCw, AlertTriangle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import {
  fetchFinance,
  isAuthOrNetworkError,
  fmtNum,
  PanelError,
  type FinanceResponse,
} from './api'
import { EmptyState, btnOutlineDark, fadeUp, panelCard } from './bits'

/** Копейки → «1 234 ₽» */
function fmtRub(kop: number): string {
  return `${(kop / 100).toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽`
}

/** Простая столбчатая диаграмма на CSS (без чарт-библиотек) */
function MiniBars({
  data,
  valueKey,
  accent,
  format,
}: {
  data: Array<{ day: string; [k: string]: string | number }>
  valueKey: string
  accent: string
  format?: (v: number) => string
}) {
  const max = Math.max(1, ...data.map((d) => Number(d[valueKey] ?? 0)))
  if (data.length === 0) {
    return <p className="py-8 text-center text-xs text-slate-400">Пока нет данных</p>
  }
  return (
    <div>
      <div className="flex h-28 items-end gap-[3px]">
        {data.map((d) => {
          const v = Number(d[valueKey] ?? 0)
          return (
            <div
              key={d.day}
              title={`${d.day}: ${format ? format(v) : fmtNum(v)}`}
              className="group relative flex-1 rounded-t-sm transition-opacity hover:opacity-80"
              style={{ height: `${Math.max(4, (v / max) * 100)}%`, backgroundColor: accent, minWidth: 4 }}
            />
          )
        })}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-slate-400">
        <span>{data[0]?.day.slice(5)}</span>
        <span>{data[data.length - 1]?.day.slice(5)}</span>
      </div>
    </div>
  )
}

function StatCard({
  icon: Icon,
  title,
  value,
  hint,
  tone,
}: {
  icon: typeof Banknote
  title: string
  value: string
  hint?: string
  tone?: 'green' | 'amber' | 'sky'
}) {
  return (
    <Card className={cn(panelCard)}>
      <CardContent className="p-4">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'flex size-8 items-center justify-center rounded-lg',
              tone === 'green' && 'bg-emerald-100 text-emerald-700',
              tone === 'amber' && 'bg-amber-100 text-amber-700',
              tone === 'sky' && 'bg-sky-100 text-sky-700',
              !tone && 'bg-slate-100 text-slate-700',
            )}
          >
            <Icon className="size-4" aria-hidden />
          </span>
          <span className="text-xs font-medium text-slate-500">{title}</span>
        </div>
        <p className="mt-2 text-xl font-bold tabular-nums text-slate-900">{value}</p>
        {hint && <p className="mt-0.5 text-[11px] text-slate-400">{hint}</p>}
      </CardContent>
    </Card>
  )
}

const PROVIDER_LABEL: Record<string, string> = {
  yookassa: 'ЮKassa (карта)',
  stars: 'Telegram Stars',
  ton: 'TON',
}

export function FinanceTab({ tick, onSettled }: { tick: number; onSettled?: () => void }) {
  const [data, setData] = useState<FinanceResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    const run = async () => {
      try {
        const d = await fetchFinance()
        if (!alive) return
        setData(d)
        setError(null)
        setLoading(false)
      } catch (e) {
        if (!alive || isAuthOrNetworkError(e)) return
        setError(e instanceof PanelError ? e.message : 'Ошибка загрузки')
        setLoading(false)
      } finally {
        if (alive) onSettled?.()
      }
    }
    void run()
    return () => {
      alive = false
    }
  }, [tick, onSettled])

  const eng = data?.engagement
  const maxEngagement = Math.max(1, eng?.mau ?? 1)

  return (
    <motion.div variants={fadeUp} initial="hidden" animate="show" className="space-y-4">
      {loading && !data ? (
        <Card className={panelCard}>
          <CardContent className="flex items-center justify-center py-12">
            <RefreshCw className="size-6 animate-spin text-slate-300" aria-hidden />
          </CardContent>
        </Card>
      ) : error && !data ? (
        <Card className={panelCard}>
          <CardContent className="py-6">
            <EmptyState
              icon={AlertTriangle}
              title="Не удалось загрузить финансы"
              hint={error}
              action={
                <Button variant="outline" size="sm" className={btnOutlineDark} onClick={() => location.reload()}>
                  <RefreshCw aria-hidden /> Обновить страницу
                </Button>
              }
            />
          </CardContent>
        </Card>
      ) : data ? (
        <>
          {/* Деньги */}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              icon={Banknote}
              title="Заработано всего"
              value={fmtRub(data.revenue.totalKop)}
              hint={`${fmtNum(data.revenue.paymentsCount)} успешных платежей`}
              tone="green"
            />
            <StatCard
              icon={Megaphone}
              title="Рекламная выручка"
              value={fmtRub(data.ads.spentKop)}
              hint={`${fmtNum(data.ads.campaigns)} кампаний`}
              tone="amber"
            />
            <StatCard
              icon={Wallet}
              title="Балансы пользователей"
              value={fmtRub(data.liabilities.balanceKop)}
              hint={`${fmtNum(data.liabilities.accounts)} кошельков · обязательства`}
            />
            <StatCard
              icon={TrendingUp}
              title="Выручка за 30 дней"
              value={fmtRub(data.revenue.byDay.reduce((a, d) => a + d.kop, 0))}
              hint={`${fmtNum(data.revenue.byDay.reduce((a, d) => a + d.count, 0))} платежей`}
              tone="sky"
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Платежи по дням */}
            <Card className={cn(panelCard)}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base text-slate-900">Платежи по дням (30 дней)</CardTitle>
                <CardDescription className="text-xs text-slate-500">успешные оплаты, ₽</CardDescription>
              </CardHeader>
              <CardContent>
                <MiniBars data={data.revenue.byDay} valueKey="kop" accent="#10b981" format={fmtRub} />
                <div className="mt-4 space-y-1.5">
                  {data.revenue.byProvider.length === 0 ? (
                    <p className="text-xs text-slate-400">Платежей ещё не было</p>
                  ) : (
                    data.revenue.byProvider.map((p) => (
                      <div key={p.provider} className="flex items-center justify-between text-xs">
                        <span className="text-slate-600">{PROVIDER_LABEL[p.provider] ?? p.provider}</span>
                        <span className="font-semibold tabular-nums text-slate-900">
                          {fmtRub(p.kop)} · {fmtNum(p.count)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Вовлечённость */}
            <Card className={cn(panelCard)}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-1.5 text-base text-slate-900">
                  <Activity className="size-4 text-sky-600" aria-hidden /> Вовлечённость
                </CardTitle>
                <CardDescription className="text-xs text-slate-500">
                  активные читатели (уникальные пользователи с просмотрами)
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      ['DAU', eng?.dau ?? 0, eng ? Math.round((eng.dau / maxEngagement) * 100) : 0],
                      ['WAU', eng?.wau ?? 0, eng ? Math.round((eng.wau / maxEngagement) * 100) : 0],
                      ['MAU', eng?.mau ?? 0, 100],
                    ] as const
                  ).map(([label, v, pct]) => (
                    <div key={label} className="rounded-lg bg-slate-50 p-3 text-center">
                      <p className="text-lg font-bold tabular-nums text-slate-900">{fmtNum(v)}</p>
                      <p className="text-[11px] font-semibold text-slate-500">{label}</p>
                      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-200">
                        <div className="h-full rounded-full bg-sky-500" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
                <div>
                  <p className="mb-1 flex items-center gap-1 text-xs font-semibold text-slate-700">
                    <Users className="size-3.5 text-slate-400" aria-hidden /> Новые пользователи (14 дней)
                  </p>
                  <MiniBars data={eng?.newUsersByDay ?? []} valueKey="count" accent="#64748b" />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <p className="mb-1 text-xs font-semibold text-slate-700">Лайки (14 дней)</p>
                    <MiniBars data={eng?.likesByDay ?? []} valueKey="count" accent="#f43f5e" />
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-semibold text-slate-700">Комментарии (14 дней)</p>
                    <MiniBars data={eng?.commentsByDay ?? []} valueKey="count" accent="#6366f1" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}
    </motion.div>
  )
}
