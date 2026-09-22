'use client'

/**
 * КОШЕЛЁК v2 (v5.77) — полная страница вместо плашки в профиле.
 *
 * План интерфейса (по референсу владельца, без лишнего):
 *   ← Кошелёк
 *   [Swipe-счёт | Рубль-счёт]  ← бабл-вкладки
 *   Баланс (крупно) + адрес счёта (копирование)
 *   Перевести · Пополнить · Вывести · Обменять · Промокод   ← 5 кнопок (v5.85: +промокод)
 *   Счета (две строки с адресами и балансами)
 *   Рефералка: ссылка · друзья · заработано (5% от трат друзей)
 *   История: «адрес → адрес, сколько, когда» — как в крипте
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ArrowDownLeft,
  ArrowDownUp,
  ArrowLeftRight,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Copy,
  Gift,
  Loader2,
  Plus,
  Send,
  Ticket,
  Users,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { haptic } from '@/lib/tg'
import { useApp } from '@/lib/store'
import { SwipeIcon } from '@/components/tg/SwipeIcon'
import { TopUpModal } from '@/components/tabs/TopUpModal'
import { Portal } from '@/components/ui/Portal'

type FeedItem =
  | {
      type: 'tx'
      id: string
      kind: string
      currency: 'swp' | 'rub' | string
      amount: number
      direction: 'in' | 'out' | 'self'
      counterparty: string | null
      note: string | null
      createdAt: string
    }
  | {
      type: 'log'
      id: string
      kind: string
      currency: string
      amount: number
      note: string | null
      createdAt: string
    }

type WalletData = {
  ok: boolean
  balanceKop: number
  swipes: number
  swpPerRub: number
  swpConvertMin: number
  swipeAddress: string | null
  rubAddress: string | null
  refPercent: number
  refEarned: number
  refInvited: number
  refLink: string | null
  feed: FeedItem[]
}

function fmtRub(kop: number): string {
  const v = Math.abs(kop) / 100
  const [int, frac] = v.toFixed(2).split('.')
  const intSpaced = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `${kop < 0 ? '−' : ''}${intSpaced},${frac} ₽`
}

function fmtNum(n: number): string {
  return n.toLocaleString('ru-RU')
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  return sameDay
    ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
}

const LOG_LABEL: Record<string, string> = {
  topup: 'Пополнение',
  convert: 'Обмен',
  ai_spend: 'Нейросети',
  purchase: 'Покупка',
  ad_campaign: 'Реклама',
  refund: 'Возврат',
  admin: 'Корректировка',
  quest: 'Задание',
  level_up: 'Новый уровень',
}

type SheetKind = 'transfer' | 'convert' | 'withdraw' | 'promo' | null

export function WalletPage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [data, setData] = useState<WalletData | null>(null)
  const [failed, setFailed] = useState(false)
  const [account, setAccount] = useState<'swp' | 'rub'>('swp')
  const [sheet, setSheet] = useState<SheetKind>(null)
  const [topUpOpen, setTopUpOpen] = useState(false)
  const patchBalance = useApp((s) => s.patchBalance)

  const load = useCallback(() => {
    api<WalletData>('/api/wallet')
      .then((r) => {
        setData(r)
        setFailed(false)
        patchBalance({ balanceKop: r.balanceKop, swipes: r.swipes })
      })
      .catch(() => {
        // Есть данные с прошлого раза — молча оставляем их (не мигаем ошибкой);
        // первый неудачный запрос → блок «Повторить» вместо пустого экрана
        setFailed(true)
        setData((d) => d)
      })
  }, [patchBalance])

  useEffect(() => {
    if (open) load()
  }, [open])

  const copy = useCallback((text: string, label: string) => {
    haptic('light')
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success(`${label} скопирован`))
      .catch(() => toast.error('Не удалось скопировать'))
  }, [])

  const address = account === 'swp' ? data?.swipeAddress : data?.rubAddress
  const balance =
    account === 'swp' ? (data ? `${fmtNum(data.swipes)} SWP` : '…') : data ? fmtRub(data.balanceKop) : '…'

  return (
    <Portal>
    <AnimatePresence>
      {open && (
        <motion.div
          key="wallet-page"
          initial={{ opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 24 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="fixed inset-0 z-[80] flex flex-col bg-tg-bg"
          role="dialog"
          aria-label="Кошелёк"
        >
          {/* Шапка */}
          <header className="flex items-center gap-2 px-2 pb-1 pt-3">
            <button
              type="button"
              onClick={() => {
                haptic('light')
                onClose()
              }}
              aria-label="Назад"
              className="rounded-full p-2.5 text-tg-text transition active:bg-tg-surface"
            >
              <ChevronLeft className="h-6 w-6" />
            </button>
            <h1 className="text-[19px] font-bold text-tg-text">Кошелёк</h1>
          </header>

          <div className="no-scrollbar flex-1 overflow-y-auto overscroll-contain pb-10">
            {/* Бабл-вкладки счетов */}
            <div className="flex justify-center gap-2 px-4 pb-1 pt-2" role="tablist" aria-label="Счёт">
              {(
                [
                  { id: 'swp', label: 'Swipe-счёт' },
                  { id: 'rub', label: 'Рубль-счёт' },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={account === t.id}
                  onClick={() => {
                    haptic('light')
                    setAccount(t.id)
                  }}
                  className={cn(
                    'h-9 rounded-full px-4 text-[14px] font-semibold transition active:scale-95',
                    account === t.id ? 'bg-tg-link text-white shadow-sm' : 'bg-tg-surface text-tg-hint',
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Баланс + адрес */}
            <div className="flex flex-col items-center px-4 pb-4 pt-3">
              <div className="text-[13px] text-tg-hint">Баланс</div>
              <div className="mt-1 flex items-center gap-2 text-[38px] font-bold leading-none text-tg-text">
                {account === 'swp' && <SwipeIcon className="h-8 w-8 text-tg-link" />}
                {balance}
              </div>
              {/* v5.78: сразу отвечаем на главный вопрос «а сколько это в деньгах» */}
              {data && (
                <div className="mt-1.5 text-[13px] text-tg-hint">
                  {account === 'swp'
                    ? `≈ ${fmtRub(Math.round((data.swipes / data.swpPerRub) * 100))} · ${fmtNum(data.swpPerRub)} свайпов = 1 ₽`
                    : `1 ₽ = ${fmtNum(data.swpPerRub)} свайпов`}
                </div>
              )}
              {address && (
                <button
                  type="button"
                  onClick={() => copy(address, 'Адрес')}
                  className="mt-2.5 flex items-center gap-1.5 rounded-full bg-tg-surface px-3 py-1.5 text-[13px] font-medium text-tg-hint transition active:scale-95"
                >
                  {address}
                  <Copy className="h-3.5 w-3.5" aria-hidden />
                </button>
              )}
            </div>

            {/* 5 действий (v5.85: +«Промокод» — владелец не находил её в старой карточке) */}
            <div className="grid grid-cols-5 gap-1.5 px-4">
              {(
                [
                  { id: 'transfer', label: 'Перевести', icon: Send },
                  { id: 'topup', label: 'Пополнить', icon: Plus },
                  { id: 'withdraw', label: 'Вывести', icon: ArrowUpRight },
                  { id: 'convert', label: 'Обменять', icon: ArrowDownUp },
                  { id: 'promo', label: 'Промокод', icon: Ticket },
                ] as const
              ).map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => {
                    haptic('light')
                    if (a.id === 'topup') setTopUpOpen(true)
                    else setSheet(a.id as Exclude<SheetKind, null> | 'topup' as SheetKind)
                  }}
                  className="flex flex-col items-center gap-1.5 rounded-2xl bg-tg-surface py-3 transition active:scale-95"
                >
                  <a.icon className={cn('text-tg-text', a.id === 'promo' ? 'h-5.5 w-5.5 text-tg-link' : 'h-5.5 w-5.5')} strokeWidth={1.9} aria-hidden />
                  <span className="max-w-full truncate px-0.5 text-[11.5px] font-medium text-tg-text">{a.label}</span>
                </button>
              ))}
            </div>

            {/* v5.78: другой счёт одной строкой (раньше был дублирующий блок
                «Счета» с обоими адресами — та же информация, что сверху, —
                и страница выглядела перегруженной). Тап — мгновенное переключение. */}
            {data && (() => {
              const otherId: 'swp' | 'rub' = account === 'swp' ? 'rub' : 'swp'
              const isSwp = otherId === 'swp'
              return (
                <button
                  type="button"
                  onClick={() => {
                    haptic('light')
                    setAccount(otherId)
                  }}
                  className="mx-4 mt-3 flex w-[calc(100%-32px)] items-center gap-3 rounded-2xl border border-tg-sep/60 px-4 py-3 text-left transition active:bg-tg-surface/60"
                >
                  <span
                    className={cn(
                      'flex h-10 w-10 items-center justify-center rounded-full',
                      isSwp ? 'bg-tg-link/15 text-tg-link' : 'bg-emerald-500/15 text-emerald-500',
                    )}
                  >
                    {isSwp ? <SwipeIcon className="h-5 w-5" /> : <span className="text-[16px] font-bold">₽</span>}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12.5px] text-tg-hint">Другой счёт</span>
                    <span className="block text-[15px] font-semibold text-tg-text">
                      {isSwp ? 'Swipe-счёт' : 'Рубль-счёт'} · {isSwp ? `${fmtNum(data.swipes)} SWP` : fmtRub(data.balanceKop)}
                    </span>
                  </span>
                  <ChevronRight className="h-5 w-5 shrink-0 text-tg-hint" aria-hidden />
                </button>
              )
            })()}

            {/* Рефералка */}
            {data?.refLink && (
              <button
                type="button"
                onClick={() => copy(data.refLink!, 'Ссылка')}
                className="mx-4 mt-3 flex w-[calc(100%-32px)] items-center gap-3 rounded-2xl bg-tg-link/10 px-4 py-3 text-left transition active:scale-[0.99]"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-tg-link/15">
                  <Gift className="h-5 w-5 text-tg-link" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-semibold text-tg-text">Приглашай друзей</span>
                  <span className="flex items-center gap-3 text-[12.5px] text-tg-hint">
                    <span>{data.refPercent}% с их трат — твои</span>
                    <span className="flex items-center gap-1">
                      <Users className="h-3.5 w-3.5" aria-hidden /> {data.refInvited}
                    </span>
                    <span className="flex items-center gap-1">
                      <SwipeIcon className="h-3 w-3" /> +{fmtNum(data.refEarned)}
                    </span>
                  </span>
                </span>
                <Copy className="h-4.5 w-4.5 shrink-0 text-tg-link" aria-hidden />
              </button>
            )}

            {/* История */}
            <h2 className="px-5 pb-1 pt-5 text-[16px] font-bold text-tg-text">История</h2>
            {!data ? (
              failed ? (
                <button
                  type="button"
                  onClick={load}
                  className="mx-4 rounded-2xl bg-tg-surface px-4 py-4 text-[14px] text-tg-hint"
                >
                  Не удалось загрузить · Повторить
                </button>
              ) : (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-tg-hint" aria-hidden />
                </div>
              )
            ) : data.feed.length === 0 ? (
              <p className="px-5 py-4 text-[13.5px] leading-relaxed text-tg-hint">
                Пока операций нет — здесь появятся переводы, обмены и заработанные свайпы
              </p>
            ) : (
              <div className="mx-4 divide-y divide-tg-sep/50 overflow-hidden rounded-2xl border border-tg-sep/60">
                {data.feed.map((item) => (
                  <HistoryRow key={`${item.type}:${item.id}`} item={item} />
                ))}
              </div>
            )}
          </div>

          {/* Шиты действий */}
          <TransferSheet
            open={sheet === 'transfer'}
            account={account}
            onClose={() => setSheet(null)}
            onDone={() => {
              setSheet(null)
              load()
            }}
          />
          <ConvertSheet
            open={sheet === 'convert'}
            rate={data?.swpPerRub ?? 500}
            convertMin={data?.swpConvertMin ?? 500}
            onClose={() => setSheet(null)}
            onDone={() => {
              setSheet(null)
              load()
            }}
          />
          <WithdrawSheet
            open={sheet === 'withdraw'}
            onClose={() => setSheet(null)}
            onExchange={() => setSheet('convert')}
          />
          {/* v5.85: активация промокода — отдельная кнопка в ряду действий */}
          <PromoSheet
            open={sheet === 'promo'}
            onClose={() => setSheet(null)}
            onDone={() => {
              setSheet(null)
              load()
            }}
          />

          {/* Пополнение (существующий модал) */}
          <TopUpModal open={topUpOpen} onClose={() => setTopUpOpen(false)} onReload={load} />
        </motion.div>
      )}
    </AnimatePresence>
    </Portal>
  )
}

