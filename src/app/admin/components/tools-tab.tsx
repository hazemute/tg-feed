'use client'

import { useRef, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { CheckCircle2, HeartPulse, Loader2, Play } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

import { useAdminSSE } from './admin-sse'
import { AutoparseCard, ParseAllButton } from './autoparse-card'

import {
  fmtNum,
  fmtUptime,
  isAuthOrNetworkError,
  panelFetch,
  PanelError,
  type ParseResult,
  type PanelHealth,
  type ToolsParseResponse,
} from './api'
import {
  BoolBadge,
  SkeletonRows,
  btnOutlineDark,
  fadeUp,
  inputDark,
  panelCard,
} from './bits'

const PER_CHANNEL_OPTIONS = ['3', '5', '10', '20']

/** Строка живого лога (один обработанный канал) */
type LiveLine = { username: string; title: string; added: number; error?: string }
type LiveState = {
  phase: 'running' | 'done'
  current: number
  total: number
  lines: LiveLine[]
  ms: number | null
}

const MAX_LINES = 12

export function ToolsTab({
  health,
  onRecheck,
  healthLoading,
}: {
  health: PanelHealth | null
  onRecheck: () => void
  healthLoading: boolean
}) {
  const [perChannel, setPerChannel] = useState('5')
  const [username, setUsername] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ParseResult | null>(null)
  const [live, setLive] = useState<LiveState | null>(null)
  const liveRef = useRef<LiveState | null>(null)

  const applyLive = (next: LiveState | null) => {
    liveRef.current = next
    setLive(next)
  }

  // Живой прогресс парсера: работает и для запусков из этой вкладки,
  // и для запусков из другой вкладки/крона (одна SSE-шина)
  const { connected } = useAdminSSE((e) => {
    if (e.name === 'parse:start') {
      applyLive({ phase: 'running', current: 0, total: e.data.total, lines: [], ms: null })
      setRunning(true)
    } else if (e.name === 'parse:progress') {
      const prev = liveRef.current
      const line: LiveLine = {
        username: e.data.username,
        title: e.data.title,
        added: e.data.added,
        ...(e.data.error ? { error: e.data.error } : {}),
      }
      applyLive({
        phase: 'running',
        current: e.data.current,
        total: e.data.total,
        lines: [line, ...(prev?.lines ?? [])].slice(0, MAX_LINES),
        ms: null,
      })
    } else if (e.name === 'parse:done') {
      setRunning(false)
      applyLive(
        liveRef.current
          ? { ...liveRef.current, phase: 'done', ms: e.data.ms }
          : { phase: 'done', current: 0, total: 0, lines: [], ms: e.data.ms },
      )
    }
  })

  const runParser = async () => {
    if (running) return
    setRunning(true)
    try {
      const res = await panelFetch<ToolsParseResponse>('/api/panel/tools', {
        json: {
          action: 'parse',
          perChannel: Number(perChannel) || 5,
          username: username.trim() ? username.trim().replace(/^@+/, '') : undefined,
        },
      })
      setResult(res.result)
      toast.success('Парсер завершил работу')
    } catch (e) {
      if (e instanceof PanelError) {
        if (e.status === 429) toast.error(`Слишком часто, подождите ${e.retryAfter ?? 300}с`)
        else if (!isAuthOrNetworkError(e)) toast.error(e.message)
      }
    } finally {
      setRunning(false)
    }
  }

  return (
    <motion.div variants={fadeUp} initial="hidden" animate="show" className="space-y-5">
      {/* Автосбор: одна кнопка — движок сам находит каналы */}
      <AutoparseCard />

      {/* Парсер */}
      <Card className={panelCard}>
        <CardHeader>
          <CardTitle className="text-base text-slate-900">Парсер ленты</CardTitle>
          <CardDescription className="text-xs text-slate-500">
            Забирает новые посты из t.me/s по активным каналам (лимит: 3 запуска за 5 минут)
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="parse-per-channel" className="text-xs text-slate-500">
                Постов на канал
              </Label>
              <Select value={perChannel} onValueChange={setPerChannel}>
                <SelectTrigger
                  id="parse-per-channel"
                  aria-label="Постов на канал"
                  className="w-[120px] border-slate-200 bg-slate-100 text-slate-700"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-slate-200 bg-white text-slate-800">
                  {PER_CHANNEL_OPTIONS.map((o) => (
                    <SelectItem key={o} value={o} className="text-slate-700">
                      {o}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="parse-username" className="text-xs text-slate-500">
                Один канал (username)
              </Label>
              <Input
                id="parse-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="необязательно, @username"
                className={cn('w-64 text-sm', inputDark)}
              />
            </div>
            <Button
              onClick={() => void runParser()}
              disabled={running}
              className="bg-emerald-500 font-medium text-slate-950 hover:bg-emerald-400"
            >
              {running ? <Loader2 className="animate-spin" aria-hidden /> : <Play aria-hidden />}
              Запустить парсер
            </Button>
            <ParseAllButton
              className="border border-emerald-500/40 bg-transparent text-emerald-800 hover:bg-emerald-500/10"
            />
          </div>

          {/* Живой прогресс (SSE) */}
          {live && (
            <div
              className="space-y-2.5 rounded-md border border-slate-200 bg-slate-50 px-3 py-3"
              role="status"
              aria-live="polite"
            >
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="flex items-center gap-1.5 text-slate-700">
                  {live.phase === 'running' ? (
                    <Loader2 className="size-3.5 animate-spin text-emerald-700" aria-hidden />
                  ) : (
                    <CheckCircle2 className="size-3.5 text-emerald-700" aria-hidden />
                  )}
                  {live.phase === 'running' ? 'Идёт парсинг…' : 'Готово'}
                  <span className="text-slate-500">
                    · обработано {fmtNum(live.current)} из {fmtNum(live.total)}
                  </span>
                </span>
                {live.ms !== null && <span className="tabular-nums text-slate-500">{(live.ms / 1000).toFixed(1)} с</span>}
              </div>
              <Progress
                value={live.total > 0 ? (live.current / live.total) * 100 : live.phase === 'done' ? 100 : 0}
                className="h-1.5 bg-slate-200"
                aria-label="Прогресс парсинга"
              />
              {live.lines.length > 0 && (
                <ul className="admin-scroll max-h-40 space-y-1 overflow-auto pr-1">
                  {live.lines.map((l, i) => (
                    <li key={`${l.username}-${i}`} className="flex items-center gap-2 text-xs">
                      <span className="w-16 shrink-0 truncate font-mono text-slate-500">@{l.username}</span>
                      <span className="min-w-0 flex-1 truncate text-slate-700">{l.title}</span>
                      {l.error ? (
                        <span className="shrink-0 text-red-700">{l.error}</span>
                      ) : (
                        <span
                          className={cn(
                            'shrink-0 tabular-nums',
                            l.added > 0 ? 'font-medium text-emerald-700' : 'text-slate-500',
                          )}
                        >
                          +{fmtNum(l.added)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {result ? (
            <div className="space-y-3">
              <div className="rounded-md border border-emerald-500/20 bg-emerald-500/[0.06] px-3 py-2 text-xs text-emerald-800">
                Новых постов: <b>{fmtNum(result.newPostsCount)}</b> · Уведомлений отправлено:{' '}
                <b>{fmtNum(result.notified.sent)}</b> ({fmtNum(result.notified.failed)} не доставлено) ·
                Получателей: <b>{fmtNum(result.notified.recipients)}</b>
              </div>
              {result.results.length > 0 ? (
                <div className="admin-scroll max-h-[420px] overflow-auto rounded-md border border-slate-200">
                  <Table className="min-w-[520px]">
                  <TableHeader>
                    <TableRow className="border-slate-200 hover:bg-transparent">
                      <TableHead className="text-xs text-slate-500">Канал</TableHead>
                      <TableHead className="text-right text-xs text-slate-500">Добавлено</TableHead>
                      <TableHead className="text-xs text-slate-500">Ошибка</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.results.map((r) => (
                      <TableRow key={r.username} className="border-slate-200 hover:bg-slate-50">
                        <TableCell className="font-mono text-xs text-slate-700">@{r.username}</TableCell>
                        <TableCell className="text-right tabular-nums text-sm text-slate-800">
                          {r.added}
                        </TableCell>
                        <TableCell className="text-xs text-red-700">{r.error ?? '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="text-xs text-slate-500">
                  Каналы обработаны без результатов (t.me мог ответить пустой страницей).
                </p>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Состояние системы */}
      <Card className={panelCard}>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base text-slate-900">
                <HeartPulse className="size-4 text-emerald-700" aria-hidden />
                Состояние системы
              </CardTitle>
              <CardDescription className="flex items-center gap-1.5 text-xs text-slate-500">
                <span
                  aria-hidden
                  className={cn(
                    'inline-block size-1.5 rounded-full',
                    connected ? 'animate-pulse bg-emerald-400' : 'bg-slate-600',
                  )}
                />
                <span className={connected ? 'text-emerald-600' : 'text-slate-500'}>
                  Ответ GET /api/panel/health · live {connected ? 'онлайн' : 'оффлайн'}
                </span>
              </CardDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={onRecheck}
              disabled={healthLoading}
              className={btnOutlineDark}
              aria-label="Перепроверить состояние"
            >
              {healthLoading ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Перепроверить
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {health ? (
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
              {healthRows(health).map((row) => (
                <div
                  key={row.label}
                  className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2"
                >
                  <div className="text-[11px] uppercase tracking-wide text-slate-500">{row.label}</div>
                  <div className="mt-1 truncate">{row.value}</div>
                </div>
              ))}
            </div>
          ) : (
            <SkeletonRows rows={3} />
          )}
        </CardContent>
      </Card>
    </motion.div>
  )
}

/** Строки для карточки здоровья (чистая функция рендера). */
function healthRows(h: PanelHealth): { label: string; value: ReactNode }[] {
  const mono = (v: string) => <span className="font-mono text-xs text-slate-700">{v}</span>
  return [
    { label: 'API ok', value: <BoolBadge value={h.ok} /> },
    { label: 'База данных', value: <BoolBadge value={h.db} /> },
    { label: 'Бот', value: <BoolBadge value={h.bot} trueText="вкл" falseText="выкл" /> },
    {
      label: 'Bot username',
      value: h.botUsername ? mono(`@${h.botUsername}`) : <span className="text-xs text-slate-500">—</span>,
    },
    {
      label: 'Флуд-бан Bot API',
      value:
        h.botBanSec && h.botBanSec > 0 ? (
          <span className="text-xs font-semibold text-amber-600">
            пауза {fmtUptime(h.botBanSec)}
          </span>
        ) : (
          <BoolBadge value={true} trueText="нет" falseText="да" />
        ),
    },
    {
      label: 'Карточки каналов',
      value:
        typeof h.channelsMissingCards === 'number' && typeof h.channelsTotal === 'number' ? (
          <span className="text-xs text-slate-700">
            {h.channelsMissingCards === 0 ? (
              <span className="font-semibold text-emerald-600">все заполнены</span>
            ) : (
              <>
                не хватает <b className="font-semibold">{h.channelsMissingCards}</b> из{' '}
                {h.channelsTotal}
              </>
            )}
          </span>
        ) : (
          <span className="text-xs text-slate-500">—</span>
        ),
    },
    { label: 'Сессии', value: mono(h.session || '—') },
    { label: 'Версия', value: mono(h.version || '—') },
    { label: 'Uptime', value: <span className="text-xs text-slate-700">{fmtUptime(h.uptimeSec)}</span> },
    { label: 'CRON_SECRET', value: <BoolBadge value={h.env.cronSecretSet} /> },
    { label: 'ADMIN_KEY', value: <BoolBadge value={h.env.adminKeySet} /> },
    { label: 'BOT_TOKEN', value: <BoolBadge value={h.env.botTokenSet} /> },
    { label: 'DB провайдер', value: mono(h.env.dbProvider || '—') },
  ]
}
