'use client'

import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Bot, CheckCircle2, Loader2, Pause, Play, Sparkles } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

import { fmtNum, isAuthOrNetworkError, panelFetch, PanelError, type AutodiscoverState } from './api'
import { btnOutlineDark, fadeUp, panelCard } from './bits'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const MAX_NEW_OPTIONS = ['20', '60', '150', '300']
const MAX_LOG_LINES = 8

const SOURCE_OPTIONS = [
  { value: 'all', label: 'Все источники' },
  { value: 'tgstat', label: 'TGStat' },
  { value: 'combot', label: 'Combot' },
  { value: 'curated', label: 'Кураторский' },
] as const

/**
 * Карточка «Автосбор каналов»: одна кнопка — движок сам находит реальные
 * каналы (кураторский каталог + обход упоминаний в графе t.me), валидирует
 * каждый через Telegram, создаёт карточки и складывает настоящие посты в ленту.
 * Цикл шагов ведёт клиент: каждый шаг обрабатывает до 3 кандидатов — укладывается
 * в серверлес-лимиты и живёт в Redis (переживает холодные старты).
 */
export function AutoparseCard({ onChanged }: { onChanged?: () => void }) {
  const [state, setState] = useState<AutodiscoverState | null>(null)
  const [running, setRunning] = useState(false)
  const [maxNew, setMaxNew] = useState('60')
  const [source, setSource] = useState('all')
  const stopRef = useRef(false)

  // восстановление вкладки: если сбор идёт — подхватить цикл
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await panelFetch<{ ok: boolean; state: AutodiscoverState | null }>(
          '/api/panel/autoparse',
        )
        if (!alive || !res.state) return
        setState(res.state)
        if (res.state.running) void driveLoop(true)
      } catch {
        /* панель только открылась — тихо */
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const step = async (action: 'start' | 'step' | 'stop'): Promise<AutodiscoverState> => {
    const res = await panelFetch<{ ok: boolean; state: AutodiscoverState | null }>(
      '/api/panel/autoparse',
      {
        json: {
          action,
          ...(action === 'start'
            ? { maxNew: Number(maxNew) || 60, source: source as AutodiscoverState['source'] }
            : {}),
        },
      },
    )
    if (!res.state) throw new Error('сбор не запускался')
    return res.state
  }

  /** Ведёт цикл шагов до завершения/остановки; при сетевой ошибке — 3 повтора */
  const driveLoop = async (resume = false) => {
    if (running) return
    setRunning(true)
    stopRef.current = false
    let last: AutodiscoverState | null = resume ? state : null
    try {
      if (!resume) {
        last = await step('start')
        setState(last)
        toast.success('Автосбор запущен')
      }
      let retries = 0
      while (last?.running && !stopRef.current) {
        try {
          last = await step('step')
          retries = 0
        } catch (e) {
          if (e instanceof PanelError && e.status === 409) break // в другом месте уже остановили
          retries++
          if (retries >= 3) throw e
          await sleep(1200 * retries)
          continue
        }
        setState(last)
        if (last.running) await sleep(400)
      }
      if (last && !last.running && !stopRef.current && last.phase === 'done') {
        toast.success(
          `Сбор завершён: +${fmtNum(last.channelsAdded)} каналов, ${fmtNum(last.postsAdded)} постов`,
        )
        onChanged?.()
      }
    } catch (e) {
      if (e instanceof PanelError) {
        if (!isAuthOrNetworkError(e)) toast.error(e.message)
      } else if (e instanceof Error) {
        toast.error(e.message)
      }
    } finally {
      setRunning(false)
      setState((s) => (s ? { ...s, running: false, phase: s.phase === 'working' ? 'stopped' : s.phase } : s))
    }
  }

  const stop = async () => {
    stopRef.current = true
    try {
      const s = await step('stop')
      setState(s)
      toast.info('Автосбор остановлен')
    } catch {
      /* цикл и так остановится по stopRef */
    }
  }

  const st = state
  const processed = st?.processedCount ?? 0
  const queued = st?.queueSize ?? 0
  const progress = processed + queued > 0 ? Math.min(100, (processed / (processed + queued)) * 100) : 0

  return (
    <motion.div variants={fadeUp} initial="hidden" animate="show">
      <Card className={cn(panelCard, 'border-emerald-500/30')}>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2 text-base text-slate-900">
                <Bot className="size-4 text-emerald-700" aria-hidden />
                Автосбор каналов
                <Sparkles className="size-3.5 text-amber-500" aria-hidden />
              </CardTitle>
              <CardDescription className="text-xs text-slate-500">
                Одна кнопка — движок сам собирает кандидатов из TGStat и Combot,
                обходит упоминания в графе t.me, валидирует каждый через Telegram,
                отбрасывает пустышки и складывает настоящие посты в ленту. Никаких
                ручных юзернеймов.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {running ? (
                <Button
                  onClick={() => void stop()}
                  variant="outline"
                  className={btnOutlineDark}
                  aria-label="Остановить автосбор"
                >
                  <Pause aria-hidden />
                  Остановить
                </Button>
              ) : (
                <Button
                  onClick={() => void driveLoop()}
                  className="bg-emerald-500 font-medium text-slate-950 hover:bg-emerald-400"
                  aria-label="Запустить автосбор каналов"
                >
                  <Play aria-hidden />
                  Собрать каналы автоматически
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {!running && st && (st.phase === 'done' || st.phase === 'stopped') && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
              <span>
                Прошлый прогон:{' '}
                <b className="text-slate-800">
                  {st.phase === 'done' ? 'завершён' : 'остановлен'}
                </b>
              </span>
              <span>Каналов: <b className="tabular-nums text-emerald-700">+{fmtNum(st.channelsAdded)}</b></span>
              <span>Постов: <b className="tabular-nums text-slate-800">{fmtNum(st.postsAdded)}</b></span>
              <span>Отклонено: <b className="tabular-nums text-slate-500">{fmtNum(st.rejectedCount)}</b></span>
            </div>
          )}

          {st && (st.running || running) && (
            <div className="space-y-2.5 rounded-md border border-slate-200 bg-slate-50 px-3 py-3" role="status" aria-live="polite">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="flex items-center gap-1.5 text-slate-700">
                  <Loader2 className="size-3.5 animate-spin text-emerald-700" aria-hidden />
                  Идёт сбор…
                  <span className="text-slate-500">
                    проверено {fmtNum(st.processedCount)} · добавлено{' '}
                    <b className="text-emerald-700">{fmtNum(st.channelsAdded)}</b> · постов{' '}
                    <b className="text-slate-800">{fmtNum(st.postsAdded)}</b> · в очереди{' '}
                    {fmtNum(st.queueSize)} · источников осталось {fmtNum(st.sourcesLeft)}
                  </span>
                </span>
              </div>
              <Progress value={progress} className="h-1.5 bg-slate-200" aria-label="Прогресс автосбора" />
              {st.log.length > 0 && (
                <ul className="admin-scroll max-h-36 space-y-1 overflow-auto pr-1">
                  {st.log
                    .slice(-MAX_LOG_LINES)
                    .reverse()
                    .map((l, i) => (
                      <li key={`${l.at}-${i}`} className="truncate text-xs text-slate-600">
                        {l.msg}
                      </li>
                    ))}
                </ul>
              )}
            </div>
          )}

          {!running && (
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <label htmlFor="autoparse-maxnew" className="text-xs text-slate-500">
                  Новых каналов за прогон
                </label>
                <Select value={maxNew} onValueChange={setMaxNew}>
                  <SelectTrigger
                    id="autoparse-maxnew"
                    className="w-[120px] border-slate-200 bg-slate-100 text-slate-700"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-slate-200 bg-white text-slate-800">
                    {MAX_NEW_OPTIONS.map((o) => (
                      <SelectItem key={o} value={o} className="text-slate-700">
                        {o}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="autoparse-source" className="text-xs text-slate-500">
                  Источник кандидатов
                </label>
                <Select value={source} onValueChange={setSource}>
                  <SelectTrigger
                    id="autoparse-source"
                    className="w-[190px] border-slate-200 bg-slate-100 text-slate-700"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-slate-200 bg-white text-slate-800">
                    {SOURCE_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value} className="text-slate-700">
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="max-w-md text-xs leading-relaxed text-slate-500">
                Каскад источников: очередь пополняется на лету из рейтингов TGStat и Combot
                (плюс граф упоминаний t.me). Кандидат становится каналом, только если у него
                живое веб-превью и от 100 подписчиков.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  )
}

/** Мини-кнопка «догнать посты по всем каналам» (крупный прогон парсера) */
export function ParseAllButton({
  onDone,
  className,
  children,
}: {
  onDone?: (posts: number) => void
  className?: string
  children?: React.ReactNode
}) {
  const [busy, setBusy] = useState(false)
  const run = async () => {
    if (busy) return
    setBusy(true)
    let total = 0
    try {
      for (let round = 0; round < 10; round++) {
        const res = await panelFetch<{ result: { newPostsCount: number; truncated?: boolean } }>(
          '/api/panel/tools',
          { json: { action: 'parse', perChannel: 30, all: true, deep: true } },
        )
        total += res.result.newPostsCount
        if (!res.result.truncated) break
        await sleep(1500)
      }
      toast.success(`Крупный парсинг завершён: +${fmtNum(total)} постов`)
      onDone?.(total)
    } catch (e) {
      if (e instanceof PanelError) {
        if (e.status === 429) toast.error(`Слишком часто, подождите ${e.retryAfter ?? 300}с`)
        else if (!isAuthOrNetworkError(e)) toast.error(e.message)
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button onClick={() => void run()} disabled={busy} className={className}>
      {busy ? <Loader2 className="animate-spin" aria-hidden /> : <CheckCircle2 aria-hidden />}
      {children ?? 'Догнать посты по всем каналам'}
    </Button>
  )
}