/* ------------------------------- История ------------------------------- */

function HistoryRow({ item }: { item: FeedItem }) {
  if (item.type === 'tx') {
    const isIn = item.direction === 'in'
    const isSelf = item.direction === 'self'
    const title =
      item.kind === 'ref_earn'
        ? `Реферальные ${item.counterparty ? `от ${item.counterparty}` : ''}`
        : isSelf
          ? item.note ?? 'Обмен между счетами'
          : isIn
            ? `Получено${item.counterparty ? ` от ${item.counterparty}` : ''}`
            : `Отправлено${item.counterparty ? ` к ${item.counterparty}` : ''}`
    const Icon = isSelf ? ArrowLeftRight : isIn ? ArrowDownLeft : ArrowUpRight
    return (
      <div className="flex items-center gap-3 px-4 py-3">
        <span
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
            isSelf ? 'bg-tg-hint/10 text-tg-hint' : isIn ? 'bg-emerald-500/15 text-emerald-500' : 'bg-red-500/10 text-red-500',
          )}
        >
          <Icon className="h-4.5 w-4.5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14.5px] font-medium text-tg-text">{title}</span>
          <span className="block text-[12px] text-tg-hint">{fmtTime(item.createdAt)}</span>
        </span>
        <span
          className={cn(
            'flex shrink-0 items-center gap-1 text-[14.5px] font-bold',
            isSelf ? 'text-tg-hint' : isIn ? 'text-emerald-500' : 'text-red-500',
          )}
        >
          {/* v5.78: рубли приходят КОПЕЙКАМИ — fmtRub, иначе «200 ₽» вместо «2,00 ₽» */}
          {isSelf ? '' : isIn ? '+' : '−'}
          {item.currency === 'swp' ? `${fmtNum(item.amount)} SWP` : fmtRub(item.amount)}
        </span>
      </div>
    )
  }

  // BalanceLog: внутренние проводки (пополнения, траты ИИ, задания…)
  const positive = item.amount > 0
  const label = LOG_LABEL[item.kind] ?? item.note ?? 'Операция'
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
          positive ? 'bg-emerald-500/15 text-emerald-500' : 'bg-tg-hint/10 text-tg-hint',
        )}
      >
        {positive ? <ArrowDownLeft className="h-4.5 w-4.5" aria-hidden /> : <ArrowUpRight className="h-4.5 w-4.5" aria-hidden />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14.5px] font-medium text-tg-text">{label}</span>
        <span className="block text-[12px] text-tg-hint">{fmtTime(item.createdAt)}</span>
      </span>
      <span
        className={cn(
          'shrink-0 text-[14.5px] font-bold',
          positive ? 'text-emerald-500' : 'text-tg-hint',
        )}
      >
        {/* v5.78: рубли приходят КОПЕЙКАМИ — fmtRub (см. выше) */}
        {positive ? '+' : '−'}
        {item.currency === 'swp' ? `${fmtNum(Math.abs(item.amount))} SWP` : fmtRub(Math.abs(item.amount))}
      </span>
    </div>
  )
}

