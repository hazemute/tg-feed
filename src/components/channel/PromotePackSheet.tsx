'use client'

import { useEffect, useState } from 'react'
import { Check, CreditCard, Loader2, Rocket, Wallet } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { haptic } from '@/lib/tg'
import { useApp } from '@/lib/store'
import { BottomSheet } from '@/components/tg/BottomSheet'
import { YooKassaWidget } from '@/components/payments/YooKassaWidget'

/**
 * Шит покупки пакета продвижений (v5.69 → v5.74) — докупка к бесплатному
 * месячному продвижению Snap Pro. ВЫБОР ТИРА (v5.74):
 *   starter — 1 за 149 ₽ · growth — 3 за 349 ₽ (−22%) · max — 10 за 899 ₽ (−40%)
 * Затем способ оплаты: «С баланса» / «50/50» / «Картой» (ЮKassa).
 */

type PackInfo = {
  ok: boolean
  packs: Array<{ id: 'starter' | 'growth' | 'max'; count: number; priceKop: number }>
  packId: 'starter' | 'growth' | 'max'
  priceKop: number
  count: number
  credits: number
  wallet: { balanceKop: number; swipes: number }
  methods: { card: boolean; stars: boolean; ton: boolean; sbp: boolean }
}

type BuyMethod = 'balance' | 'half' | 'card'

/** Формат ₽ из копеек без лишних знаков: 19900 → «199 ₽», 9950 → «99,50 ₽» */
function fmtPrice(kop: number): string {
  const rub = kop / 100
  const frac = Number.isInteger(rub) ? 0 : 2
  return `${rub.toLocaleString('ru-RU', { minimumFractionDigits: frac, maximumFractionDigits: 2 })} ₽`
}

