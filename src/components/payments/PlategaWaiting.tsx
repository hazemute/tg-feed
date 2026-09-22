'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Check, CreditCard, ExternalLink, Loader2, QrCode, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { openExternal } from '@/lib/tg'
import { useT } from '@/lib/i18n'

/**
 * Единый экран ожидания оплаты Platega (v5.83): используется ТОМУ ЖЕ паттерну
 * во всех рублёвых покупках — пополнение кошелька (TopUpModal), тариф Snap
 * (ProfileTab) и пакеты продвижений (PromotePackSheet).
 *
 * Счёт создаёт наш бэк (POST /api/payments/platega | /api/tiers | /api/promote-pack),
 * пользователь платит на странице провайдера (СБП/QR или карта МИР), а статус
 * читается ТОЛЬКО с нашего GET /api/payments/platega/status — истина из API
 * Platega, зачисление идемпотентное (creditPendingPayment).
 */

export type PlategaInfo = {
  paymentId: string
  redirect: string
  method: 'sbp' | 'card'
  rub: number
}

export type PlategaStatusState = 'waiting' | 'succeeded' | 'failed'

function formatRub(kop: number): string {
  const rub = kop / 100
  return rub % 1 === 0 ? `${rub.toLocaleString('ru-RU')} ₽` : `${rub.toFixed(2)} ₽`
}

export function PlategaWaiting({
  info,
  status,
  onStatus,
  onCancel,
  onClose,
}: {
  info: PlategaInfo
  status: PlategaStatusState
  onStatus: (s: PlategaStatusState) => void
  onCancel: () => void
  onClose: () => void
}) {
  const t = useT()
  const [checking, setChecking] = useState(false)

  /** Ручная/автоматическая проверка: статус читаем ТОЛЬКО с нашего API */
  const check = useCallback(async () => {
    setChecking(true)
    try {
      const r = await api<{ ok: boolean; status: 'pending' | 'succeeded' | 'failed' }>(
        `/api/payments/platega/status?paymentId=${encodeURIComponent(info.paymentId)}`,
      )
      onStatus(r.status === 'pending' ? 'waiting' : r.status)
    } catch {
      /* сеть моргнула — следующий тик повторит */
    } finally {
      setChecking(false)
    }
  }, [info.paymentId, onStatus])

  // Авто-поллинг раз в 4с: пользователь вернулся со страницы оплаты —
  // экран сам заметит подтверждение и зачислит покупку
  useEffect(() => {
    if (status !== 'waiting') return
    const timer = setInterval(check, 4000)
    return () => clearInterval(timer)
  }, [status, check])

  if (status === 'succeeded') {
    return (
      <div className="py-4 text-center">
        <motion.span
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-tg-green/15"
        >
          <Check className="h-8 w-8 text-tg-green" strokeWidth={2.5} />
        </motion.span>
        <div className="mt-3 text-[18px] font-bold text-tg-text">{t('topup.paid')}</div>
        <p className="mx-auto mt-1.5 max-w-[320px] text-[13.5px] leading-relaxed text-tg-hint">
          {t('topup.paidHint')}
        </p>
        <button
          type="button"
          onClick={onClose}
          className="press mt-4 h-12 w-full rounded-2xl bg-tg-link text-[15px] font-semibold text-white"
        >
          {t('topup.great')}
        </button>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center gap-3">
        <span
          className={cn(
            'flex h-10 w-10 items-center justify-center rounded-full',
            info.method === 'sbp' ? 'bg-tg-link/10 text-tg-link' : 'bg-tg-surface text-tg-text2',
          )}
        >
          {info.method === 'sbp' ? (
            <QrCode className="h-5.5 w-5.5" strokeWidth={1.9} />
          ) : (
            <CreditCard className="h-5.5 w-5.5" strokeWidth={1.9} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-bold text-tg-text">
            {t('topup.titleShort')} · {formatRub(info.rub * 100)}
          </div>
          <div className="text-[12.5px] text-tg-hint">
            {info.method === 'sbp' ? t('topup.tabSbp') : t('topup.tabCard')}
          </div>
        </div>
        {status === 'waiting' && (
          <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-tg-surface px-2.5 py-1 text-[11.5px] font-semibold text-tg-hint">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-tg-link" />
            {t('topup.plategaWaiting')}
          </span>
        )}
      </div>

      {status === 'failed' ? (
        <p className="mt-4 rounded-2xl bg-tg-surface/70 px-4 py-3 text-[13.5px] leading-relaxed text-tg-hint">
          {t('topup.plategaFailedHint')}
        </p>
      ) : (
        <>
          <p className="mt-4 rounded-2xl bg-tg-surface/70 px-4 py-3 text-[13.5px] leading-relaxed text-tg-hint">
            {t('topup.plategaHint')}
          </p>

          <button
            type="button"
            onClick={() => openExternal(info.redirect)}
            className="press mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-tg-link text-[15px] font-semibold text-white"
          >
            <ExternalLink className="h-4.5 w-4.5" />
            {t('topup.plategaOpen')}
          </button>

          <button
            type="button"
            onClick={check}
            disabled={checking}
            className="press mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-2xl bg-tg-surface text-[14px] font-semibold text-tg-text2 disabled:opacity-60"
          >
            <RefreshCw className={cn('h-4 w-4', checking && 'animate-spin')} />
            {t('topup.plategaCheck')}
          </button>
        </>
      )}

      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className={cn(
            'press flex h-11 flex-1 items-center justify-center gap-1.5 rounded-2xl text-[14px] font-semibold',
            status === 'failed' ? 'bg-tg-link text-white' : 'bg-tg-surface text-tg-text2',
          )}
        >
          {status === 'failed' ? t('topup.plategaRetry') : t('topup.otherMethod')}
        </button>
      </div>
    </div>
  )
}