/* --------------------------- Шит «Перевести» --------------------------- */

function TransferSheet({
  open,
  account,
  onClose,
  onDone,
}: {
  open: boolean
  account: 'swp' | 'rub'
  onClose: () => void
  onDone: () => void
}) {
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const swipes = useApp((s) => s.balance?.swipes ?? 0)
  const balanceKop = useApp((s) => s.balance?.balanceKop ?? 0)
  /*
   * v5.78: для рублей пользователь вводит РУБЛИ (как видит в балансе),
   * сервер принимает КОПЕЙКИ — раньше input молча ждал копейки: «Всё»
   * подставляло 150000 при балансе «1 500,00 ₽», и введённые «1500»
   * уходили как 15 ₽. Теперь конвертация на границе UI/API.
   */
  const maxAmount = account === 'swp' ? swipes : Math.floor(balanceKop / 100)

  useEffect(() => {
    if (open) {
      setTo('')
      setAmount('')
    }
  }, [open])

  const submit = async () => {
    const raw = Number(amount)
    if (!to.trim() || !Number.isFinite(raw) || raw <= 0) return
    // свайпы — целые; рубли — на сервер уходим копейками
    const amt = account === 'swp' ? Math.floor(raw) : Math.round(raw * 100)
    if (amt <= 0) return
    setBusy(true)
    try {
      const r = await api<{ ok: boolean; amount: number; toLabel: string | null }>('/api/wallet/transfer', {
        method: 'POST',
        body: JSON.stringify({ to: to.trim(), amount: amt, currency: account }),
      })
      haptic('success')
      toast.success(
        `Отправлено ${account === 'swp' ? `${fmtNum(r.amount)} SWP` : fmtRub(r.amount)}${r.toLabel ? ` → ${r.toLabel}` : ''}`,
      )
      onDone()
    } catch (e) {
      toast.error((e as Error).message || 'Перевод не удался')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <SheetShell title="Перевести" onClose={onClose}>
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium text-tg-hint">
              Кому — адрес счёта или @username
            </span>
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="SWP-XXXX-XXXX или @nickname"
              autoFocus
              className="h-12 w-full rounded-xl border border-tg-sep bg-tg-bg px-4 text-[16px] text-tg-text outline-none focus:border-tg-link"
            />
          </label>
          <label className="mt-3 block">
            <span className="mb-1.5 flex items-center justify-between text-[13px] font-medium text-tg-hint">
              {account === 'swp' ? 'Сколько свайпов' : 'Сколько рублей'}
              <button
                type="button"
                onClick={() => setAmount(String(maxAmount))}
                className="rounded-full bg-tg-surface px-2.5 py-0.5 text-[12px] font-semibold text-tg-link"
              >
                Всё ({fmtNum(maxAmount)})
              </button>
            </span>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(account === 'swp' ? /[^\d]/g : /[^\d.,]/g, '').replace(',', '.'))}
              inputMode="decimal"
              placeholder={account === 'swp' ? '0' : '0,00'}
              className="h-12 w-full rounded-xl border border-tg-sep bg-tg-bg px-4 text-[16px] text-tg-text outline-none focus:border-tg-link"
            />
          </label>
          <button
            type="button"
            disabled={busy || !to.trim() || !Number(amount)}
            onClick={submit}
            className="mt-4 flex h-12 w-full items-center justify-center rounded-xl bg-tg-link text-[15px] font-semibold text-white transition active:scale-[0.98] disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : 'Перевести'}
          </button>
        </SheetShell>
      )}
    </AnimatePresence>
  )
}

