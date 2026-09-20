/**
 * Эквайринг Platega (v5.43) — СБП/QR и карты МИР для пополнения баланса.
 *
 * Условия менеджера Platega (переписка владельца, 20.09.2026): СБП НСПК — 8%,
 * карточный эквайринг РФ (МИР, 2DS) — 9%, криптоплатежи — 5%; процент зависит
 * от оборотов и может быть снижен после согласования.
 *
 * API (platega-io.gitbook.io, .md-версии страниц):
 *  - POST app.platega.io/transaction/process — создать транзакцию
 *    (headers: X-MerchantId + X-Secret; paymentMethod: 2 = СБП/QR, 10 = CardRu,
 *    12 = международный; id — UUID НАШ транзакции; payload — свободное поле,
 *    возвращается в статусе — кладём туда id PendingPayment);
 *  - GET app.platega.io/transaction/{id} — статус:
 *    PENDING | CONFIRMED | EXPIRED | CANCELED | FAILED (+ payload, paymentDetails);
 *  - Callback — URL задаётся в кабинете Platega (Settings → Callback URLs);
 *    формат тела в доках не зафиксирован → вебхук НИКОГДА не доверяет телу
 *    колбэка и перечитывает статус через GET с нашими ключами (харднинг).
 *
 * Ключи: PLATEGA_MERCHANT_ID (UUID из кабинета) + PLATEGA_SECRET (vcp_…).
 * Без ключей методы честно скрываются (paymentMethods().sbp = false),
 * эндпоинты отвечают 503 — тот же паттерн, что у ЮKassa.
 */

const API = 'https://app.platega.io'

/** Значения paymentMethod из документации Platega */
export const PLATEGA_METHOD = { SBP: 2, CARD_RU: 10, INTERNATIONAL: 12 } as const

export function plategaEnabled(): boolean {
  return Boolean(process.env.PLATEGA_MERCHANT_ID?.trim() && process.env.PLATEGA_SECRET?.trim())
}

export type PlategaCreateResult = {
  transactionId: string
  redirect: string
  status: string
} | null

/**
 * Создать транзакцию Platega и вернуть ссылку на оплату (redirect).
 * opts.paymentId — наш PendingPayment.id: идём в payload, чтобы колбэк/статус
 * однозначно указывали на наш платёж без разбора description.
 */
export async function plategaCreatePayment(opts: {
  amountKop: number
  paymentId: string
  description: string
  method: number
}): Promise<PlategaCreateResult> {
  const merchant = process.env.PLATEGA_MERCHANT_ID?.trim() ?? ''
  const secret = process.env.PLATEGA_SECRET?.trim() ?? ''
  if (!merchant || !secret) return null

  const origin = process.env.NEXT_PUBLIC_SITE_URL?.trim() || 'https://tg-swipe.vercel.app'
  const amountRub = Math.round(opts.amountKop / 100)

  try {
    const res = await fetch(`${API}/transaction/process`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-MerchantId': merchant,
        'X-Secret': secret,
      },
      body: JSON.stringify({
        paymentMethod: opts.method,
        // id транзакции — UUID по требованиям API (наш cuid туда не подходит)
        id: crypto.randomUUID(),
        paymentDetails: { amount: amountRub, currency: 'RUB' },
        description: opts.description,
        return: `${origin}/?topup=done`,
        failedUrl: `${origin}/?topup=failed`,
        payload: opts.paymentId,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      console.error('[platega:create]', res.status, (await res.text()).slice(0, 300))
      return null
    }
    const j = (await res.json()) as { transactionId?: string; redirect?: string; status?: string }
    if (!j.transactionId || !j.redirect) {
      console.error('[platega:create] no transactionId/redirect in response')
      return null
    }
    return { transactionId: j.transactionId, redirect: j.redirect, status: j.status ?? 'PENDING' }
  } catch (e) {
    console.error('[platega:create]', e)
    return null
  }
}

export type PlategaStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'EXPIRED'
  | 'CANCELED'
  | 'FAILED'
  | 'UNKNOWN'

export type PlategaStatusInfo = {
  status: PlategaStatus
  /** наш payload (PendingPayment.id), если Platega его вернул */
  payload: string | null
  /** сумма в рублях, если вернулась */
  amountRub: number | null
}

/**
 * Статус транзакции — ИСТИНА только из прямого ответа API с нашими ключами.
 * Тело колбэка не доверяем (подписи в доках нет) — вебхук сверяется здесь.
 */
export async function plategaStatusInfo(transactionId: string): Promise<PlategaStatusInfo> {
  const empty: PlategaStatusInfo = { status: 'UNKNOWN', payload: null, amountRub: null }
  const merchant = process.env.PLATEGA_MERCHANT_ID?.trim() ?? ''
  const secret = process.env.PLATEGA_SECRET?.trim() ?? ''
  if (!merchant || !secret) return empty
  try {
    const res = await fetch(`${API}/transaction/${encodeURIComponent(transactionId)}`, {
      headers: { 'X-MerchantId': merchant, 'X-Secret': secret },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return empty
    const j = (await res.json()) as {
      status?: string
      payload?: string
      paymentDetails?: { amount?: number | string; currency?: string }
    }
    const s = String(j.status ?? '').toUpperCase()
    const status: PlategaStatus =
      s === 'CONFIRMED' ||
      s === 'PENDING' ||
      s === 'EXPIRED' ||
      s === 'CANCELED' ||
      s === 'FAILED'
        ? (s as PlategaStatus)
        : 'UNKNOWN'
    const amount =
      j.paymentDetails?.amount != null ? Number(j.paymentDetails.amount) : null
    return {
      status,
      payload: typeof j.payload === 'string' && j.payload ? j.payload : null,
      amountRub: Number.isFinite(amount) ? amount : null,
    }
  } catch {
    return empty
  }
}
