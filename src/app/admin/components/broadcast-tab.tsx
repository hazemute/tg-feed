'use client'

/**
 * v6.6: вкладка «Рассылка» — массовые ЛС всей аудитории бота
 * (юзеры миниаппа ∪ бот-юзеры). Текст уходит как в /send: плейнтекст,
 * сервер экранирует HTML сам. Отправка идёт чанками по 150 с прогрессом;
 * перед запуском — тест себе (по умолчанию chat_id создателя бота).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Loader2, RefreshCw, Send, ShieldCheck, Users } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Progress } from '@/components/ui/progress'

import { panelFetch, PanelError, fmtNum } from './api'
import { EmptyState, TabProps, btnOutlineDark, fadeUp, inputDark, panelCard, staggerContainer } from './bits'

/** chat_id создателя бота (BOT_OWNER_TG_ID из webhook) — поле теста предзаполнено им */
const OWNER_CHAT_ID = '7851246214'

const CHUNK_SIZE = 150 // идов за один POST (лимит сервера 300 — оставляем запас)
const MAX_TEXT = 3500

interface AudienceStats {
  total: number
  app: number
  botOnly: number
  banned: number
  /** v6.7.0: заблокировали бота / удалили аккаунт — исключены заранее */
  blocked: number
}

type Phase = 'idle' | 'sending' | 'done'