export function PromotePackSheet({
  open,
  onClose,
  onBought,
}: {
  open: boolean
  onClose: () => void
  /** Покупка оформлена/зачислена — кабинету нужно перезагрузить /api/mychannel */
  onBought: () => void
}) {
  const patchBalance = useApp((s) => s.patchBalance)
  const [info, setInfo] = useState<PackInfo | null>(null)
  const [packId, setPackId] = useState<'starter' | 'growth' | 'max'>('growth')
  const [method, setMethod] = useState<BuyMethod>('balance')
  const [busy, setBusy] = useState(false)
  const [yk, setYk] = useState<{ token: string; title: string; half: boolean } | null>(null)

  // Открытие шита → свежие тиры/баланс/способы (кэш не нужен — шит открывают редко)
  useEffect(() => {
    if (!open) return
    let alive = true
    setInfo(null)
    api<PackInfo>('/api/promote-pack')
      .then((d) => {
        if (!alive) return
        setInfo(d)
        const packs = d.packs?.length ? d.packs : [{ id: 'growth' as const, count: d.count ?? 3, priceKop: d.priceKop ?? 34_900 }]
        const selected = packs.find((p) => p.id === packId) ?? packs[1] ?? packs[0]
        const price = selected.priceKop
        // Дефолт: самый «дешёвый для карты» доступный способ
        const bal = d.wallet.balanceKop
        setMethod(bal >= price ? 'balance' : bal >= Math.ceil(price / 2) ? 'half' : 'card')
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [open])

  const packs = info?.packs ?? [
    { id: 'starter' as const, count: 1, priceKop: 14_900 },
    { id: 'growth' as const, count: 3, priceKop: 34_900 },
    { id: 'max' as const, count: 10, priceKop: 89_900 },
  ]
  const selected = packs.find((p) => p.id === packId) ?? packs[1]
  const priceKop = selected.priceKop
  const count = selected.count
  const halfKop = Math.ceil(priceKop / 2)
  const balanceKop = info?.wallet.balanceKop ?? 0
  const cardEnabled = info?.methods.card ?? false
  const balanceAffordable = balanceKop >= priceKop
  const halfAffordable = balanceKop >= halfKop

  const buy = async () => {
    if (busy) return
    setBusy(true)
    haptic('light')
    try {
      const r = await api<{
        ok: boolean
        method: BuyMethod
        confirmationToken?: string
        credits?: number
        balanceKop?: number
      }>('/api/promote-pack', {
        method: 'POST',
        body: JSON.stringify({ method, pack: packId }),
      })
      if (r.method === 'balance') {
        haptic('success')
        toast.success(`Пакет активирован: +${count} продвижений`)
        if (typeof r.balanceKop === 'number') patchBalance({ balanceKop: r.balanceKop })
        onBought()
        onClose()
        return
      }
      if (r.confirmationToken) {
        // Виджет ЮKassa: после оплаты вебхук зачислит кредиты — onBought подтянет
        toast.success(
          r.method === 'half'
            ? `Списано ${fmtPrice(halfKop)} с баланса — оплатите вторую половину`
            : 'Счёт создан — оплатите картой',
        )
        setYk({
          token: r.confirmationToken,
          title: `${fmtPrice(r.method === 'half' ? halfKop : priceKop)} · пакет продвижений`,
          half: r.method === 'half',
        })
      }
    } catch (e) {
      toast.error((e as Error).message || 'Не удалось оформить покупку')
      haptic('error')
    } finally {
      setBusy(false)
    }
  }

  const options: Array<{ id: BuyMethod; label: string; icon: typeof Wallet; disabled: boolean; hint?: string }> = [
    {
      id: 'balance',
      label: `С баланса · ${fmtPrice(priceKop)}`,
      icon: Wallet,
      disabled: !balanceAffordable,
      hint: balanceAffordable ? undefined : `на балансе ${fmtPrice(balanceKop)} — пополните в профиле`,
    },
    {
      id: 'half',
      label: `50 / 50 · ${fmtPrice(halfKop)} + ${fmtPrice(halfKop)}`,
      icon: Rocket,
      disabled: !halfAffordable,
      hint: halfAffordable
        ? undefined
        : `нужно минимум ${fmtPrice(halfKop)} на балансе`,
    },
    {
      id: 'card',
      label: `Картой · ${fmtPrice(priceKop)}`,
      icon: CreditCard,
      disabled: !cardEnabled,
      hint: cardEnabled ? undefined : 'оплата картой скоро появится — пополните баланс',
    },
  ]
  // Баланс пуст → переключатель не показываем вовсе, только «Картой»
  const showSwitch = balanceKop > 0

  const btnLabel =
    method === 'balance'
      ? `Оплатить ${fmtPrice(priceKop)} с баланса`
      : method === 'half'
        ? `Списать ${fmtPrice(halfKop)} + счёт на ${fmtPrice(halfKop)}`
        : `Оплатить ${fmtPrice(priceKop)} картой`

  return (
    <>
      <BottomSheet
        open={open}
        onClose={onClose}
        title="Продвижения"
        subtitle="Докупка к бесплатному продвижению месяца"
      >
        {/* v5.74: выбор тира пакета */}
        <div className="card-soft rounded-2xl bg-tg-surface p-4">
          <p className="text-[15px] font-bold text-tg-text">Сколько продвижений нужно?</p>
          <p className="mt-0.5 text-[12.5px] leading-snug text-tg-hint">
            Поднимайте посты в первых рядах ленты — буст температуры на сутки. Кредиты не сгорают.
          </p>
          <div className="mt-3 space-y-2" role="radiogroup" aria-label="Размер пакета">
            {packs.map((p) => {
              const per = p.priceKop / p.count
              const best = p.id === 'max'
              const active = p.id === packId
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => {
                    haptic('light')
                    setPackId(p.id)
                  }}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition active:scale-[0.99]',
                    active
                      ? 'border-tg-link bg-tg-link/8'
                      : 'border-tg-sep/70 bg-tg-bg',
                  )}
                >
                  <span
                    className={cn(
                      'flex size-5 shrink-0 items-center justify-center rounded-full border-2',
                      active ? 'border-tg-link bg-tg-link text-white' : 'border-tg-sep',
                    )}
                    aria-hidden
                  >
                    {active && <Check className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-1.5">
                      <span className="text-[14px] font-bold text-tg-text">{p.count}</span>
                      <span className="text-[13.5px] font-medium text-tg-text2">
                        продвижени{p.count === 1 ? 'е' : p.count < 5 ? 'я' : 'й'}
                      </span>
                      {best && (
                        <span className="rounded-full bg-tg-green/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-tg-green">
                          выгода −40%
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-[11.5px] text-tg-hint">
                      ≈ {fmtPrice(Math.round(per))} за продвижение
                    </span>
                  </span>
                  <span className="shrink-0 text-[14.5px] font-bold text-tg-text">{fmtPrice(p.priceKop)}</span>
                </button>
              )
            })}
          </div>
          {info && info.credits > 0 && (
            <p className="mt-3 rounded-xl bg-tg-sep/30 px-3 py-2 text-[12.5px] text-tg-hint">
              Уже куплено: <span className="font-semibold text-tg-text2">{info.credits}</span> — расходуются
              после бесплатного продвижения месяца.
            </p>
          )}
        </div>

        {/* Способ оплаты */}
        {showSwitch ? (
          <div className="mt-3">
            <div className="space-y-1.5" role="radiogroup" aria-label="Способ оплаты">
              {options.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={method === o.id}
                  disabled={o.disabled}
                  onClick={() => {
                    haptic('light')
                    setMethod(o.id)
                  }}
                  className={cn(
                    'flex h-11 w-full items-center justify-start gap-2 rounded-xl border px-3 text-[13px] font-medium transition',
                    method === o.id
                      ? 'border-tg-link bg-tg-link/8 font-semibold text-tg-text'
                      : 'border-tg-sep/60 bg-tg-bg text-tg-hint',
                    o.disabled && 'opacity-40',
                  )}
                >
                  <o.icon className="h-4 w-4 shrink-0" strokeWidth={1.8} aria-hidden />
                  <span className="truncate">{o.label}</span>
                </button>
              ))}
            </div>
            {(() => {
              // Подсказки: почему недоступны задизейбленные варианты (баланс/50-50),
              // плюс подсказка выбранного варианта, если он доступен
              const disabledHints = options
                .filter((o) => o.disabled && o.hint)
                .map((o) => o.hint as string)
              const selected = options.find((o) => o.id === method)
              const hints = Array.from(
                new Set([
                  ...disabledHints,
                  ...(selected?.hint && !selected.disabled ? [selected.hint] : []),
                ]),
              )
              return hints.length > 0 ? (
                <div className="mt-1.5 space-y-0.5 px-1">
                  {hints.map((h) => (
                    <p key={h} className="text-[12px] leading-snug text-tg-hint">
                      {h}
                    </p>
                  ))}
                </div>
              ) : null
            })()}
          </div>
        ) : (
          !cardEnabled && (
            <p className="mt-3 px-1 text-[12px] leading-snug text-tg-hint">
              Оплата картой скоро появится — пополните рублёвый баланс в профиле, чтобы купить пакет
              с него.
            </p>
          )
        )}

        <button
          type="button"
          disabled={busy || (method === 'balance' && !balanceAffordable) || (method === 'half' && !halfAffordable) || (method === 'card' && !cardEnabled)}
          onClick={buy}
          className="press mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-tg-link text-[15px] font-semibold text-white disabled:bg-tg-sep/60 disabled:text-tg-hint"
        >
          {busy ? (
            <>
              <Loader2 className="h-4.5 w-4.5 animate-spin" aria-hidden />
              Оформляем…
            </>
          ) : (
            btnLabel
          )}
        </button>
        <p className="mt-2.5 text-center text-[12px] leading-snug text-tg-hint">
          С баланса — мгновенно. Картой — кредиты зачислятся автоматически после оплаты.
        </p>
      </BottomSheet>

      {/* ЮKassa: виджет для «Картой» и второй половины «50/50» */}
      <YooKassaWidget
        open={yk !== null}
        token={yk?.token ?? null}
        title={yk?.title ?? 'Оплата пакета'}
        onClose={() => {
          const wasHalf = yk?.half ?? false
          setYk(null)
          if (wasHalf) {
            // Половина уже списана: либо оплатит позже (вебхук зачислит),
            // либо отменит счёт — вебхук вернёт половину на баланс
            toast('Счёт сохранён — оплатите позже или отмените, половина вернётся на баланс')
          }
        }}
        onSuccess={() => {
          haptic('success')
          toast.success('Пакет продвижений зачислен')
          setYk(null)
          onBought()
          onClose()
        }}
      />
    </>
  )
}
