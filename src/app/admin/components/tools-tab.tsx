'use client'

import { useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { HeartPulse, Loader2, Play } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
    <motion.div variants={fadeUp} initial="hidden" animate="show" className="space-y-4">
      {/* Парсер */}
      <Card className={panelCard}>
        <CardHeader>
          <CardTitle className="text-base text-slate-100">Парсер ленты</CardTitle>
          <CardDescription className="text-xs text-slate-500">
            Забирает новые посты из t.me/s по активным каналам (лимит: 3 запуска за 5 минут)
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="parse-per-channel" className="text-xs text-slate-400">
                Постов на канал
              </Label>
              <Select value={perChannel} onValueChange={setPerChannel}>
                <SelectTrigger
                  id="parse-per-channel"
                  aria-label="Постов на канал"
                  className="w-[120px] border-white/10 bg-white/[0.04] text-slate-300"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-white/10 bg-[#16202b] text-slate-200">
                  {PER_CHANNEL_OPTIONS.map((o) => (
                    <SelectItem key={o} value={o} className="text-slate-300">
                      {o}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="parse-username" className="text-xs text-slate-400">
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
          </div>

          {result ? (
            <div className="space-y-3">
              <div className="rounded-md border border-emerald-500/20 bg-emerald-500/[0.06] px-3 py-2 text-xs text-emerald-200">
                Новых постов: <b>{fmtNum(result.newPostsCount)}</b> · Уведомлений отправлено:{' '}
                <b>{fmtNum(result.notified.sent)}</b> ({fmtNum(result.notified.failed)} не доставлено) ·
                Получателей: <b>{fmtNum(result.notified.recipients)}</b>
              </div>
              {result.results.length > 0 ? (
                <div className="admin-scroll max-h-[420px] overflow-auto rounded-md border border-white/[0.06]">
                  <Table className="min-w-[520px]">
                  <TableHeader>
                    <TableRow className="border-white/[0.06] hover:bg-transparent">
                      <TableHead className="text-xs text-slate-500">Канал</TableHead>
                      <TableHead className="text-right text-xs text-slate-500">Добавлено</TableHead>
                      <TableHead className="text-xs text-slate-500">Ошибка</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.results.map((r) => (
                      <TableRow key={r.username} className="border-white/[0.06] hover:bg-white/[0.03]">
                        <TableCell className="font-mono text-xs text-slate-300">@{r.username}</TableCell>
                        <TableCell className="text-right tabular-nums text-sm text-slate-200">
                          {r.added}
                        </TableCell>
                        <TableCell className="text-xs text-red-300">{r.error ?? '—'}</TableCell>
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
              <CardTitle className="flex items-center gap-2 text-base text-slate-100">
                <HeartPulse className="size-4 text-emerald-300" aria-hidden />
                Состояние системы
              </CardTitle>
              <CardDescription className="text-xs text-slate-500">
                Ответ GET /api/panel/health
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
                  className="rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2"
                >
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">{row.label}</div>
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
  const mono = (v: string) => <span className="font-mono text-xs text-slate-300">{v}</span>
  return [
    { label: 'API ok', value: <BoolBadge value={h.ok} /> },
    { label: 'База данных', value: <BoolBadge value={h.db} /> },
    { label: 'Бот', value: <BoolBadge value={h.bot} trueText="вкл" falseText="выкл" /> },
    {
      label: 'Bot username',
      value: h.botUsername ? mono(`@${h.botUsername}`) : <span className="text-xs text-slate-500">—</span>,
    },
    { label: 'Сессии', value: mono(h.session || '—') },
    { label: 'Версия', value: mono(h.version || '—') },
    { label: 'Uptime', value: <span className="text-xs text-slate-300">{fmtUptime(h.uptimeSec)}</span> },
    { label: 'CRON_SECRET', value: <BoolBadge value={h.env.cronSecretSet} /> },
    { label: 'ADMIN_KEY', value: <BoolBadge value={h.env.adminKeySet} /> },
    { label: 'BOT_TOKEN', value: <BoolBadge value={h.env.botTokenSet} /> },
    { label: 'DB провайдер', value: mono(h.env.dbProvider || '—') },
  ]
}