export function BroadcastTab({ tick, onSettled }: TabProps) {
  const [stats, setStats] = useState<AudienceStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  const [text, setText] = useState('')
  const [link, setLink] = useState('')
  const [testChatId, setTestChatId] = useState(OWNER_CHAT_ID)
  const [testBusy, setTestBusy] = useState(false)

  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState({ done: 0, sent: 0, failed: 0 })
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [dupWarn, setDupWarn] = useState<string | null>(null)
  const abortRef = useRef(false)
  /** v6.7.0: подтверждённый повтор — после 409 все чанки уходят с confirm:true */
  const dupRef = useRef(false)

  const loadStats = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const r = await panelFetch<{ stats: AudienceStats }>('/api/panel/broadcast')
      setStats(r.stats)
    } catch (e) {
      if (!(e instanceof PanelError && e.status === 401)) {
        setLoadError(true)
        toast.error('Не удалось загрузить аудиторию')
      }
    } finally {
      setLoading(false)
      onSettled()
    }
  }, [onSettled])

  useEffect(() => {
    void loadStats()
  }, [loadStats, tick])

  const charsLeft = MAX_TEXT - text.length
  const linkValid = link.trim() === '' || /^https?:\/\/\S+$/i.test(link.trim())
  const canSend = text.trim().length > 0 && charsLeft >= 0 && linkValid && phase !== 'sending'

  const fetchIds = useCallback(async (): Promise<string[] | null> => {
    try {
      const r = await panelFetch<{ ids: string[] }>('/api/panel/broadcast?withIds=1')
      return r.ids
    } catch {
      toast.error('Не удалось получить список получателей')
      return null
    }
  }, [])

  /** Тест-отправка одному чату */
  const sendTest = useCallback(async () => {
    if (!canSend) return
    setTestBusy(true)
    try {
      const r = await panelFetch<{ ok: boolean; error: string | null }>('/api/panel/broadcast', {
        method: 'POST',
        json: { text: text.trim(), link: link.trim(), testChatId: testChatId.trim() },
        timeoutMs: 25_000,
      })
      if (r.ok) {
        toast.success(`Тест отправлен в ${testChatId.trim()}`)
      } else {
        toast.error(`Telegram: ${r.error ?? 'ошибка отправки'}`)
      }
    } catch (e) {
      toast.error(e instanceof PanelError ? e.message : 'Ошибка сети')
    } finally {
      setTestBusy(false)
    }
  }, [canSend, text, link, testChatId])

  /** Массовая отправка чанками с прогрессом.
   *  v6.7.0: сервер отвечает 409, если тот же текст уже уходил < 30 минут назад
   *  (инцидент с двойной рассылкой итогов конкурса). Тогда показываем диалог
   *  ещё раз с предупреждением; подтверждённый повтор шлёт confirm:true. */
  const runBroadcast = useCallback(async () => {
    setConfirmOpen(false)
    setDupWarn(null)
    if (!canSend) return
    setPhase('sending')
    abortRef.current = false
    setProgress({ done: 0, sent: 0, failed: 0 })

    const ids = await fetchIds()
    if (!ids) {
      setPhase('idle')
      return
    }

    let sent = 0
    let failed = 0
    let dupBlocked = false
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      if (abortRef.current) break
      const chunk = ids.slice(i, i + CHUNK_SIZE)
      try {
        const r = await panelFetch<{ ok: boolean; sent: number; failed: number }>('/api/panel/broadcast', {
          method: 'POST',
          json: { text: text.trim(), link: link.trim(), ids: chunk, ...(dupRef.current ? { confirm: true } : {}) },
          timeoutMs: 120_000,
        })
        sent += r.sent
        failed += r.failed
      } catch (e) {
        if (e instanceof PanelError && e.status === 409) {
          dupBlocked = true
          dupRef.current = true
          setDupWarn(e.message || 'Этот же текст уже отправлялся совсем недавно')
          setConfirmOpen(true)
          break
        }
        failed += chunk.length
        if (e instanceof PanelError && e.status === 401) break
        toast.error(e instanceof PanelError ? `Чанк прерван: ${e.message}` : 'Сеть: чанк прерван')
      }
      setProgress({ done: Math.min(i + CHUNK_SIZE, ids.length), sent, failed })
    }

    if (dupBlocked) {
      setPhase('idle')
      return
    }
    setPhase('done')
    toast.success(`Рассылка завершена: доставлено ${sent}, ошибок ${failed}`)
    void loadStats()
  }, [canSend, fetchIds, text, link, loadStats])

  const pct = stats && stats.total > 0 ? Math.round((progress.done / stats.total) * 100) : 0

  const preview = useMemo(() => text.trim().slice(0, 600), [text])

  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      animate="show"
      className="space-y-4"
    >
      {/* Аудитория */}
      <motion.div variants={fadeUp}>
        <Card className={panelCard}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Users className="h-5 w-5 text-slate-500" />
                <CardTitle className="text-base">Аудитория рассылки</CardTitle>
              </div>
              <Button variant="outline" size="sm" className={btnOutlineDark} onClick={() => void loadStats()} disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Обновить
              </Button>
            </div>
            <CardDescription>
              Юзеры миниаппа + все, кто писал боту в ЛС. Забаненные исключаются.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading && !stats ? (
              <div className="h-16 animate-pulse rounded-lg bg-slate-100" />
            ) : loadError || !stats ? (
              <EmptyState icon={Users} title="Аудитория не загрузилась" hint="Попробуйте ещё раз" />
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <StatBox label="Всего получателей" value={fmtNum(stats.total)} accent />
                <StatBox label="Из миниаппа" value={fmtNum(stats.app)} />
                <StatBox label="Только в боте" value={fmtNum(stats.botOnly)} />
                <StatBox label="Бот заблокирован (мимо)" value={fmtNum(stats.blocked)} />
                <StatBox label="Забанено (мимо)" value={fmtNum(stats.banned)} />
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* Редактор */}
      <motion.div variants={fadeUp}>
        <Card className={panelCard}>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <Send className="h-5 w-5 text-slate-500" />
              <CardTitle className="text-base">Сообщение</CardTitle>
            </div>
            <CardDescription>
              Обычный текст (HTML не нужен — экранируем как в /send). Переносы строк сохраняются.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value.slice(0, MAX_TEXT))}
                placeholder={'🎉 Текст рассылки…\n\nВторая строка и т.д.'}
                className={inputDark}
                rows={8}
                disabled={phase === 'sending'}
              />
              <div className={`text-xs ${charsLeft < 0 ? 'text-red-600' : 'text-slate-400'}`}>
                Осталось символов: {charsLeft}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs text-slate-500">Кнопка под постом — ссылка (необязательно)</Label>
                <Input
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  placeholder="https://t.me/tgswipe_bot/tgswipe"
                  className={inputDark}
                  disabled={phase === 'sending'}
                />
                {!linkValid && <div className="text-xs text-red-600">Ссылка должна начинаться с http(s)://</div>}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-slate-500">Chat_id для теста</Label>
                <div className="flex gap-2">
                  <Input
                    value={testChatId}
                    onChange={(e) => setTestChatId(e.target.value.replace(/\D/g, ''))}
                    className={inputDark}
                    disabled={phase === 'sending' || testBusy}
                  />
                  <Button
                    variant="outline"
                    className={btnOutlineDark}
                    onClick={() => void sendTest()}
                    disabled={!canSend || testBusy || !/^\d{3,}$/.test(testChatId.trim())}
                  >
                    {testBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    Тест
                  </Button>
                </div>
                <div className="text-xs text-slate-400">Сначала придёт только вам — проверьте вид и жмите «Отправить всем».</div>
              </div>
            </div>

            {preview && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="mb-1 text-xs font-medium text-slate-400">Предпросмотр (как в Telegram)</div>
                <div className="whitespace-pre-wrap break-words text-sm text-slate-800">{preview}</div>
                {link.trim() && linkValid && (
                  <div className="mt-2 inline-flex items-center rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white">
                    👉 Открыть
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
              {phase !== 'sending' ? (
                <Button
                  onClick={() => setConfirmOpen(true)}
                  disabled={!canSend}
                  className="bg-slate-900 text-white hover:bg-slate-800"
                >
                  <Send className="h-4 w-4" />
                  Отправить всем ({stats ? fmtNum(stats.total) : '…'})
                </Button>
              ) : (
                <Button
                  variant="outline"
                  className={btnOutlineDark}
                  onClick={() => {
                    abortRef.current = true
                  }}
                >
                  Остановить после чанка
                </Button>
              )}
              {phase === 'done' && (
                <span className="text-sm text-emerald-700">
                  Готово: доставлено {progress.sent}, ошибок {progress.failed}
                </span>
              )}
            </div>

            {phase === 'sending' && (
              <div className="space-y-1.5">
                <Progress value={pct} className="h-2" />
                <div className="text-xs text-slate-500">
                  Отправлено {progress.done} из {stats?.total ?? '…'} · доставлено {progress.sent} · ошибок {progress.failed}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* Подтверждение */}
      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Подтверждение рассылки"
          onClick={() => setConfirmOpen(false)}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-amber-600" />
              <h3 className="text-base font-semibold text-slate-900">Запустить рассылку?</h3>
            </div>
            <p className="mb-1 text-sm text-slate-600">
              Сообщение уйдёт <b>{stats ? fmtNum(stats.total) : '…'}</b> пользователям в ЛС. Отменить отправку нельзя.
            </p>
            {dupWarn && (
              <p className="mb-1 mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs font-medium text-amber-800">
                ⚠️ {dupWarn}
              </p>
            )}
            <p className="mb-4 text-xs text-slate-400">
              Совет: сначала отправьте тест себе — кнопка «Тест» выше.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" className={btnOutlineDark} onClick={() => setConfirmOpen(false)}>
                Отмена
              </Button>
              <Button
                className="bg-slate-900 text-white hover:bg-slate-800"
                onClick={() => void runBroadcast()}
              >
                <Send className="h-4 w-4" />
                {dupWarn ? 'Всё равно отправить' : 'Запустить'}
              </Button>
            </div>
          </motion.div>
        </div>
      )}
    </motion.div>
  )
}

function StatBox({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${accent ? 'border-slate-900/20 bg-slate-900 text-white' : 'border-slate-200 bg-slate-50'}`}>
      <div className={`text-lg font-semibold ${accent ? 'text-white' : 'text-slate-900'}`}>{value}</div>
      <div className={`text-xs ${accent ? 'text-slate-300' : 'text-slate-500'}`}>{label}</div>
    </div>
  )
}
