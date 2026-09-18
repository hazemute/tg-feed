'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  ArrowRight,
  Banknote,
  Check,
  Clock3,
  Copy,
  Diamond,
  ExternalLink,
  Loader2,
  Star,
  Wallet,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { formatCount } from '@/lib/format'
import { formatSwipes, pluralSwipes } from '@/lib/money'
import { haptic, openTelegram } from '@/lib/tg'
import { BottomSheet } from '@/components/tg/BottomSheet'
import { useIsDesktop } from '@/lib/use-desktop'

/**
 * Пополнение баланса свайпов (1 свайп = 1 ₽).
 *
 * ТРИ СПОСОБА ОПЛАТЫ:
 *  • Карта (рубли) — эквайринг ЮKassa (redirect), включается ключами env;
 *  • Telegram Stars — счёт через нашего бота (XTR), оплата в самом Telegram;
 *  • TON через Tonkeeper — счёт по живому курсу, memo-код, поллинг поступления.
 *
 * ФОРФАКТОР: на ПК (lg+) — ЦЕЛАЯ СТРАНИЦА (поручение: не «модалка снизу»),
 * в миниаппе и на телефоне — привычная нижняя шторка.
 */

const PRESETS = [100, 500, 1000, 5000]

type Methods = { card: boolean; stars: boolean; ton: boolean }
type Method = 'card' | 'stars' | 'ton'

type TonInvoice = {
  paymentId: string
  address: string
  memo: string
  tonAmount: number
  rubApprox: number
  rate: number
  url: string
  qrDataUrl: string
}

function formatRub(kop: number): string {
  const rub = kop / 100
  return rub % 1 === 0 ? `${formatCount(rub)} ₽` : `${rub.toFixed(2)} ₽`
}

export function TopUpModal({
  open,
  onClose,
  onReload,
}: {
  open: boolean
  onClose: () => void
  onReload: () => void
}) {
  const isDesktop = useIsDesktop()

  // Блокируем скролл фона (на ПК — страница, на мобиле — шторка)
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  // ПК: полноценная страница
  if (isDesktop) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        className="fixed inset-0 z-[62] overflow-y-auto bg-tg-bg"
        role="dialog"
        aria-modal="true"
        aria-label="Пополнение баланса"
        data-noswipe
      >
        <header className="sticky top-0 z-10 border-b border-tg-sep/60 bg-tg-bg/95 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-[640px] items-center justify-between px-4">
            <h1 className="text-[17px] font-bold text-tg-text">Пополнение баланса</h1>
            <button
              type="button"
              onClick={onClose}
              aria-label="Закрыть"
              className="flex h-9 w-9 items-center justify-center rounded-full bg-tg-surface text-tg-hint transition hover:bg-tg-sep/60"
            >
              <X className="h-4.5 w-4.5" />
            </button>
          </div>
        </header>
        <div className="mx-auto w-full max-w-[640px] px-4 pb-20 pt-6">
          <TopUpContent onClose={onClose} onReload={onReload} />
        </div>
      </motion.div>
    )
  }

  // Телефон / Mini App: нижняя шторка
  return (
    <BottomSheet open={open} onClose={onClose} title="Пополнить баланс">
      <TopUpContent onClose={onClose} onReload={onReload} />
    </BottomSheet>
  )
}

/* ------------------------------------------------------------------ */
/* Общее содержимое                                                    */
/* ------------------------------------------------------------------ */

