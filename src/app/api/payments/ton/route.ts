import { NextResponse } from 'next/server'
import { z } from 'zod'
import QRCode from 'qrcode'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { getTonRubRate } from '@/lib/ton-rate'
import { creditPendingPayment, paymentMethods } from '@/lib/payments'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  swipes: z.coerce.number().int().min(100).max(50_000),
})

const TON_WALLET = () => process.env.TON_WALLET_ADDRESS?.trim() ?? ''
const NANO = 1_000_000_000

/** Уникальный код платежа в комментарии (memo) — по нему находим перевод */
function memoFor(): string {
  const hex = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `swipe-${hex}`
}

/**
 * POST /api/payments/ton { swipes } — счёт в TON для оплаты через Tonkeeper.
 *
 * Фиксируем сумму в TON по текущему курсу (с запасом +2% на волатильность),
 * пользователь платит по deep-link Tonkeeper с мемом-кодом. GET ?id= проверяет
 * поступление через TonAPI и зачисляет свайпы идемпотентно.
 */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 10, windowMs: 60_000, bucket: 'pay-ton' })
  if (!g.ok) return g.res

  if (!TON_WALLET()) return err('Оплата TON скоро появится', 503)

  try {
    const parsed = createSchema.safeParse(await readJson(request))
    if (!parsed.success) return err('Сумма: от 100 до 50 000 свайпов')
    const { swipes } = parsed.data

    const rate = await getTonRubRate()
    // Сколько TON за swipes ₽: свайпы/курс, +2% запас (курс плывёт, сеть берёт комиссию)
    const tonExact = (swipes / rate.rub) * 1.02
    // Округляем ВВЕРХ до 4 знаков — недоплата хуже переплаты
    const tonAmount = Math.ceil(tonExact * 10_000) / 10_000
    const amountNano = String(Math.round(tonAmount * NANO))

    const memo = memoFor()
    const payment = await db.pendingPayment.create({
      data: {
        userId: g.uid,
        amountKop: swipes * 100,
        provider: 'ton',
        providerPaymentId: `${memo}|${amountNano}`,
      },
      select: { id: true, createdAt: true },
    })

    const text = encodeURIComponent(memo)
    const address = TON_WALLET()
    // Универсальная ссылка Tonkeeper (открывает приложение) + нативная схема для QR
    const url = `https://app.tonkeeper.com/transfer/${address}?amount=${tonAmount}&text=${text}`
    const tonUrl = `ton://transfer/${address}?amount=${tonAmount}&text=${text}`
    const qrDataUrl = await QRCode.toDataURL(tonUrl, { width: 320, margin: 1 })

    return NextResponse.json({
      ok: true,
      paymentId: payment.id,
      address,
      memo,
      tonAmount,
      rubApprox: swipes,
      rate: rate.rub,
      url,
      qrDataUrl,
      expiresInMs: 60 * 60 * 1000, // счёт жив 1 час
    })
  } catch (e) {
    console.error('[payments/ton:create]', e)
    return err((e as Error).message || 'Не удалось создать счёт TON', 500)
  }
}

const statusSchema = z.object({
  id: z.string().min(1).max(64),
})

/** GET /api/payments/ton?id= — статус платежа (поллинг после оплаты) */
export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 120, windowMs: 60_000, bucket: 'pay-ton-status' })
  if (!g.ok) return g.res

  try {
    const url = new URL(request.url)
    const parsed = statusSchema.safeParse({ id: url.searchParams.get('id') ?? '' })
    if (!parsed.success) return err('id required')

    const payment = await db.pendingPayment.findFirst({
      where: { id: parsed.data.id, userId: g.uid, provider: 'ton' },
    })
    if (!payment) return err('Платёж не найден', 404)
    if (payment.status === 'succeeded') return NextResponse.json({ ok: true, status: 'succeeded' })
    if (payment.status === 'canceled') return NextResponse.json({ ok: true, status: 'canceled' })

    // Счёт жив 1 час — потом помечаем истёкшим (клиент предложит создать новый)
    if (Date.now() - payment.createdAt.getTime() > 60 * 60 * 1000) {
      await db.pendingPayment
        .updateMany({ where: { id: payment.id, status: 'pending' }, data: { status: 'canceled' } })
      return NextResponse.json({ ok: true, status: 'expired' })
    }

    const [memo, amountNano] = (payment.providerPaymentId ?? '').split('|')
    if (!memo || !amountNano) return NextResponse.json({ ok: true, status: 'pending' })

    // Ищем входящий перевод с нашим мемом (TonAPI, бесплатные запросы)
    const found = await findTonTransaction(TON_WALLET(), memo, BigInt(amountNano))
    if (found) {
      const credited = await creditPendingPayment(payment.id, found)
      return NextResponse.json({ ok: true, status: credited ? 'succeeded' : 'pending' })
    }

    return NextResponse.json({ ok: true, status: 'pending' })
  } catch (e) {
    console.error('[payments/ton:status]', e)
    return err('Не удалось проверить платёж', 500)
  }
}

/**
 * Поиск транзакции по memo: TonAPI /v2/accounts/{addr}/transactions — смотрим
 * входящие сообщения, в комментарии ищем точный код платежа. Сумму сверяем с
 * допуском 3% вниз (сеть могла съесть часть при переводе через промежуточный
 * кошелёк); недоплата больше допуска не зачисляется автоматически.
 */
async function findTonTransaction(
  address: string,
  memo: string,
  expectedNano: bigint,
): Promise<string | null> {
  if (!address) return null
  try {
    const res = await fetch(
      `https://tonapi.io/v2/accounts/${address}/transactions?limit=25`,
      { signal: AbortSignal.timeout(8000), cache: 'no-store' },
    )
    if (!res.ok) return null
    const d = (await res.json()) as {
      transactions?: Array<{
        hash?: string
        in_msg?: { value?: string; comment?: string; decoded_comment?: string; source?: { address?: string } }
      }>
    }
    const minNano = (expectedNano * BigInt(97)) / BigInt(100)
    for (const tx of d.transactions ?? []) {
      const comment = tx.in_msg?.comment ?? tx.in_msg?.decoded_comment ?? ''
      if (!comment.includes(memo)) continue
      const value = tx.in_msg?.value ? BigInt(tx.in_msg.value) : BigInt(0)
      if (value >= minNano) return tx.hash ?? memo
    }
    return null
  } catch {
    return null // сеть моргнула — следующий поллинг проверит снова
  }
}

/** Экспорт для health-проверок/UI: какие методы включены */
export function tonEnabled(): boolean {
  return paymentMethods().ton
}
