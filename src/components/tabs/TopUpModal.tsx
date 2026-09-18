'use client'

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import {
  ArrowRight,
  Check,
  Clock3,
  Copy,
  CreditCard,
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
import { pluralSwipes } from '@/lib/money'
import { haptic, openInvoiceUrl, openTelegram } from '@/lib/tg'
import { useApp } from '@/lib/store'
import { useT } from '@/lib/i18n'
import { BottomSheet } from '@/components/tg/BottomSheet'
import { useIsDesktop } from '@/lib/use-desktop'

/**
 * Пополнение баланса свайпов (1 свайп = 1 ₽).
 *
 * СТРАНИЦА ОПЛАТЫ (как в Telegram):
 *  • сверху ТРИ ВКЛАДКИ — Карта / Stars / TON: иконки БЕЗ подложек и рамок
 *    (просто иконка + подпись, активная вкладка подчёркнута);
 *  • ниже — ПАКИ в стиле покупки Stars в Telegram: ряд с радиокружком,
 *    иконкой пакета, ценой и эквивалентом (₽ / TON);
 *  • Карта — эквайринг ЮKassa (redirect), включается ключами env;
 *  • Stars — XTR-инвойс нашего бота, открывается НАТИВНЫМ окном оплаты
 *    через WebApp.openInvoice (openTelegramLink инвойсы не открывает —
 *    именно из-за этого Stars казались «недоступными»);
 *  • TON — счёт по живому курсу, memo-код, поллинг поступления.
 *
 * ФОРФАКТОР: на ПК (lg+) — ЦЕЛАЯ СТРАНИЦА, в миниаппе и на телефоне — шторка.
 */

const PRESETS = [100, 500, 1000, 5000]
/** Пакеты Stars: от минимума XTR-инвойса до максимума (50…2500) */
const STAR_PACKS = [50, 100, 250, 500, 1000, 2500]
/** Пакеты TON — те же суммы, что и пресеты карты, в одном стиле */
const TON_PACKS = [100, 500, 1000, 5000]

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

/** Иконка TON — кристалл #0098EA, БЕЗ подложки (по поручению: иконки без фонов) */
function TonIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path
        fill="#0098EA"
        d="M6.9 3h10.2c.42 0 .8.2 1.03.52l3.55 5.3c.28.42.24.98-.1 1.35l-8.53 9.62c-.57.64-1.55.64-2.12 0L2.4 10.17a1.04 1.04 0 0 1-.1-1.35l3.56-5.3C6.08 3.2 6.47 3 6.9 3Z"
      />
      <path fill="#fff" fillOpacity=".93" d="M7.4 8.4h9.2L12 15.6 7.4 8.4Z" />
    </svg>
  )
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
  const t = useT()
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
        aria-label={t('topup.title')}
        data-noswipe
      >
        <header className="sticky top-0 z-10 border-b border-tg-sep/60 bg-tg-bg/95 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-[640px] items-center justify-between px-4">
            <h1 className="text-[17px] font-bold text-tg-text">{t('topup.title')}</h1>
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
    <BottomSheet open={open} onClose={onClose} title={t('topup.titleShort')}>
      <TopUpContent onClose={onClose} onReload={onReload} />
    </BottomSheet>
  )
}

/* ------------------------------------------------------------------ */
/* Общее содержимое                                                    */
/* ------------------------------------------------------------------ */

