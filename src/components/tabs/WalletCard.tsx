'use client'

/**
 * КОШЕЛЁК в профиле (v5.39) — минималистичный баланс с двумя горизонтальными
 * вкладками Рубли / Свайпы (решение владельца: «просто минималистичный баланс»).
 *
 *  • Рубли — balanceKop: пополняются картой/Stars/TON, покупают ВСЁ в сервисе.
 *  • Свайпы — валюта нейросетей: списываются за запросы к ИИ ПО ТОКЕНАМ
 *    (реальный usage OpenRouter, см. lib/wallet.ts); 500 свайпов = 1 ₽,
 *    конвертация в обе стороны без потерь (1 копейка = 5 свайпов).
 *
 * Данные — GET /api/wallet, конвертация — POST /api/wallet.
 * reloadSignal — счётчик внешних изменений (после пополнения в TopUpModal).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle, ArrowLeftRight, ChevronDown, Loader2, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { haptic } from '@/lib/tg'
import { pluralRu } from '@/lib/format'
import { useApp } from '@/lib/store'
import { SwipeIcon } from '@/components/tg/SwipeIcon'

type WalletHistoryItem = {
  id: string
  kind: string
  currency: 'rub' | 'swp' | string
  amount: number
  note: string | null
  createdAt: string
}

type WalletData = {
  balanceKop: number
  swipes: number
  swpPerRub: number
  aiPricing?: { inSwpPerMtok: number; outSwpPerMtok: number }
  swpConvertMin: number
  history: WalletHistoryItem[]
}

/** Формат ₽ из копеек: 123456 → «1 234,56 ₽» */
function fmtRub(kop: number): string {
  const v = Math.abs(kop) / 100
  const [int, frac] = v.toFixed(2).split('.')
  const intSpaced = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `${kop < 0 ? '−' : ''}${intSpaced},${frac} ₽`
}

function fmtNum(n: number): string {
  return Math.abs(n).toLocaleString('ru-RU')
}

const KIND_LABEL: Record<string, string> = {
  topup: 'Пополнение',
  convert: 'Обмен',
  ai_spend: 'Нейросети',
  purchase: 'Покупка',
  ad_campaign: 'Кампания',
  refund: 'Возврат',
  admin: 'Корректировка',
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return (
    d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) +
    ' ' +
    d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  )
}

type Tab = 'rub' | 'swp'

