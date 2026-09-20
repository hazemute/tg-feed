'use client'

/**
 * Вкладка «Розыгрыши» (v5.40): конкурсы в Telegram-канале.
 *  - конструктор поста с кнопкой «Участвовать»: призы, обязательные каналы,
 *    стиль/эмодзи кнопки, время старта/итогов + живое HTML-превью (PUT);
 *  - карточки розыгрышей со статусами и действиями по статусу
 *    (опубликовать / изменить / отменить / завершить / удалить);
 *  - прогон ленивого планировщика (sweep) и канал публикации.
 *
 * Контракт: GET/POST/PUT /api/panel/giveaways (src/app/api/panel/giveaways/route.ts).
 * Важно: amount приза kind='rub' — КОПЕЙКИ (в форме рубли, ×100 при отправке).
 */

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  AlertTriangle,
  Ban,
  CalendarDays,
  ExternalLink,
  Gift,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Timer,
  Trash2,
  Trophy,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

import { fmtNum, isAuthOrNetworkError, panelFetch, PanelError } from './api'
import {
  EmptyState,
  SkeletonRows,
  TabProps,
  btnOutlineDark,
  fadeUp,
  inputDark,
  panelCard,
  useDebouncedValue,
} from './bits'

/* ===================== Типы ===================== */

type PrizeKind = 'swipes' | 'rub' | 'tier' | 'custom'
type ButtonStyle = 'primary' | 'success' | 'danger'
type GiveawayStatus = 'draft' | 'scheduled' | 'active' | 'finished' | 'cancelled'

/** Приз в API: rub — копейки; tier — 1=Плюс, 2=Про; custom amount игнорирует */
interface GiveawayPrize {
  kind: PrizeKind
  amount: number
  periodDays?: number
  winners: number
  label: string
}

interface GiveawayWinner {
  userId: string
  name: string
  tgId?: string
  prizeIndex: number
}

interface GiveawayItem {
  id: string
  title: string
  text: string
  prizes: GiveawayPrize[]
  channels: string[]
  buttonStyle: ButtonStyle
  buttonEmoji: string
  buttonEmojiId: string
  startAt: string
  endAt: string
  status: GiveawayStatus
  chatId: string | null
  messageId: number | null
  winners: GiveawayWinner[]
  entriesCount: number
  createdAt: string
  // v5.46 — билетная система (обогащённый ответ GET)
  tasks?: Array<{ kind: string; enabled: boolean; tickets: number; swipeGoal?: number; referralGoal?: number; boostChannel?: string; label?: string }>
  promoCode?: string | null
  losersRewardSwipes?: number
  hasPhoto?: boolean
  ticketsSum?: number
}

interface GiveawaysResponse {
  items: GiveawayItem[]
  publishChannel: string
}

/** Строка приза в конструкторе: amount — строка (rub в рублях, конвертация при отправке) */
interface PrizeDraft {
  kind: PrizeKind
  amount: string
  periodDays: string
  winners: string
  label: string
}

/** Поля черновика — общие для create/update */
interface GiveawayDraftFields {
  title: string
  text: string
  prizes: GiveawayPrize[]
  channels: string[]
  buttonStyle: ButtonStyle
  buttonEmoji: string
  buttonEmojiId: string
  startAt: string
  endAt: string
}

type GiveawayActionPayload =
  | ({ action: 'create' } & GiveawayDraftFields)
  | ({ action: 'update'; id: string } & GiveawayDraftFields)
  | { action: 'delete'; id: string }
  | { action: 'publish'; id: string }
  | { action: 'cancel'; id: string }
  | { action: 'finalize'; id: string }
  | { action: 'sweep' }
  | { action: 'channel'; value: string }

interface GiveawayActionResult {
  ok: boolean
  id?: string
  published?: boolean
  scheduled?: boolean
  messageId?: number
  message?: string
  winners?: number
  channel?: string
  finished?: number
}

/* ===================== API ===================== */

/** v5.46: строка участника в панели */
interface GiveawayEntryRow {
  userId: string
  name: string
  username: string | null
  tgId: string | null
  ticketsCount: number
  tasksDone: Array<{ task: string; tickets: number; at: string }>
  winner: boolean
  createdAt: string
}

async function fetchGiveawayEntries(id: string): Promise<{ giveaway: { title: string; status: string }; entries: GiveawayEntryRow[] }> {
  return panelFetch<{ giveaway: { title: string; status: string }; entries: GiveawayEntryRow[] }>(
    `/api/panel/giveaways?entries=${encodeURIComponent(id)}`,
  )
}

async function fetchGiveaways(): Promise<GiveawaysResponse> {
  return panelFetch<GiveawaysResponse>('/api/panel/giveaways')
}

async function giveawayAction(payload: GiveawayActionPayload): Promise<GiveawayActionResult> {
  return panelFetch<GiveawayActionResult>('/api/panel/giveaways', { method: 'POST', json: payload })
}

/** HTML-превью поста (сервер генерирует HTML из <b>/<i>/<a> — админ-only, sanitize не нужен) */
async function giveawayPreview(body: {
  title: string
  text: string
  prizes: GiveawayPrize[]
  channels: string[]
  endAt: string
}): Promise<string> {
  const r = await panelFetch<{ ok: boolean; html: string }>('/api/panel/giveaways', { method: 'PUT', json: body })
  return r.html
}