function TopUpContent({ onClose, onReload }: { onClose: () => void; onReload: () => void }) {
  const [amount, setAmount] = useState(1000) // свайпы
  const [custom, setCustom] = useState('')
  const [methods, setMethods] = useState<Methods | null>(null)
  const [method, setMethod] = useState<Method | null>(null)
  const [busy, setBusy] = useState(false)
  const [ton, setTon] = useState<TonInvoice | null>(null)
  const [tonStatus, setTonStatus] = useState<'waiting' | 'succeeded' | 'expired'>('waiting')

  const effective = custom.trim() ? Math.max(0, Math.round(Number(custom) || 0)) : amount
  const valid = effective >= 100 && effective <= 50_000

  useEffect(() => {
    api<{ methods: Methods }>('/api/payments/methods')
      .then((r) => {
        setMethods(r.methods)
        setMethod((prev) => prev ?? (r.methods.card ? 'card' : r.methods.stars ? 'stars' : r.methods.ton ? 'ton' : null))
      })
      .catch(() => setMethods({ card: false, stars: true, ton: false }))
  }, [])

  const pay = async () => {
    if (busy || !valid || !method) return
    setBusy(true)
    try {
      if (method === 'card') {
        const r = await api<{ ok: boolean; confirmationUrl: string | null }>('/api/payments', {
          method: 'POST',
          body: JSON.stringify({ amountKop: effective * 100 }),
        })
        if (r.confirmationUrl) {
          openTelegram(r.confirmationUrl)
          onClose()
          onReload()
        }
        return
      }
      if (method === 'stars') {
        // Telegram ограничивает XTR-инвойс: больше 2500 звёзд — платим частями
        const swipes = Math.min(Math.max(effective, 50), 2500)
        const r = await api<{ ok: boolean; invoiceUrl: string; stars: number }>('/api/payments/stars', {
          method: 'POST',
          body: JSON.stringify({ swipes }),
        })
        openTelegram(r.invoiceUrl)
        toast.success('Счёт открыт в Telegram — подтвердите оплату Stars')
        onClose()
        onReload()
        return
      }
      // TON
      const r = await api<TonInvoice & { ok: boolean }>('/api/payments/ton', {
        method: 'POST',
        body: JSON.stringify({ swipes: effective }),
      })
      setTon(r)
      setTonStatus('waiting')
    } catch (err) {
      toast.error((err as Error).message || 'Не удалось создать платёж')
    } finally {
      setBusy(false)
    }
  }

  /* ----- TON: экран ожидания перевода ----- */
  if (ton) {
    return (
      <TonWaiting
        invoice={ton}
        status={tonStatus}
        onStatus={(s) => {
          setTonStatus(s)
          if (s === 'succeeded') {
            haptic('success')
            onReload()
          }
        }}
        onCancel={() => setTon(null)}
        onClose={onClose}
      />
    )
  }

  const METHOD_ROWS: Array<{
    id: Method
    icon: typeof Banknote
    title: string
    sub: string
    available: boolean
  }> = [
    {
      id: 'card',
      icon: Banknote,
      title: 'Карта или СБП, рубли',
      sub: 'Оплата в один экран · ЮKassa',
      available: methods?.card ?? false,
    },
    {
      id: 'stars',
      icon: Star,
      title: 'Telegram Stars',
      sub: `≈ ${formatCount(Math.min(Math.max(effective, 50), 2500))} ⭐ · оплата в Telegram`,
      available: methods?.stars ?? true,
    },
    {
      id: 'ton',
      icon: Diamond,
      title: 'Крипта TON',
      sub: 'Tonkeeper и любые TON-кошельки',
      available: methods?.ton ?? false,
    },
  ]

  return (
    <div>
      {/* Сумма */}
      <div className="grid grid-cols-4 gap-2">
        {PRESETS.map((sw) => (
          <button
            key={sw}
            type="button"
            onClick={() => {
              haptic('light')
              setAmount(sw)
              setCustom('')
            }}
            className={cn(
              'rounded-xl border py-2.5 text-[13.5px] font-bold transition active:scale-95',
              effective === sw
                ? 'border-tg-link bg-tg-link/10 text-tg-link'
                : 'border-tg-sep/60 bg-tg-bg text-tg-text2',
            )}
          >
            {formatCount(sw)}
          </button>
        ))}
      </div>
      <div className="mt-2.5">
        <input
          type="number"
          inputMode="numeric"
          min={100}
          max={50000}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="Своя сумма — от 100"
          aria-label="Сумма пополнения в свайпах"
          className="h-12 w-full rounded-xl border border-tg-sep bg-tg-bg px-4 text-[16px] text-tg-text outline-none placeholder:text-tg-hint focus:border-tg-link"
        />
        <div className="mt-1 flex justify-between px-1 text-[12px] text-tg-hint">
          <span>{valid ? `= ${formatRub(effective * 100)} к оплате` : 'от 100 до 50 000 свайпов'}</span>
          <span>1 свайп = 1 ₽</span>
        </div>
      </div>

      {/* Способ оплаты */}
      <div className="mt-4 space-y-2" role="radiogroup" aria-label="Способ оплаты">
        {METHOD_ROWS.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={method === m.id}
            disabled={!m.available}
            onClick={() => {
              haptic('light')
              setMethod(m.id)
            }}
            className={cn(
              'flex w-full items-center gap-3 rounded-2xl border px-3.5 py-3 text-left transition active:scale-[0.99]',
              method === m.id
                ? 'border-tg-link bg-tg-link/[0.07]'
                : 'border-tg-sep/60 bg-tg-bg',
              !m.available && 'cursor-not-allowed opacity-50',
            )}
          >
            <span
              className={cn(
                'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
                m.id === 'stars'
                  ? 'bg-tg-star/12 text-tg-star'
                  : m.id === 'ton'
                    ? 'bg-sky-500/12 text-sky-600 dark:text-sky-400'
                    : 'bg-tg-link/10 text-tg-link',
              )}
            >
              <m.icon className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14.5px] font-semibold text-tg-text">{m.title}</span>
              <span className="block truncate text-[12px] text-tg-hint">
                {m.available ? m.sub : 'Появится в ближайшее время'}
              </span>
            </span>
            {m.available ? (
              <span
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2',
                  method === m.id ? 'border-tg-link bg-tg-link' : 'border-tg-sep',
                )}
                aria-hidden
              >
                {method === m.id && <Check className="h-3 w-3 text-white" strokeWidth={3.5} />}
              </span>
            ) : (
              <span className="shrink-0 rounded-full bg-tg-surface px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-tg-hint">
                Скоро
              </span>
            )}
          </button>
        ))}
        {methods?.stars && effective > 2500 && (
          <p className="px-1 text-[11.5px] leading-snug text-tg-hint">
            Stars принимают до 2 500 за один платёж — крупная сумма просто разобьётся на несколько
            счетов (первый откроется сейчас).
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={pay}
        disabled={busy || !valid || !method}
        className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-tg-link text-[15px] font-semibold text-white transition active:scale-[0.98] disabled:bg-tg-sep/60 disabled:text-tg-hint"
      >
        {busy ? <Loader2 className="h-4.5 w-4.5 animate-spin" /> : <Wallet className="h-4.5 w-4.5" />}
        {method === 'stars'
          ? `Оплатить ${formatCount(Math.min(Math.max(effective, 50), 2500))} ⭐`
          : method === 'ton'
            ? 'Получить TON-счёт'
            : `Пополнить на ${formatCount(effective)} ${pluralSwipes(effective)}`}
      </button>
      <p className="mt-2 text-center text-[11.5px] leading-snug text-tg-hint">
        Свайпы зачисляются на эскроу-счёт и списываются только за уникальных читателей
      </p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* TON: ожидание перевода (QR + deep-link + поллинг)                   */
/* ------------------------------------------------------------------ */

function TonWaiting({
  invoice,
  status,
  onStatus,
  onCancel,
  onClose,
}: {
  invoice: TonInvoice
  status: 'waiting' | 'succeeded' | 'expired'
  onStatus: (s: 'waiting' | 'succeeded' | 'expired') => void
  onCancel: () => void
  onClose: () => void
}) {
  const [copied, setCopied] = useState<'addr' | 'memo' | null>(null)

  const copy = async (text: string, kind: 'addr' | 'memo') => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(kind)
      haptic('light')
      setTimeout(() => setCopied(null), 1600)
    } catch {
      /* буфер недоступен */
    }
  }

  useEffect(() => {
    if (status !== 'waiting') return
    const tick = async () => {
      try {
        const r = await api<{ ok: boolean; status: string }>(`/api/payments/ton?id=${invoice.paymentId}`)
        if (r.status === 'succeeded') onStatus('succeeded')
        else if (r.status === 'expired') onStatus('expired')
      } catch {
        /* следующий тик */
      }
    }
    const t = setInterval(tick, 4000)
    void tick()
    return () => clearInterval(t)
  }, [invoice.paymentId, status, onStatus])

  if (status === 'succeeded') {
    return (
      <div className="py-4 text-center">
        <motion.span
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/15"
        >
          <Check className="h-8 w-8 text-emerald-600 dark:text-emerald-400" strokeWidth={2.5} />
        </motion.span>
        <div className="mt-3 text-[18px] font-bold text-tg-text">Платёж получен</div>
        <p className="mx-auto mt-1.5 max-w-[320px] text-[13.5px] leading-relaxed text-tg-hint">
          Свайпы уже на балансе — можно запускать продвижение канала.
        </p>
        <button
          type="button"
          onClick={onClose}
          className="mt-4 h-12 w-full rounded-2xl bg-tg-link text-[15px] font-semibold text-white active:scale-[0.98]"
        >
          Отлично
        </button>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-sky-500/12">
          <Diamond className="h-5 w-5 text-sky-600 dark:text-sky-400" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-bold text-tg-text">{invoice.tonAmount} TON</div>
          <div className="text-[12.5px] text-tg-hint">≈ {formatRub(invoice.rubApprox * 100)} · курс {formatCount(invoice.rate)} ₽/TON</div>
        </div>
        {status === 'waiting' && (
          <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-tg-surface px-2.5 py-1 text-[11.5px] font-semibold text-tg-hint">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-tg-link" />
            Ждём перевод
          </span>
        )}
      </div>

      {status === 'expired' ? (
        <p className="mt-4 rounded-2xl bg-tg-surface/70 px-4 py-3 text-[13.5px] leading-relaxed text-tg-hint">
          Счёт устарел — курс TON изменился. Нажмите «Новый счёт», чтобы получить актуальный.
        </p>
      ) : (
        <>
          {/* QR для кошельков на ПК и телефоне */}
          <div className="mt-4 flex justify-center">
            <img
              src={invoice.qrDataUrl}
              alt="QR для оплаты в TON-кошельке"
              className="h-44 w-44 rounded-2xl border border-tg-sep/60 bg-white p-2"
            />
          </div>

          <div className="mt-3 space-y-2">
            <CopyRow
              label="Адрес кошелька"
              value={invoice.address}
              copied={copied === 'addr'}
              onCopy={() => copy(invoice.address, 'addr')}
            />
            <CopyRow
              label="Код платежа (обязательно в комментарии)"
              value={invoice.memo}
              copied={copied === 'memo'}
              onCopy={() => copy(invoice.memo, 'memo')}
            />
          </div>

          <p className="mt-2.5 flex items-start gap-1.5 px-1 text-[11.5px] leading-snug text-tg-hint">
            <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            Переводите точно указанную сумму TON с кодом в комментарии — зачисление придёт автоматически
            в течение минуты после подтверждения сети.
          </p>

          <button
            type="button"
            onClick={() => openTelegram(invoice.url)}
            className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-tg-link text-[15px] font-semibold text-white transition active:scale-[0.98]"
          >
            <ExternalLink className="h-4.5 w-4.5" />
            Открыть в Tonkeeper
          </button>
        </>
      )}

      <div className="mt-2 flex gap-2">
        {status === 'expired' ? (
          <button
            type="button"
            onClick={onCancel}
            className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-2xl bg-tg-link text-[14px] font-semibold text-white active:scale-[0.98]"
          >
            Новый счёт
          </button>
        ) : (
          <button
            type="button"
            onClick={onCancel}
            className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-2xl bg-tg-surface text-[14px] font-semibold text-tg-text2 active:scale-[0.98]"
          >
            Выбрать другой способ
          </button>
        )}
      </div>
    </div>
  )
}

function CopyRow({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string
  value: string
  copied: boolean
  onCopy: () => void
}) {
  return (
    <button
      type="button"
      onClick={onCopy}
      className="flex w-full items-center justify-between gap-3 rounded-2xl border border-tg-sep/60 bg-tg-bg px-3.5 py-2.5 text-left transition active:scale-[0.99]"
    >
      <span className="min-w-0">
        <span className="block text-[11px] font-medium uppercase tracking-wide text-tg-hint">{label}</span>
        <span className="mt-0.5 block truncate font-mono text-[13px] font-semibold text-tg-text2">{value}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1 text-[12px] font-semibold text-tg-hint">
        {copied ? <Check className="h-4 w-4 text-tg-link" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? 'Скопировано' : <ArrowRight className="h-3.5 w-3.5" aria-hidden />}
      </span>
    </button>
  )
}