function TopUpContent({ onClose, onReload }: { onClose: () => void; onReload: () => void }) {
  const t = useT()
  const lang = useApp((s) => s.lang)
  const [amount, setAmount] = useState(1000) // свайпы
  const [custom, setCustom] = useState('')
  const [methods, setMethods] = useState<Methods | null>(null)
  const [method, setMethod] = useState<Method>('stars')
  const [busy, setBusy] = useState(false)
  const [ton, setTon] = useState<TonInvoice | null>(null)
  const [tonStatus, setTonStatus] = useState<'waiting' | 'succeeded' | 'expired'>('waiting')
  /** Курс TON для превью-эквивалентов в паках (грузится при выборе вкладки) */
  const [tonRate, setTonRate] = useState<number | null>(null)

  const effective = custom.trim() ? Math.max(0, Math.round(Number(custom) || 0)) : amount
  const cardValid = effective >= 100 && effective <= 50_000
  const starsValid = effective >= 50 && effective <= 2500
  const starsAmount = Math.min(Math.max(effective || 100, 50), 2500)

  useEffect(() => {
    api<{ methods: Methods }>('/api/payments/methods')
      .then((r) => {
        setMethods(r.methods)
        setMethod((prev) => {
          if (prev === 'card' && !r.methods.card) return r.methods.stars ? 'stars' : 'ton'
          if (prev === 'ton' && !r.methods.ton) return r.methods.stars ? 'stars' : 'card'
          if (prev === 'stars' && !r.methods.stars) return r.methods.card ? 'card' : 'ton'
          return prev
        })
      })
      .catch(() => setMethods({ card: false, stars: true, ton: false }))
  }, [])

  // Курс TON подгружаем лениво — только когда открыта вкладка TON
  useEffect(() => {
    if (method !== 'ton' || tonRate !== null) return
    api<{ ok: boolean; rub: number | null }>('/api/payments/ton-rate')
      .then((r) => setTonRate(r.rub ?? null))
      .catch(() => setTonRate(null))
  }, [method, tonRate])

  const pay = async () => {
    if (busy || !method) return
    setBusy(true)
    try {
      if (method === 'card') {
        if (!cardValid) return
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
        const r = await api<{ ok: boolean; invoiceUrl: string; stars: number }>('/api/payments/stars', {
          method: 'POST',
          body: JSON.stringify({ swipes: starsAmount }),
        })
        // ТОЛЬКО openInvoice: нативное окно оплаты внутри Telegram.
        // Баланс обновится по колбэку 'paid'; шторку не закрываем — если оплата
        // отменена, пользователь может выбрать другой способ прямо здесь.
        openInvoiceUrl(r.invoiceUrl, () => {
          toast.success(t('topup.paid'))
          onReload()
        })
        toast(t('topup.starsOpen'), { icon: '⭐' })
        return
      }
      // TON
      if (!cardValid) return
      const r = await api<TonInvoice & { ok: boolean }>('/api/payments/ton', {
        method: 'POST',
        body: JSON.stringify({ swipes: effective }),
      })
      setTon(r)
      setTonStatus('waiting')
    } catch (err) {
      toast.error((err as Error).message || t('topup.invoiceFail'))
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

  const tabs: Array<{
    id: Method
    label: string
    icon: ReactNode
    available: boolean
  }> = [
    {
      id: 'card',
      label: t('topup.tabCard'),
      icon: <CreditCard className="h-[19px] w-[19px]" strokeWidth={1.9} />,
      available: methods?.card ?? false,
    },
    {
      id: 'stars',
      label: t('topup.tabStars'),
      icon: <Star className="h-[19px] w-[19px] fill-amber-400 text-amber-400" strokeWidth={1.2} />,
      available: methods?.stars ?? true,
    },
    {
      id: 'ton',
      label: t('topup.tabTon'),
      icon: <TonIcon className="h-[19px] w-[19px]" />,
      available: methods?.ton ?? false,
    },
  ]

  const swipesWord = (n: number) => (lang === 'en' ? t('topup.swipes') : pluralSwipes(n))
  const tonFor = (swipes: number): string | null => {
    if (tonRate === null || tonRate <= 0) return null
    const exact = (swipes / tonRate) * 1.02
    const v = Math.ceil(exact * 10_000) / 10_000
    return String(v).replace(/0+$/, '').replace(/\.$/, '')
  }

  /* ----- Общие элементы вкладки: своя сумма + кнопка оплаты ----- */
  const customInput = (
    <div className="mt-2.5">
      <input
        type="number"
        inputMode="numeric"
        min={method === 'stars' ? 50 : 100}
        max={method === 'stars' ? 2500 : 50000}
        value={custom}
        onChange={(e) => setCustom(e.target.value)}
        placeholder={t('topup.custom')}
        aria-label={t('topup.customAria')}
        className="h-11 w-full rounded-xl border border-tg-sep bg-tg-bg px-4 text-[15px] text-tg-text outline-none placeholder:text-tg-hint focus:border-tg-link"
      />
      <div className="mt-1 flex justify-between px-1 text-[12px] text-tg-hint">
        <span>
          {method === 'stars'
            ? starsValid
              ? `= ${formatRub(starsAmount * 100)} ${t('topup.toPay')}`.trim()
              : '50–2500 ⭐'
            : cardValid
              ? `= ${formatRub(effective * 100)} ${t('topup.toPay')}`.trim()
              : t('topup.range')}
        </span>
        <span>{t('topup.rate1')}</span>
      </div>
    </div>
  )

  const payButton = (
    <button
      type="button"
      onClick={pay}
      disabled={busy || (method === 'stars' ? !starsValid : !cardValid)}
      className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-tg-link text-[15px] font-semibold text-white transition active:scale-[0.98] disabled:bg-tg-sep/60 disabled:text-tg-hint"
    >
      {busy ? <Loader2 className="h-4.5 w-4.5 animate-spin" /> : <Wallet className="h-4.5 w-4.5" />}
      {method === 'stars'
        ? `${t('topup.payStars')} ${formatCount(starsAmount)} ⭐`
        : method === 'ton'
          ? t('topup.payTon')
          : `${t('topup.payCard')} ${formatCount(effective)} ${swipesWord(effective)}`}
    </button>
  )

  const escrowHint = (
    <p className="mt-2 text-center text-[11.5px] leading-snug text-tg-hint">{t('topup.escrow')}</p>
  )

  /* ----- Ряд пака в стиле Telegram (радио + иконка + цена + эквивалент) ----- */
  const packRow = (
    key: number,
    opts: {
      selected: boolean
      icon: React.ReactNode
      name: string
      main: string
      sub: string | null
      onSelect: () => void
    },
  ) => (
    <button
      key={key}
      type="button"
      role="radio"
      aria-checked={opts.selected}
      onClick={() => {
        haptic('select')
        opts.onSelect()
      }}
      className={cn(
        'flex w-full items-center gap-3 rounded-2xl border px-3.5 py-3 text-left transition active:scale-[0.99]',
        opts.selected ? 'border-tg-link bg-tg-link/[0.06]' : 'border-tg-sep/60 bg-tg-bg',
      )}
    >
      <span
        className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2',
          opts.selected ? 'border-tg-link bg-tg-link' : 'border-tg-sep',
        )}
        aria-hidden
      >
        {opts.selected && <Check className="h-3 w-3 text-white" strokeWidth={3.5} />}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {opts.icon}
        <span className="truncate text-[14.5px] font-semibold text-tg-text">{opts.name}</span>
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-[14px] font-semibold tabular-nums text-tg-text">{opts.main}</span>
        {opts.sub && <span className="block text-[11.5px] tabular-nums text-tg-hint">{opts.sub}</span>}
      </span>
    </button>
  )

  return (
    <div>
      {/* ВКЛАДКИ: Карта / Stars / TON — иконки без подложек, активная подчёркнута */}
      <div className="flex items-stretch border-b border-tg-sep/60" role="tablist" aria-label="Способ оплаты">
        {tabs.map((tb) => {
          const active = method === tb.id
          return (
            <button
              key={tb.id}
              type="button"
              role="tab"
              aria-selected={active}
              disabled={!tb.available}
              onClick={() => {
                haptic('light')
                setCustom('')
                setMethod(tb.id)
              }}
              className={cn(
                'relative flex flex-1 items-center justify-center gap-1.5 pb-2.5 pt-1 text-[13.5px] font-semibold transition',
                active ? 'text-tg-link' : 'text-tg-hint',
                tb.available ? 'cursor-pointer' : 'cursor-not-allowed opacity-40',
              )}
            >
              {tb.icon}
              {tb.label}
              {active && (
                <motion.span
                  layoutId="topup-tab-underline"
                  className="absolute inset-x-4 bottom-0 h-[3px] rounded-full bg-tg-link"
                  transition={{ type: 'spring', damping: 30, stiffness: 400 }}
                />
              )}
            </button>
          )
        })}
      </div>
      {!(methods?.card ?? false) && method === 'card' && (
        <p className="mt-3 text-center text-[13px] text-tg-hint">{t('topup.unavailable')}</p>
      )}
      {!(methods?.ton ?? false) && method === 'ton' && (
        <p className="mt-3 text-center text-[13px] text-tg-hint">{t('topup.unavailable')}</p>
      )}

      {/* ----- Вкладка КАРТА: пресеты + своя сумма ----- */}
      {method === 'card' && (methods?.card ?? false) && (
        <div className="mt-4">
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
          {customInput}
          {payButton}
          {escrowHint}
        </div>
      )}

      {/* ----- Вкладка STARS: паки как в покупке Stars у Telegram ----- */}
      {method === 'stars' && (
        <div className="mt-4">
          <div
            className="space-y-2"
            role="radiogroup"
            aria-label={t('topup.tabStars')}
          >
            {STAR_PACKS.map((sw) =>
              packRow(sw, {
                selected: starsAmount === sw,
                icon: <Star className="h-5 w-5 shrink-0 fill-amber-400 text-amber-400" strokeWidth={1.2} />,
                name: `${formatCount(sw)} ${t('topup.packName')}`,
                main: formatRub(sw * 100),
                sub: `${formatCount(sw)} ${swipesWord(sw)}`,
                onSelect: () => {
                  setAmount(sw)
                  setCustom('')
                },
              }),
            )}
          </div>
          {customInput}
          {starsAmount >= 2500 && (
            <p className="mt-2 px-1 text-[11.5px] leading-snug text-tg-hint">{t('topup.starsNote')}</p>
          )}
          {payButton}
          {escrowHint}
        </div>
      )}

      {/* ----- Вкладка TON: паки в том же стиле, эквивалент по живому курсу ----- */}
      {method === 'ton' && (methods?.ton ?? false) && (
        <div className="mt-4">
          <div className="space-y-2" role="radiogroup" aria-label={t('topup.tabTon')}>
            {TON_PACKS.map((sw) => {
              const tonEq = tonFor(sw)
              return packRow(sw, {
                selected: effective === sw,
                icon: <TonIcon className="h-5 w-5 shrink-0" />,
                name: `${formatCount(sw)} ${swipesWord(sw)}`,
                main: tonEq ? `≈ ${tonEq} TON` : formatRub(sw * 100),
                sub: formatRub(sw * 100),
                onSelect: () => {
                  setAmount(sw)
                  setCustom('')
                },
              })
            })}
          </div>
          {customInput}
          {payButton}
          {escrowHint}
        </div>
      )}
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
  const t = useT()
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
    const timer = setInterval(tick, 4000)
    void tick()
    return () => clearInterval(timer)
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
        <div className="mt-3 text-[18px] font-bold text-tg-text">{t('topup.paid')}</div>
        <p className="mx-auto mt-1.5 max-w-[320px] text-[13.5px] leading-relaxed text-tg-hint">
          {t('topup.paidHint')}
        </p>
        <button
          type="button"
          onClick={onClose}
          className="mt-4 h-12 w-full rounded-2xl bg-tg-link text-[15px] font-semibold text-white active:scale-[0.98]"
        >
          {t('topup.great')}
        </button>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center">
          <TonIcon className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-bold text-tg-text">{invoice.tonAmount} TON</div>
          <div className="text-[12.5px] text-tg-hint">
            ≈ {formatRub(invoice.rubApprox * 100)} · {formatCount(invoice.rate)} {t('topup.rateSuffix')}
          </div>
        </div>
        {status === 'waiting' && (
          <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-tg-surface px-2.5 py-1 text-[11.5px] font-semibold text-tg-hint">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-tg-link" />
            {t('topup.waiting')}
          </span>
        )}
      </div>

      {status === 'expired' ? (
        <p className="mt-4 rounded-2xl bg-tg-surface/70 px-4 py-3 text-[13.5px] leading-relaxed text-tg-hint">
          {t('topup.tonExpired')}
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
              label={t('topup.addrLabel')}
              value={invoice.address}
              copied={copied === 'addr'}
              copiedLabel={t('post.copied')}
              onCopy={() => copy(invoice.address, 'addr')}
            />
            <CopyRow
              label={t('topup.memoLabel')}
              value={invoice.memo}
              copied={copied === 'memo'}
              copiedLabel={t('post.copied')}
              onCopy={() => copy(invoice.memo, 'memo')}
            />
          </div>

          <p className="mt-2.5 flex items-start gap-1.5 px-1 text-[11.5px] leading-snug text-tg-hint">
            <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {t('topup.tonHint')}
          </p>

          <button
            type="button"
            onClick={() => openTelegram(invoice.url)}
            className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-tg-link text-[15px] font-semibold text-white transition active:scale-[0.98]"
          >
            <ExternalLink className="h-4.5 w-4.5" />
            {t('topup.openTonkeeper')}
          </button>
        </>
      )}

      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className={cn(
            'flex h-11 flex-1 items-center justify-center gap-1.5 rounded-2xl text-[14px] font-semibold active:scale-[0.98]',
            status === 'expired' ? 'bg-tg-link text-white' : 'bg-tg-surface text-tg-text2',
          )}
        >
          {status === 'expired' ? t('topup.newInvoice') : t('topup.otherMethod')}
        </button>
      </div>
    </div>
  )
}

function CopyRow({
  label,
  value,
  copied,
  copiedLabel,
  onCopy,
}: {
  label: string
  value: string
  copied: boolean
  copiedLabel: string
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
        {copied ? copiedLabel : <ArrowRight className="h-3.5 w-3.5" aria-hidden />}
      </span>
    </button>
  )
}