/* ===================== Константы и хелперы ===================== */

const STATUS_META: Record<GiveawayStatus, { label: string; className: string }> = {
  draft: { label: 'черновик', className: 'border-slate-200 bg-slate-100 text-slate-500' },
  scheduled: { label: 'запланирован', className: 'border-sky-500/30 bg-sky-50 text-sky-700' },
  active: { label: 'идёт', className: 'border-emerald-500/30 bg-emerald-50 text-emerald-700' },
  finished: { label: 'завершён', className: 'border-violet-500/30 bg-violet-50 text-violet-700' },
  cancelled: { label: 'отменён', className: 'border-red-500/30 bg-red-50 text-red-700' },
}

const BTN_BG: Record<ButtonStyle, string> = {
  primary: 'bg-blue-500',
  success: 'bg-green-500',
  danger: 'bg-red-500',
}

const BUTTON_STYLES: Array<{ value: ButtonStyle; label: string }> = [
  { value: 'primary', label: 'Синяя' },
  { value: 'success', label: 'Зелёная' },
  { value: 'danger', label: 'Красная' },
]

const PRIZE_KINDS: Array<{ value: PrizeKind; label: string }> = [
  { value: 'swipes', label: 'Свайпы' },
  { value: 'rub', label: 'Рубли' },
  { value: 'tier', label: 'Тариф' },
  { value: 'custom', label: 'Кастом' },
]

const MEDALS = ['🥇', '🥈', '🥉'] as const