export function WalletCard({
  reloadSignal,
  onTopUp,
}: {
  reloadSignal: number
  onTopUp: () => void
}) {
  const [tab, setTab] = useState<Tab>('rub')
  const [data, setData] = useState<WalletData | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  // v5.54: мутации из других вкладок (claim заданий, ИИ) прилетают сюда —
  // кошелёк больше не показывает устаревший баланс
  const storeBalance = useApp((s) => s.balance)
  const patchBalance = useApp((s) => s.patchBalance)

  const hasLoadedRef = useRef(false)
  const load = useCallback(() => {
    api<WalletData & { ok: boolean }>('/api/wallet')
      .then((r) => {
        hasLoadedRef.current = true
        setData({ ...r, history: r.history ?? [] })
        setFailed(false)
        patchBalance({ balanceKop: r.balanceKop, swipes: r.swipes })
      })
      .catch(() => {
        // v5.54: ошибка сети ≠ нулевой баланс — показываем экран повтора,
        // а не «0 ₽ / 0 свайпов» с активной кнопкой пополнения
        setFailed(!hasLoadedRef.current)
      })
  }, [patchBalance])

  useEffect(() => {
    load()
  }, [load, reloadSignal])

  // Внешние мутации баланса (задания/топап в других вкладках) — догоняем мгновенно
  useEffect(() => {
    if (storeBalance && data) {
      setData((d) => (d ? { ...d, balanceKop: storeBalance.balanceKop, swipes: storeBalance.swipes } : d))
    }
  }, [storeBalance])

  const swipes = data?.swipes ?? 0
  const balanceKop = data?.balanceKop ?? 0
  const swpWord = (n: number) => pluralRu(n, 'свайп', 'свайпа', 'свайпов')

  /** Обмен всей суммы в выбранную сторону (сервер сам округляет по курсу) */
  const convert = async (action: 'rub2swp' | 'swp2rub') => {
    if (!data || busy) return
    const amount = action === 'rub2swp' ? data.balanceKop : data.swipes
    if (amount <= 0) return
    if (action === 'swp2rub' && amount < data.swpConvertMin) {
      toast(`Минимум для обмена — ${data.swpConvertMin} ${swpWord(data.swpConvertMin)}`)
      return
    }
    setBusy(true)
    haptic('light')
    try {
      const r = await api<{ ok: boolean; balanceKop: number; swipes: number }>('/api/wallet', {
        method: 'POST',
        body: JSON.stringify({ action, amount }),
      })
      setData({ ...data, balanceKop: r.balanceKop, swipes: r.swipes })
      patchBalance({ balanceKop: r.balanceKop, swipes: r.swipes })
      haptic('success')
      toast.success(
        action === 'rub2swp'
          ? `Обменяно на ${fmtNum(r.swipes)} ${swpWord(r.swipes)}`
          : `Обменяно на ${fmtRub(r.balanceKop)}`,
      )
      load() // догоняем журнал операций
    } catch (e) {
      toast.error((e as Error).message || 'Обмен не удался')
    } finally {
      setBusy(false)
    }
  }

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'rub', label: 'Рубли' },
    { id: 'swp', label: 'Свайпы' },
  ]

  return (
    <section className="pt-7" aria-label="Кошелёк">
      <div className="flex items-center justify-between px-4">
        <h2 className="text-[19px] font-bold text-tg-text">Кошелёк</h2>
        <span className="text-[12.5px] font-medium text-tg-hint">500 свайпов = 1 ₽</span>
      </div>

      <div className="px-4 pt-3">
        {failed ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl bg-tg-surface px-4 py-8 text-center">
            <AlertTriangle className="h-7 w-7 text-tg-hint" aria-hidden />
            <p className="text-[14.5px] text-tg-hint">Не удалось загрузить кошелёк</p>
            <button
              type="button"
              onClick={() => {
                haptic('light')
                load()
              }}
              className="flex items-center gap-1.5 rounded-full bg-tg-link px-4 py-2 text-[14px] font-semibold text-white active:opacity-80"
            >
              <RefreshCw className="h-4 w-4" aria-hidden /> Повторить
            </button>
          </div>
        ) : (
        <div className="overflow-hidden rounded-2xl bg-tg-surface">
          {/* ВКЛАДКИ: Рубли | Свайпы — горизонтальные, с бегущим подчёркиванием */}
          <div className="flex items-stretch border-b border-tg-sep/60" role="tablist" aria-label="Валюта кошелька">
            {tabs.map((tb) => {
              const active = tab === tb.id
              return (
                <button
                  key={tb.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    haptic('light')
                    setTab(tb.id)
                  }}
                  className={cn(
                    'relative flex flex-1 items-center justify-center gap-1.5 pb-2.5 pt-3 text-[14.5px] font-semibold transition',
                    active ? 'text-tg-link' : 'text-tg-hint',
                  )}
                >
                  {tb.id === 'swp' && <SwipeIcon className="h-4 w-4" size={16} />}
                  {tb.label}
                  {active && (
                    <motion.span
                      layoutId="wallet-tab-underline"
                      className="absolute inset-x-10 bottom-0 h-[3px] rounded-full bg-tg-link"
                      transition={{ type: 'spring', damping: 30, stiffness: 400 }}
                    />
                  )}
                </button>
              )
            })}
          </div>

          {/* ---- РУБЛИ ---- */}
          {tab === 'rub' && (
            <div className="p-4">
              <div className="text-[30px] font-bold leading-none tracking-tight text-tg-text tabular-nums">
                {fmtRub(balanceKop)}
              </div>
              <p className="mt-1.5 text-[13px] leading-snug text-tg-hint">
                Покупают всё в сервисе — без оплаты картой на месте
              </p>
              <div className="mt-3.5 flex gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    haptic('light')
                    onTopUp()
                  }}
                  className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-tg-link text-[14.5px] font-semibold text-white transition active:scale-[0.97]"
                >
                  <Plus className="h-4 w-4" strokeWidth={2.5} />
                  Пополнить
                </button>
                <button
                  type="button"
                  onClick={() => convert('rub2swp')}
                  disabled={busy || balanceKop <= 0}
                  className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border border-tg-sep bg-tg-bg text-[14.5px] font-semibold text-tg-text transition active:scale-[0.97] disabled:opacity-45"
                >
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ArrowLeftRight className="h-4 w-4" strokeWidth={2.2} />
                  )}
                  В свайпы
                </button>
              </div>
            </div>
          )}

          {/* ---- СВАЙПЫ ---- */}
          {tab === 'swp' && (
            <div className="p-4">
              <div className="flex items-baseline gap-2">
                <span className="flex items-baseline gap-1.5 text-[30px] font-bold leading-none tracking-tight text-tg-text tabular-nums">
                  <SwipeIcon className="h-5 w-5 shrink-0 self-center text-tg-link" size={20} />
                  {fmtNum(swipes)}
                </span>
                <span className="text-[14px] font-medium text-tg-hint">{swpWord(swipes)}</span>
              </div>
              <p className="mt-1.5 text-[13px] leading-snug text-tg-hint">
                Валюта нейросетей — списываются за запросы по токенам
                {data?.aiPricing
                  ? ` (~${fmtNum(data.aiPricing.inSwpPerMtok)} за 1 млн входных)`
                  : ''}
              </p>
              <button
                type="button"
                onClick={() => convert('swp2rub')}
                disabled={busy || swipes < (data?.swpConvertMin ?? 100)}
                className="mt-3.5 flex h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-tg-sep bg-tg-bg text-[14.5px] font-semibold text-tg-text transition active:scale-[0.97] disabled:opacity-45"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowLeftRight className="h-4 w-4" strokeWidth={2.2} />
                )}
                Обменять в рубли
              </button>
              {swipes > 0 && swipes < (data?.swpConvertMin ?? 100) && (
                <p className="mt-1.5 text-[12px] text-tg-hint">
                  Минимум для обмена — {data?.swpConvertMin ?? 100} {swpWord(data?.swpConvertMin ?? 100)}
                </p>
              )}
            </div>
          )}

          {/* ---- ИСТОРИЯ (свёрнутая по умолчанию) ---- */}
          {(data?.history.length ?? 0) > 0 && (
            <div className="border-t border-tg-sep/60">
              <button
                type="button"
                onClick={() => {
                  haptic('light')
                  setHistoryOpen((v) => !v)
                }}
                aria-expanded={historyOpen}
                className="flex h-11 w-full items-center justify-between px-4 text-[13.5px] font-medium text-tg-hint transition active:opacity-60"
              >
                История операций
                <ChevronDown
                  className={cn('h-4 w-4 transition-transform', historyOpen && 'rotate-180')}
                />
              </button>
              {historyOpen && (
                <div className="max-h-56 overflow-y-auto px-4 pb-3" role="list">
                  {data!.history.map((h) => {
                    const plus = h.amount > 0
                    const isRub = h.currency === 'rub'
                    return (
                      <div key={h.id} className="flex items-center gap-3 border-t border-tg-sep/40 py-2.5 first:border-t-0" role="listitem">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13.5px] font-medium text-tg-text">
                            {KIND_LABEL[h.kind] ?? h.kind}
                            {h.note ? <span className="text-tg-hint"> · {h.note}</span> : null}
                          </div>
                          <div className="mt-0.5 text-[11.5px] text-tg-hint">{fmtTime(h.createdAt)}</div>
                        </div>
                        <div
                          className={cn(
                            'shrink-0 text-[13.5px] font-semibold tabular-nums',
                            plus ? 'text-tg-link' : 'text-tg-text',
                          )}
                        >
                          {plus ? '+' : '−'}
                          {isRub ? (
                            fmtRub(h.amount)
                          ) : (
                            <span className="inline-flex items-center gap-1">
                              <SwipeIcon className="h-3 w-3" size={12} />
                              {fmtNum(h.amount)}
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>
        )}
      </div>
    </section>
  )
}