/* --------------------------- Шит «Обменять» --------------------------- */

function ConvertSheet({
  open,
  rate,
  convertMin,
  onClose,
  onDone,
}: {
  open: boolean
  rate: number
  convertMin: number
  onClose: () => void
  onDone: () => void
}) {
  const [dir, setDir] = useState<'swp2rub' | 'rub2swp'>('swp2rub')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const swipes = useApp((s) => s.balance?.swipes ?? 0)
  const balanceKop = useApp((s) => s.balance?.balanceKop ?? 0)

  useEffect(() => {
    if (open) setAmount('')
  }, [open])

  /*
   * v5.78: рубли теперь вводятся В РУБЛЯХ (сервер по-прежнему ждёт копейки —
   * конвертируем при отправке). Живое превью «получишь N» — чтобы обмен был
   * понятен до нажатия кнопки.
   */
  const numeric = Number(amount.replace(',', '.'))
  const insufficient =
    dir === 'swp2rub'
      ? numeric > swipes
      : Math.round(numeric * 100) > balanceKop
  const canSubmit =
    Number.isFinite(numeric) &&
    numeric > 0 &&
    !insufficient &&
    (dir === 'swp2rub' ? numeric >= convertMin : numeric * 100 >= 1)

  const submit = async () => {
    if (!canSubmit) return
    // сервер: swp2rub — свайпы; rub2swp — КОПЕЙКИ
    const amt = dir === 'swp2rub' ? Math.floor(numeric) : Math.round(numeric * 100)
    setBusy(true)
    try {
      await api('/api/wallet', {
        method: 'POST',
        body: JSON.stringify({ action: dir, amount: amt }),
      })
      haptic('success')
      toast.success(
        dir === 'swp2rub'
          ? `Обменяно: ${fmtNum(Math.floor(numeric))} SWP → ${fmtRub(Math.floor(numeric / rate) * 100)}`
          : `Обменяно: ${fmtRub(Math.round(numeric * 100))} → ${fmtNum(Math.round(numeric * rate))} SWP`,
      )
      onDone()
    } catch (e) {
      toast.error((e as Error).message || 'Обмен не удался')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <SheetShell title="Обменять" onClose={onClose}>
          <div className="grid grid-cols-2 gap-2" role="tablist" aria-label="Направление обмена">
            {(
              [
                { id: 'swp2rub', label: 'SWP → ₽' },
                { id: 'rub2swp', label: '₽ → SWP' },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={dir === t.id}
                onClick={() => {
                  haptic('light')
                  setDir(t.id)
                  setAmount('')
                }}
                className={cn(
                  'h-10 rounded-xl text-[14px] font-semibold transition active:scale-95',
                  dir === t.id ? 'bg-tg-link text-white' : 'bg-tg-surface text-tg-hint',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <label className="mt-3 block">
            <span className="mb-1.5 flex items-center justify-between text-[13px] font-medium text-tg-hint">
              {dir === 'swp2rub' ? `Свайпы (мин. ${fmtNum(convertMin)})` : 'Рубли'}
              <button
                type="button"
                onClick={() =>
                  setAmount(String(dir === 'swp2rub' ? swipes : Math.floor(balanceKop / 100)))
                }
                className="rounded-full bg-tg-surface px-2.5 py-0.5 text-[12px] font-semibold text-tg-link"
              >
                Всё
              </button>
            </span>
            <input
              value={amount}
              onChange={(e) =>
                setAmount(e.target.value.replace(dir === 'swp2rub' ? /[^\d]/g : /[^\d.,]/g, '').replace(',', '.'))
              }
              inputMode="decimal"
              placeholder={dir === 'swp2rub' ? '0' : '0,00'}
              className="h-12 w-full rounded-xl border border-tg-sep bg-tg-bg px-4 text-[16px] text-tg-text outline-none focus:border-tg-link"
            />
          </label>
          {/* Живое превью результата — обмен понятен до нажатия кнопки */}
          <div className="mt-2 min-h-[20px] text-center text-[13px] text-tg-hint">
            {Number.isFinite(numeric) && numeric > 0 ? (
              insufficient ? (
                <span className="text-red-500">
                  {dir === 'swp2rub' ? 'Недостаточно свайпов' : 'Недостаточно рублей'}
                </span>
              ) : (
                <span>
                  Получишь{' '}
                  <b className="font-semibold text-tg-text">
                    {dir === 'swp2rub'
                      ? fmtRub(Math.floor(numeric / rate) * 100)
                      : `${fmtNum(Math.round(numeric * rate))} SWP`}
                  </b>
                </span>
              )
            ) : (
              `Курс: ${fmtNum(rate)} свайпов = 1 ₽`
            )}
          </div>
          <button
            type="button"
            disabled={busy || !canSubmit}
            onClick={submit}
            className="mt-3 flex h-12 w-full items-center justify-center rounded-xl bg-tg-link text-[15px] font-semibold text-white transition active:scale-[0.98] disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : 'Обменять'}
          </button>
        </SheetShell>
      )}
    </AnimatePresence>
  )
}

/* --------------------------- Шит «Вывести» --------------------------- */

function WithdrawSheet({
  open,
  onClose,
  onExchange,
}: {
  open: boolean
  onClose: () => void
  onExchange: () => void
}) {
  return (
    <AnimatePresence>
      {open && (
        <SheetShell title="Вывести" onClose={onClose}>
          <p className="text-[14.5px] leading-relaxed text-tg-text">
            Вывод на карту — скоро.
          </p>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-tg-hint">
            А свайпы уже можно превратить в рубли кнопкой «Обменять»: рубли работают
            внутри сервиса — нейросети, продвижение канала, задания.
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={onExchange}
              className="flex h-12 items-center justify-center rounded-xl bg-tg-link text-[15px] font-semibold text-white transition active:scale-[0.98]"
            >
              Обменять свайпы
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex h-12 items-center justify-center rounded-xl bg-tg-surface text-[15px] font-semibold text-tg-text transition active:scale-[0.98]"
            >
              Понятно
            </button>
          </div>
        </SheetShell>
      )}
    </AnimatePresence>
  )
}

/* --------------------------- Оболочка шита --------------------------- */

/**
 * v5.85: шит «Промокод» — владелец не находил кнопку активации (жила
 * свёрнутой в старой карточке кошелька, которой больше нет). Теперь это
 * полноценное действие кошелька: тап «Промокод» → ввод кода → мгновенное
 * зачисление награды (POST /api/promo/redeem).
 */
function PromoSheet({
  open,
  onClose,
  onDone,
}: {
  open: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) setCode('')
  }, [open])

  const redeem = async () => {
    const c = code.trim()
    if (!c || busy) return
    setBusy(true)
    try {
      const r = await api<{ ok: boolean; reward: string }>('/api/promo/redeem', {
        method: 'POST',
        body: JSON.stringify({ code: c }),
      })
      haptic('success')
      toast.success(`Промокод активирован: ${r.reward}`)
      onDone()
    } catch (e) {
      haptic('error')
      toast.error((e as Error).message || 'Не удалось активировать промокод')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <SheetShell title="Промокод" onClose={onClose}>
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium text-tg-hint">
              Введите код — награда придёт на счёт мгновенно
            </span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void redeem()
              }}
              placeholder="XXX-XXX-XXX"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              className="h-12 w-full rounded-xl border border-tg-sep bg-tg-bg px-4 text-center font-mono text-[16px] tracking-[0.12em] text-tg-text outline-none focus:border-tg-link placeholder:font-sans placeholder:tracking-normal placeholder:text-tg-hint"
            />
          </label>
          <button
            type="button"
            disabled={busy || !code.trim()}
            onClick={() => void redeem()}
            className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-tg-link text-[15px] font-semibold text-white transition active:scale-[0.98] disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : <Ticket className="h-4.5 w-4.5" aria-hidden />}
            {busy ? 'Активируем…' : 'Активировать'}
          </button>
          <p className="mt-3 text-center text-[12px] leading-snug text-tg-hint">
            Промокоды приходят в подарок и в розыгрышах — следите за новостями
          </p>
        </SheetShell>
      )}
    </AnimatePresence>
  )
}

function SheetShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[90] flex items-end justify-center bg-black/40 p-0"
      onClick={onClose}
      role="dialog"
      aria-label={title}
    >
      <motion.div
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', stiffness: 420, damping: 38 }}
        className="w-full max-w-[520px] rounded-t-3xl bg-tg-bg p-5 pb-[calc(20px+env(safe-area-inset-bottom))]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[17px] font-bold text-tg-text">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="rounded-full bg-tg-surface p-2 text-tg-hint transition active:scale-95"
          >
            <X className="h-4.5 w-4.5" />
          </button>
        </div>
        {children}
      </motion.div>
    </motion.div>
  )
}