const SELECT_CLS =
  'h-9 rounded-md border border-slate-200 bg-slate-100 px-2 text-sm text-slate-700 outline-none focus:border-emerald-400'

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Date → значение для input[type=datetime-local] (локальное время) */
function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** datetime-local → ISO (null, если не распарсилось) */
function localToIso(v: string): string | null {
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** «05.02 14:30» */
function fmtDT(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const fmtRange = (startIso: string, endIso: string): string => `${fmtDT(startIso)} → ${fmtDT(endIso)}`

/** Убрать @ и t.me-префикс, отфильтровать пустые и дубли */
function cleanChannelList(list: string[]): string[] {
  const out: string[] = []
  for (const raw of list) {
    const v = raw.trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '').replace(/\/+$/, '')
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

const newPrizeRow = (): PrizeDraft => ({ kind: 'swipes', amount: '', periodDays: '', winners: '1', label: '' })

/**
 * Строки конструктора → призы для API.
 * rub: рубли с десятыми → КОПЕЙКИ (×100, округление).
 */
function buildPrizes(rows: PrizeDraft[]): { ok: true; prizes: GiveawayPrize[] } | { ok: false; msg: string } {
  const prizes: GiveawayPrize[] = []
  for (const p of rows) {
    const winners = Math.round(Number(p.winners))
    if (!Number.isFinite(winners) || winners < 1) return { ok: false, msg: 'Укажите число мест (минимум 1) для каждого приза' }
    if (p.kind === 'swipes') {
      const amount = Math.round(Number(p.amount))
      if (!Number.isFinite(amount) || amount < 1) return { ok: false, msg: 'Укажите количество свайпов в призе' }
      prizes.push({ kind: 'swipes', amount, winners, label: p.label.trim().slice(0, 120) })
    } else if (p.kind === 'rub') {
      const rub = Number(p.amount.replace(',', '.'))
      const kop = Math.round(rub * 100)
      if (!Number.isFinite(rub) || kop <= 0) return { ok: false, msg: 'Укажите сумму приза в рублях' }
      prizes.push({ kind: 'rub', amount: kop, winners, label: p.label.trim().slice(0, 120) })
    } else if (p.kind === 'tier') {
      let periodDays: number | undefined
      if (p.periodDays.trim() !== '') {
        const n = Math.round(Number(p.periodDays))
        if (!Number.isFinite(n) || n < 0) return { ok: false, msg: 'Проверьте период тарифа (дней)' }
        periodDays = n > 0 ? n : undefined
      }
      prizes.push({ kind: 'tier', amount: p.amount === '2' ? 2 : 1, winners, ...(periodDays ? { periodDays } : {}), label: p.label.trim().slice(0, 120) })
    } else {
      prizes.push({ kind: 'custom', amount: 0, winners, label: p.label.trim().slice(0, 120) })
    }
  }
  return { ok: true, prizes }
}

/* ===================== Карточка розыгрыша ===================== */

type CardAction = { label: string; icon: LucideIcon; tone: 'green' | 'dark' | 'outline' | 'danger'; run: () => void }

const ACTION_CLS: Record<CardAction['tone'], string> = {
  green: 'bg-emerald-600 text-white hover:bg-emerald-700',
  dark: 'bg-slate-900 text-white hover:bg-slate-700',
  outline: btnOutlineDark,
  danger: cn('hover:bg-red-50 hover:text-red-700', btnOutlineDark),
}

function GiveawayCard({
  item,
  publishChannel,
  busy,
  onPublish,
  onEdit,
  onCancel,
  onFinalize,
  onDelete,
  onParticipants,
}: {
  item: GiveawayItem
  publishChannel: string
  busy: boolean
  onPublish: (item: GiveawayItem) => void
  onEdit: (item: GiveawayItem) => void
  onCancel: (item: GiveawayItem) => void
  onFinalize: (item: GiveawayItem) => void
  onDelete: (item: GiveawayItem) => void
  onParticipants: (item: GiveawayItem) => void
}) {
  const meta = STATUS_META[item.status]
  const postLink = item.chatId && item.messageId ? `https://t.me/${publishChannel}/${item.messageId}` : null

  // Кнопки действий зависят от статуса
  const acts: CardAction[] = [
    { label: 'Участники', icon: Users, tone: 'outline', run: () => onParticipants(item) },
    ...((item.status === 'draft'
      ? [
          { label: 'Опубликовать', icon: Send, tone: 'green', run: () => onPublish(item) },
          { label: 'Изменить', icon: Pencil, tone: 'outline', run: () => onEdit(item) },
          { label: 'Удалить', icon: Trash2, tone: 'danger', run: () => onDelete(item) },
        ]
      : item.status === 'scheduled'
        ? [
            { label: 'Опубликовать сейчас', icon: Send, tone: 'green', run: () => onPublish(item) },
            { label: 'Изменить', icon: Pencil, tone: 'outline', run: () => onEdit(item) },
            { label: 'Отменить', icon: Ban, tone: 'danger', run: () => onCancel(item) },
          ]
        : item.status === 'active'
          ? [
              { label: 'Завершить сейчас (итоги)', icon: Trophy, tone: 'dark', run: () => onFinalize(item) },
              { label: 'Отменить', icon: Ban, tone: 'danger', run: () => onCancel(item) },
            ]
          : item.status === 'cancelled'
            ? [{ label: 'Удалить', icon: Trash2, tone: 'danger', run: () => onDelete(item) }]
            : []) as CardAction[]),
  ]

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900" title={item.title}>
          {item.title}
        </p>
        <Badge variant="outline" className={cn('rounded-full text-[11px] font-medium', meta.className)}>
          {meta.label}
        </Badge>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
        <span className="inline-flex items-center gap-1">
          <Users className="size-3.5" aria-hidden /> {fmtNum(item.entriesCount)} заявок
        </span>
        {typeof item.ticketsSum === 'number' && item.ticketsSum > 0 && (
          <span className="inline-flex items-center gap-1 font-medium text-amber-700">
            🎫 {fmtNum(item.ticketsSum)} билетов всего
          </span>
        )}
        <span className="inline-flex items-center gap-1">
          <CalendarDays className="size-3.5" aria-hidden /> {fmtRange(item.startAt, item.endAt)}
        </span>
        {item.hasPhoto && <span>🖼 с фото</span>}
        {item.promoCode && <span className="font-mono text-[11px]">🔑 {item.promoCode}</span>}
        {typeof item.losersRewardSwipes === 'number' && item.losersRewardSwipes > 0 && (
          <span>💜 утешение: {fmtNum(item.losersRewardSwipes)} свайпов</span>
        )}
      </div>

      {/* Задания (билеты) */}
      {item.tasks && item.tasks.some((t) => t.enabled) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {item.tasks.filter((t) => t.enabled).map((t) => (
            <span key={t.kind} className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700">
              🎫 ×{t.tickets} · {t.kind === 'activity' ? `активность (${t.swipeGoal ?? '?'} свайпов)` : t.kind === 'promo' ? 'промокод' : t.kind === 'referral' ? `рефералы (${t.referralGoal ?? '?'})` : `буст @${t.boostChannel ?? 'SnapTeamDev'}`}
            </span>
          ))}
        </div>
      )}

      {/* Призы: «название × мест» */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {item.prizes.map((p, i) => (
          <span key={i} className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
            {p.label} × {p.winners}
          </span>
        ))}
      </div>

      {/* Каналы + кнопка */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-slate-500">
        <span>Подписки: {item.channels.length > 0 ? item.channels.map((c) => `@${c}`).join(', ') : 'не требуются'}</span>
        <span className="inline-flex items-center gap-1.5">
          Кнопка:
          <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold text-white', BTN_BG[item.buttonStyle])}>
            <span aria-hidden>{item.buttonEmoji}</span> Участвовать
          </span>
        </span>
      </div>

      {/* Победители (finished) */}
      {item.status === 'finished' && (
        <div className="mt-2 rounded-lg bg-slate-50 p-2.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Победители</p>
          {item.winners.length === 0 ? (
            <p className="mt-1 text-xs text-slate-500">Победителей нет — заявок не было</p>
          ) : (
            <ul className="mt-1 space-y-0.5 text-xs text-slate-700">
              {item.winners.map((w, i) => (
                <li key={`${w.userId}-${i}`}>
                  {MEDALS[i] ?? `${i + 1}.`} <span className="font-medium">{w.name}</span>
                  {item.prizes[w.prizeIndex] ? <span className="text-slate-500"> — {item.prizes[w.prizeIndex].label}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Действия по статусу */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {acts.map((a) => {
          const Icon = a.icon
          return (
            <Button
              key={a.label}
              size="sm"
              variant={a.tone === 'green' || a.tone === 'dark' ? 'default' : 'outline'}
              disabled={busy}
              onClick={a.run}
              className={cn('h-8', ACTION_CLS[a.tone])}
            >
              <Icon aria-hidden /> {a.label}
            </Button>
          )
        })}
        {item.status === 'active' && postLink && (
          <a href={postLink} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-emerald-700 hover:underline">
            <ExternalLink className="size-3.5" aria-hidden /> Открыть пост
          </a>
        )}
      </div>
    </div>
  )
}

/* ===================== Вкладка ===================== */

export function GiveawaysTab({ tick, onSettled }: TabProps) {
  const [data, setData] = useState<GiveawaysResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [localTick, setLocalTick] = useState(0)
  const [busy, setBusy] = useState(false)
  const [channelDraft, setChannelDraft] = useState('')

  // Конструктор
  const [composerOpen, setComposerOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [prizes, setPrizes] = useState<PrizeDraft[]>([newPrizeRow()])
  const [channels, setChannels] = useState<string[]>([])
  const [buttonStyle, setButtonStyle] = useState<ButtonStyle>('primary')
  const [buttonEmoji, setButtonEmoji] = useState('🎉')
  const [buttonEmojiId, setButtonEmojiId] = useState('')
  const [startAt, setStartAt] = useState(() => toLocalInput(new Date()))
  const [endAt, setEndAt] = useState(() => toLocalInput(new Date(Date.now() + 3 * 86_400_000)))
  const [saving, setSaving] = useState(false)

  // Превью
  const [previewHtml, setPreviewHtml] = useState<string | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)

  // v5.46: участники розыгрыша (модал с билетами)
  const [pModal, setPModal] = useState<GiveawayItem | null>(null)
  const [pEntries, setPEntries] = useState<GiveawayEntryRow[] | null>(null)
  const [pLoading, setPLoading] = useState(false)
  const [pError, setPError] = useState<string | null>(null)

  const load = async () => {
    try {
      const d = await fetchGiveaways()
      setData(d)
      setChannelDraft(d.publishChannel)
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

  // v5.46: открыть модал участников
  const openParticipants = async (item: GiveawayItem) => {
    setPModal(item)
    setPEntries(null)
    setPError(null)
    setPLoading(true)
    try {
      const d = await fetchGiveawayEntries(item.id)
      setPEntries(d.entries)
    } catch (e) {
      setPError(e instanceof PanelError ? e.message : 'Не удалось загрузить участников')
    } finally {
      setPLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [tick, localTick])

  /** Любая мутирующая операция: confirm снаружи, тост + перезагрузка списка внутри */
  const mutate = async (payload: GiveawayActionPayload, successMsg: (r: GiveawayActionResult) => string): Promise<boolean> => {
    setBusy(true)
    try {
      const r = await giveawayAction(payload)
      toast.success(successMsg(r))
      setLocalTick((t) => t + 1)
      return true
    } catch (e) {
      if (!isAuthOrNetworkError(e)) toast.error(e instanceof PanelError ? e.message : 'Не получилось')
      return false
    } finally {
      setBusy(false)
    }
  }

  const sweep = () => void mutate({ action: 'sweep' }, (r) => `Опубликовано: ${r.published ?? 0}, завершено: ${r.finished ?? 0}`)

  const publish = (item: GiveawayItem) =>
    void mutate(
      { action: 'publish', id: item.id },
      (r) => (r.scheduled ? (r.message ?? 'Запланировано — бот опубликует по расписанию') : 'Розыгрыш опубликован'),
    )

  const cancel = (item: GiveawayItem) => {
    if (!window.confirm(`Отменить розыгрыш «${item.title}»? Заявки участников не восстановятся.`)) return
    void mutate({ action: 'cancel', id: item.id }, () => 'Розыгрыш отменён')
  }

  const finalize = (item: GiveawayItem) => {
    if (!window.confirm('Завершить розыгрыш прямо сейчас? Победители будут выбраны случайным образом, призы зачислены.')) return
    void mutate({ action: 'finalize', id: item.id }, (r) => `Итоги подведены — победителей: ${r.winners ?? 0}`)
  }

  const remove = (item: GiveawayItem) => {
    if (!window.confirm(`Удалить розыгрыш «${item.title}»?`)) return
    void mutate({ action: 'delete', id: item.id }, () => 'Розыгрыш удалён')
  }

  const saveChannel = async () => {
    const v = channelDraft.trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '')
    if (v === (data?.publishChannel ?? '')) return
    await mutate({ action: 'channel', value: v }, (r) => `Канал публикации: @${r.channel ?? v}`)
  }

  /* ---------- конструктор ---------- */

  const resetComposer = () => {
    setEditingId(null)
    setTitle('')
    setText('')
    setPrizes([newPrizeRow()])
    setChannels([])
    setButtonStyle('primary')
    setButtonEmoji('🎉')
    setButtonEmojiId('')
    setStartAt(toLocalInput(new Date()))
    setEndAt(toLocalInput(new Date(Date.now() + 3 * 86_400_000)))
    setComposerOpen(false)
    setPreviewHtml(null)
  }

  const startEdit = (item: GiveawayItem) => {
    setEditingId(item.id)
    setTitle(item.title)
    setText(item.text)
    setPrizes(
      item.prizes.map((p) => ({
        kind: p.kind,
        amount: p.kind === 'rub' ? String(p.amount / 100) : String(p.amount),
        periodDays: p.periodDays ? String(p.periodDays) : '',
        winners: String(p.winners),
        label: p.label,
      })),
    )
    setChannels([...item.channels])
    setButtonStyle(item.buttonStyle)
    setButtonEmoji(item.buttonEmoji || '🎉')
    setButtonEmojiId(item.buttonEmojiId)
    setStartAt(toLocalInput(new Date(item.startAt)))
    setEndAt(toLocalInput(new Date(item.endAt)))
    setComposerOpen(true)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const updatePrize = (idx: number, patch: Partial<PrizeDraft>) =>
    setPrizes((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)))

  const totalPlaces = prizes.reduce((a, p) => a + (Math.round(Number(p.winners)) || 0), 0)

  const saveDraft = async () => {
    const t = title.trim()
    if (t.length < 3) return void toast.error('Название — минимум 3 символа')
    if (prizes.length === 0) return void toast.error('Добавьте хотя бы один приз')
    const pr = buildPrizes(prizes)
    if (!pr.ok) return void toast.error(pr.msg)
    const startISO = localToIso(startAt)
    const endISO = localToIso(endAt)
    if (!startISO || !endISO) return void toast.error('Укажите время начала и итогов')
    if (new Date(endISO).getTime() <= new Date(startISO).getTime()) return void toast.error('Итоги должны быть позже начала')

    const fields: GiveawayDraftFields = {
      title: t,
      text: text.trim(),
      prizes: pr.prizes,
      channels: cleanChannelList(channels),
      buttonStyle,
      buttonEmoji: buttonEmoji.trim() || '🎉',
      buttonEmojiId: buttonEmojiId.trim(),
      startAt: startISO,
      endAt: endISO,
    }
    setSaving(true)
    try {
      const payload: GiveawayActionPayload = editingId ? { action: 'update', id: editingId, ...fields } : { action: 'create', ...fields }
      await giveawayAction(payload)
      toast.success(editingId ? 'Черновик обновлён' : 'Черновик создан — жмём «Опубликовать»')
      resetComposer()
      setLocalTick((t2) => t2 + 1)
    } catch (e) {
      if (!isAuthOrNetworkError(e)) toast.error(e instanceof PanelError ? e.message : 'Не получилось')
    } finally {
      setSaving(false)
    }
  }

  /* ---------- живое превью (debounce 500мс) ---------- */

  const draftPrizes = buildPrizes(prizes)
  const previewKey = composerOpen
    ? JSON.stringify({
        title: title.trim(),
        text: text.trim(),
        prizes: draftPrizes.ok ? draftPrizes.prizes : null,
        channels: cleanChannelList(channels),
        endAt: localToIso(endAt),
      })
    : ''
  const debouncedPreviewKey = useDebouncedValue(previewKey, 500)

  useEffect(() => {
    if (!debouncedPreviewKey) return
    let body: { title: string; text: string; prizes: GiveawayPrize[] | null; channels: string[]; endAt: string | null }
    try {
      body = JSON.parse(debouncedPreviewKey) as typeof body
    } catch {
      return
    }
    if (!body.prizes) return // призы ещё не заполнены — превью не трогаем
    let alive = true
    setPreviewBusy(true)
    giveawayPreview({
      title: body.title || 'Розыгрыш',
      text: body.text,
      prizes: body.prizes,
      channels: body.channels,
      endAt: body.endAt ?? new Date(Date.now() + 3 * 86_400_000).toISOString(),
    })
      .then((html) => {
        if (alive) setPreviewHtml(html)
      })
      .catch(() => {
        /* превью необязательно: ошибки не всплываем (401 разлогинит сам) */
      })
      .finally(() => {
        if (alive) setPreviewBusy(false)
      })
    return () => {
      alive = false
    }
  }, [debouncedPreviewKey])

  /* ---------- рендер ---------- */

  return (
    <motion.div variants={fadeUp} initial="hidden" animate="show" className="space-y-4">
      {/* Заголовок + кнопки */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900">
            <Gift className="size-4 text-emerald-600" aria-hidden /> Розыгрыши
          </h2>
          <p className="mt-0.5 max-w-xl text-xs text-slate-500">
            Конкурсы в Telegram-канале: пост с кнопкой «Участвовать», автопроверка подписок, итоги публикует бот
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={sweep} className={btnOutlineDark}>
            <Timer aria-hidden /> Прогон планировщика
          </Button>
          <Button variant="outline" size="sm" disabled={loading} onClick={() => setLocalTick((t) => t + 1)} className={btnOutlineDark}>
            <RefreshCw aria-hidden /> Обновить
          </Button>
        </div>
      </div>

      {/* Канал публикации + создание */}
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="gw-channel" className="text-xs font-semibold text-slate-700">
          Канал публикации
        </label>
        <div className="flex h-9 items-center rounded-md border border-slate-200 bg-slate-100 pl-2.5">
          <span className="text-sm text-slate-500" aria-hidden>@</span>
          <input
            id="gw-channel" value={channelDraft} onChange={(e) => setChannelDraft(e.target.value.replace(/^@/, ''))}
            onBlur={() => void saveChannel()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            placeholder="SnapTeamDev" disabled={busy}
            className="h-full w-40 rounded-r-md bg-transparent px-1.5 text-sm text-slate-800 outline-none placeholder:text-slate-400"
          />
        </div>
        <span className="text-[11px] text-slate-400">пост выйдет сюда (Enter / фокус — сохранить)</span>
        <Button onClick={() => (composerOpen ? resetComposer() : setComposerOpen(true))} className="ml-auto h-9 bg-emerald-600 text-white hover:bg-emerald-700">
          {composerOpen ? <X aria-hidden /> : <Plus aria-hidden />}
          {composerOpen ? 'Свернуть' : 'Создать розыгрыш'}
        </Button>
      </div>

      {/* Конструктор (раскрывающаяся карточка + живое превью) */}
      {composerOpen && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="space-y-4">
              {/* Название */}
              <div>
                <label htmlFor="gw-title" className="text-xs font-semibold text-slate-700">
                  Название
                </label>
                <Input id="gw-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="Розыгрыш 10 000 свайпов" disabled={saving} className={cn('mt-1 h-9 text-sm', inputDark)} />
              </div>

              {/* Описание */}
              <div>
                <label htmlFor="gw-text" className="text-xs font-semibold text-slate-700">
                  Описание / условия
                </label>
                <Textarea id="gw-text" value={text} maxLength={3500} rows={4} onChange={(e) => setText(e.target.value)} placeholder="Условия конкурса, призы, сроки…" disabled={saving} className={cn('mt-1 text-sm', inputDark)} />
                <p className="mt-1 text-[11px] text-slate-500">
                  Markdown поддерживается: **жирный**, __курсив__ · {text.length}/3500
                </p>
              </div>

              {/* Призы */}
              <div>
                <span className="text-xs font-semibold text-slate-700">
                  Призы · всего мест: <span className="tabular-nums">{totalPlaces}</span>
                </span>
                <div className="mt-1.5 space-y-2">
                  {prizes.map((p, idx) => (
                    <div key={idx} className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 p-2">
                      <select value={p.kind} aria-label="Тип приза" disabled={saving} onChange={(e) => updatePrize(idx, { kind: e.target.value as PrizeKind })} className={cn(SELECT_CLS, 'w-28')}>
                        {PRIZE_KINDS.map((k) => (
                          <option key={k.value} value={k.value}>
                            {k.label}
                          </option>
                        ))}
                      </select>
                      {p.kind === 'swipes' && (
                        <Input type="number" min={1} value={p.amount} onChange={(e) => updatePrize(idx, { amount: e.target.value })} placeholder="1000" aria-label="Количество свайпов" disabled={saving} className={cn('h-9 w-32 text-sm', inputDark)} />
                      )}
                      {p.kind === 'rub' && (
                        <Input type="number" step="0.01" min={0.01} value={p.amount} onChange={(e) => updatePrize(idx, { amount: e.target.value })} placeholder="1000.00 ₽" aria-label="Сумма в рублях" disabled={saving} className={cn('h-9 w-32 text-sm', inputDark)} />
                      )}
                      {p.kind === 'tier' && (
                        <>
                          <select value={p.amount === '2' ? '2' : '1'} aria-label="Тариф" disabled={saving} onChange={(e) => updatePrize(idx, { amount: e.target.value })} className={cn(SELECT_CLS, 'w-24')}>
                            <option value="1">Плюс</option>
                            <option value="2">Про</option>
                          </select>
                          <Input type="number" min={0} value={p.periodDays} onChange={(e) => updatePrize(idx, { periodDays: e.target.value })} placeholder="дней" aria-label="Период тарифа, дней" disabled={saving} className={cn('h-9 w-24 text-sm', inputDark)} />
                        </>
                      )}
                      {p.kind === 'custom' && <Input value="" disabled placeholder="сумма не нужна" aria-label="Сумма не нужна" className="h-9 w-32 text-sm" />}
                      <div className="flex items-center gap-1">
                        <Input type="number" min={1} max={1000} value={p.winners} onChange={(e) => updatePrize(idx, { winners: e.target.value })} placeholder="1" aria-label="Призовых мест" disabled={saving} className={cn('h-9 w-16 text-sm', inputDark)} />
                        <span className="text-xs text-slate-500">мест</span>
                      </div>
                      <Input value={p.label} maxLength={120} onChange={(e) => updatePrize(idx, { label: e.target.value })} placeholder="название приза (пусто — авто)" aria-label="Название приза" disabled={saving} className={cn('h-9 min-w-44 flex-1 text-sm', inputDark)} />
                      <button type="button" onClick={() => setPrizes((rows) => rows.filter((_, i) => i !== idx))} aria-label="Удалить приз" disabled={saving} className="flex size-8 shrink-0 items-center justify-center rounded-md text-slate-400 transition hover:bg-red-50 hover:text-red-600">
                        <X className="size-4" aria-hidden />
                      </button>
                    </div>
                  ))}
                </div>
                <Button variant="outline" size="sm" disabled={saving || prizes.length >= 20} onClick={() => setPrizes((rows) => [...rows, newPrizeRow()])} className={cn('mt-2 h-8', btnOutlineDark)}>
                  <Plus aria-hidden /> Добавить приз
                </Button>
              </div>

              {/* Обязательные каналы */}
              <div>
                <span className="text-xs font-semibold text-slate-700">Обязательные каналы</span>
                <div className="mt-1.5 space-y-2">
                  {channels.map((c, idx) => (
                    <div key={idx} className="flex items-center gap-1.5">
                      <span className="text-sm text-slate-400" aria-hidden>
                        @
                      </span>
                      <Input value={c} onChange={(e) => setChannels((cs) => cs.map((v, i) => (i === idx ? e.target.value : v)))} placeholder="channel_username" aria-label="Юзернейм канала" disabled={saving} className={cn('h-9 w-52 text-sm', inputDark)} />
                      <button type="button" onClick={() => setChannels((cs) => cs.filter((_, i) => i !== idx))} aria-label="Удалить канал" disabled={saving} className="flex size-8 items-center justify-center rounded-md text-slate-400 transition hover:bg-red-50 hover:text-red-600">
                        <X className="size-4" aria-hidden />
                      </button>
                    </div>
                  ))}
                </div>
                <Button variant="outline" size="sm" disabled={saving || channels.length >= 10} onClick={() => setChannels((cs) => [...cs, ''])} className={cn('mt-2 h-8', btnOutlineDark)}>
                  <Plus aria-hidden /> Канал
                </Button>
                <p className="mt-1 text-[11px] text-slate-500">Бот должен быть админом этих каналов для автопроверки подписок</p>
              </div>

              {/* Кнопка: цвет + эмодзи + премиум-ID */}
              <div>
                <span className="text-xs font-semibold text-slate-700">Кнопка</span>
                <div className="mt-1.5 flex flex-wrap items-center gap-3">
                  <div className="flex gap-1.5">
                    {BUTTON_STYLES.map((s) => (
                      <button
                        key={s.value} type="button" aria-pressed={buttonStyle === s.value} aria-label={`Кнопка: ${s.label}`} disabled={saving}
                        onClick={() => setButtonStyle(s.value)}
                        className={cn(
                          'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition',
                          buttonStyle === s.value ? 'border-slate-400 ring-2 ring-slate-200' : 'border-slate-200 hover:bg-slate-50',
                        )}
                      >
                        <span className={cn('size-3.5 rounded-full', BTN_BG[s.value])} aria-hidden />
                        {s.label}
                      </button>
                    ))}
                  </div>
                  <Input value={buttonEmoji} maxLength={16} onChange={(e) => setButtonEmoji(e.target.value)} placeholder="🎉" aria-label="Эмодзи кнопки" disabled={saving} className={cn('h-9 w-20 text-center text-sm', inputDark)} />
                  <Input value={buttonEmojiId} maxLength={64} onChange={(e) => setButtonEmojiId(e.target.value)} placeholder="custom_emoji_id (премиум)" aria-label="ID премиум-эмодзи" disabled={saving} className={cn('h-9 min-w-52 flex-1 font-mono text-sm', inputDark)} />
                </div>
                <p className="mt-1 text-[11px] text-slate-500">ID премиум-эмодзи для иконки кнопки — панель Бот → Захваченные</p>
              </div>

              {/* Время */}
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="gw-start" className="text-xs font-semibold text-slate-700">
                    Начало
                  </label>
                  <Input id="gw-start" type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} disabled={saving} className={cn('mt-1 h-9 text-sm', inputDark)} />
                </div>
                <div>
                  <label htmlFor="gw-end" className="text-xs font-semibold text-slate-700">
                    Итоги
                  </label>
                  <Input id="gw-end" type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} disabled={saving} className={cn('mt-1 h-9 text-sm', inputDark)} />
                </div>
              </div>
              <p className="text-[11px] text-slate-500">startAt в будущем → бот опубликует сам по расписанию</p>

              {/* Сохранение */}
              <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                <Button size="sm" disabled={saving || busy} onClick={() => void saveDraft()} className="h-9 bg-emerald-600 text-white hover:bg-emerald-700">
                  {saving && <Loader2 className="animate-spin" aria-hidden />} Сохранить черновик
                </Button>
                <Button variant="outline" size="sm" disabled={saving} onClick={resetComposer} className={cn('h-9', btnOutlineDark)}>Отмена</Button>
                {editingId && <span className="text-xs text-slate-500">правка черновика</span>}
              </div>
            </div>
          </div>

          {/* Живое превью — телефонная карточка */}
          <div>
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-slate-700">
              Превью поста
              {previewBusy && <Loader2 className="size-3.5 animate-spin text-slate-400" aria-hidden />}
            </div>
            <div className="rounded-[20px] border border-slate-200 bg-white p-3 shadow-sm">
              {previewHtml ? (
                <div
                  className="min-h-24 text-[13px] leading-snug text-slate-900 [overflow-wrap:anywhere] [&_a]:text-sky-600 [&_a]:underline"
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                />
              ) : (
                <p className="min-h-24 text-[13px] text-slate-400">Заполните название и призы — превью поста появится здесь</p>
              )}
              <div className="mt-3 flex justify-center">
                <span className={cn('inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold text-white', BTN_BG[buttonStyle])}>
                  <span aria-hidden>{buttonEmoji.trim() || '🎉'}</span> Участвовать (17)
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Список розыгрышей */}
      <Card className={panelCard}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base text-slate-900">
            <Trophy className="size-4 text-amber-500" aria-hidden /> Список розыгрышей
          </CardTitle>
          <CardDescription className="text-xs text-slate-500">Новые сверху · максимум 100</CardDescription>
        </CardHeader>
        <CardContent>
          {loading && !data ? (
            <SkeletonRows rows={4} />
          ) : error && !data ? (
            <EmptyState
              icon={AlertTriangle} title="Не удалось загрузить розыгрыши" hint={error}
              action={
                <Button variant="outline" size="sm" onClick={() => setLocalTick((t) => t + 1)} className={btnOutlineDark}>
                  <RefreshCw aria-hidden /> Повторить
                </Button>
              }
            />
          ) : data && data.items.length === 0 ? (
            <EmptyState icon={Gift} title="Розыгрышей пока нет" hint="Соберите первый конкурс кнопкой «Создать розыгрыш»" />
          ) : data ? (
            <div className="space-y-3">
              {data.items.map((item) => (
                <GiveawayCard
                  key={item.id}
                  item={item}
                  publishChannel={data.publishChannel}
                  busy={busy}
                  onPublish={publish}
                  onEdit={startEdit}
                  onCancel={cancel}
                  onFinalize={finalize}
                  onDelete={remove}
                  onParticipants={openParticipants}
                />
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* ===== v5.46: модал участников розыгрыша ===== */}
      {pModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Участники: ${pModal.title}`}
          onClick={() => setPModal(null)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 border-b border-slate-200 px-5 py-4">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-slate-900">Участники · {pModal.title}</p>
                <p className="text-xs text-slate-500">
                  {pEntries ? `${pEntries.length} заявок · сортировка по билетам` : 'Загрузка…'}
                  {typeof pModal.losersRewardSwipes === 'number' && pModal.losersRewardSwipes > 0
                    ? ` · утешение ${pModal.losersRewardSwipes} свайпов`
                    : ''}
                </p>
              </div>
              <Button variant="outline" size="sm" className={btnOutlineDark} onClick={() => setPModal(null)}>
                <X aria-hidden /> Закрыть
              </Button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
              {pLoading && (
                <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
                  <Loader2 className="size-4 animate-spin" aria-hidden /> Загружаю участников…
                </div>
              )}
              {!pLoading && pError && (
                <div className="py-10 text-center">
                  <p className="text-sm text-red-600">{pError}</p>
                  <Button variant="outline" size="sm" className={cn('mt-3', btnOutlineDark)} onClick={() => void openParticipants(pModal)}>
                    <RefreshCw aria-hidden /> Повторить
                  </Button>
                </div>
              )}
              {!pLoading && !pError && pEntries && pEntries.length === 0 && (
                <EmptyState icon={Users} title="Заявок пока нет" hint="Как только юзеры нажмут «Участвовать» или заработают первый билет — они появятся здесь" />
              )}
              {!pLoading && !pError && pEntries && pEntries.length > 0 && (
                <ul className="divide-y divide-slate-100">
                  {pEntries.map((row, i) => (
                    <li key={row.userId} className="flex items-center gap-3 py-2.5">
                      <span className="w-8 shrink-0 text-center text-xs font-semibold text-slate-400 tabular-nums">
                        {i < 3 && row.winner ? ['🥇', '🥈', '🥉'][i] : i + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-1.5 truncate text-sm font-medium text-slate-900">
                          {row.name}
                          {row.username && <span className="text-xs text-slate-400">@{row.username}</span>}
                          {row.winner && (
                            <Badge variant="outline" className="rounded-full border-emerald-200 bg-emerald-50 text-[10px] font-semibold text-emerald-700">
                              победитель
                            </Badge>
                          )}
                          {row.ticketsCount === 0 && (
                            <Badge variant="outline" className="rounded-full text-[10px] text-slate-400">
                              0 билетов — в выборе не участвует
                            </Badge>
                          )}
                        </p>
                        <p className="mt-0.5 flex flex-wrap gap-1 text-[11px] text-slate-500">
                          {row.tasksDone.length > 0 ? (
                            row.tasksDone.map((td, j) => (
                              <span key={j} className="rounded-full bg-amber-50 px-1.5 py-0.5 font-medium text-amber-700">
                                🎫 +{td.tickets} за {td.task === 'activity' ? 'активность' : td.task === 'promo' ? 'промокод' : td.task === 'referral' ? 'рефералов' : td.task === 'boost' ? 'буст' : 'ручное'}
                              </span>
                            ))
                          ) : (
                            <span>заданий пока не выполнено</span>
                          )}
                        </p>
                      </div>
                      <span className="shrink-0 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-800 tabular-nums">
                        🎫 {row.ticketsCount}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </motion.div>
  )
}
