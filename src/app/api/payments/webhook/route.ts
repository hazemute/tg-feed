import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { creditPendingPayment } from '@/lib/payments'
import { redis } from '@/lib/redis'
import { yookassaEnabled, yookassaGetPayment } from '@/lib/yookassa'
import { timingSafeEqualStr } from '@/lib/server'

export const dynamic = 'force-dynamic'

/**
 * POST /api/payments/webhook — нотификация эквайринга (ЮKassa).
 *
 * ЮKassa присылает JSON вида:
 *   { type: "notification", event: "payment.succeeded",
 *     object: { id, status: "succeeded", paid: true,
 *               amount: { value: "500.00", currency: "RUB" },
 *               metadata: { paymentId: "<наш PendingPayment.id>" } } }
 *
 * Начисление идемпотентно: платёж помечается succeeded АТОМАРНО
 * (updateMany по status='pending') — баланс рекламодателя растёт или тир
 * активируется ровно один раз (общая проводка creditPendingPayment).
 * Свайпы: 1 свайп = 1 ₽ → balanceKop += amountKop, topupsTotalKop += amountKop.
 * Тарифы: purpose plus_month/plus_year/pro_month/pro_year → tier + tierUntil.
 *
 * Защита: если задан YOOKASSA_WEBHOOK_SECRET — сверяем заголовок
 * x-yookassa-webhook-secret (настраивается в личном кабинете ЮKassa).
 * Дополнительно принимаем только платежи, существующие в PendingPayment.
 *
 * Харденинг (консервативно, существующий флоу зачисления не тронут):
 *  • content-type строго application/json — иначе 415;
 *  • content-length > 256KB — 413 (нотификации ЮKassa — маленький JSON);
 *  • IP-проверка в WARN-режиме: известные подсети нотификаций ЮKassa
 *    (185.71.76.0/27, 77.75.153.0/25, IPv6 2a02:5180::/32 — доки ЮKassa).
 *    Неизвестный IP НЕ блокируем (чтобы не потерять реальные платежи при
 *    смене их подсетей) — только console.warn раз в 60с;
 *  • идемпотентность по object.id: SET NX на 24ч (redis) — ретраи ЮKassa
 *    не повторно нагружают БД; при сбое обработки (500) лок снимается,
 *    чтобы ретрай смог обработаться. Без Redis остаётся идемпотентность
 *    уровня БД (атомарная проводка creditPendingPayment).
 */

/** Нотификации ЮKassa — маленький JSON; больше — мусор */
const YK_BODY_MAX_BYTES = 256 * 1024
/** Идемпотентность нотификаций: object.id → ключ на 24ч */
const YK_DEDUP_TTL_SEC = 86_400
/** Подсети-источники вебхуков ЮKassa (доки: 185.71.76.0/27, 77.75.153.0/25, 2a02:5180::/32) */
const YK_IP_PREFIXES = ['185.71.76.', '77.75.153.', '2a02:5180:']
const YK_IP_WARN_INTERVAL_MS = 60_000
let lastYkIpWarnAt = 0

type YkNotification = {
  event?: string
  object?: {
    id?: string
    status?: string
    paid?: boolean
    amount?: { value?: string; currency?: string }
    metadata?: { paymentId?: string }
  }
}

export async function POST(request: Request) {
  const secret = process.env.YOOKASSA_WEBHOOK_SECRET?.trim()
  let trustBody = false
  if (secret) {
    const got = (request.headers.get('x-yookassa-webhook-secret') ?? '').trim()
    if (!timingSafeEqualStr(got, secret)) return NextResponse.json({ ok: false }, { status: 401 })
    trustBody = true
  } else if (!yookassaEnabled()) {
    // v5.54: FAIL-CLOSED — без секрета вебхука и без кред магазина телу верить
    // нельзя (поддельная нотификация = бесплатное пополнение). Раньше при
    // незаданном секрете вебхук принимал всё — дыра в деньги.
    return NextResponse.json({ ok: false, error: 'webhook not configured' }, { status: 503 })
  }

  // Content-type: ЮKassa шлёт строго application/json; прочее — мусор/сканеры
  const contentType = (request.headers.get('content-type') ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (contentType !== 'application/json') {
    return NextResponse.json({ ok: false }, { status: 415 })
  }

  // Кап размера тела по заявленному content-length (до чтения тела)
  const declaredLen = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declaredLen) && declaredLen > YK_BODY_MAX_BYTES) {
    return NextResponse.json({ ok: false }, { status: 413 })
  }

  let body: YkNotification
  try {
    body = (await request.json()) as YkNotification
  } catch {
    return NextResponse.json({ ok: true }) // мусор не роняет вебхук
  }

  // Ключ идемпотентности объявлен ДО try — catch должен уметь снимать лок
  let dedupKey: string | null = null

  try {
    if (body.event !== 'payment.succeeded' && body.event !== 'payment.canceled') {
      return NextResponse.json({ ok: true, ignored: body.event ?? null })
    }

    const obj = body.object ?? {}

    // WARN-режим IP: реальные нотификации приходят с подсетей ЮKassa.
    // Неизвестный IP НЕ блокируем (не сломать реальные платежи при смене
    // их подсетей/proxy), только фиксируем раз в 60с (не спамить логами).
    const ip =
      (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() ||
      (request.headers.get('x-real-ip') ?? '').trim()
    if (
      ip &&
      !YK_IP_PREFIXES.some((p) => ip.startsWith(p)) &&
      Date.now() - lastYkIpWarnAt > YK_IP_WARN_INTERVAL_MS
    ) {
      lastYkIpWarnAt = Date.now()
      console.warn(
        '[payments/webhook] нотификация с IP вне известных подсетей ЮKassa — пропущена без блокировки:',
        ip,
      )
    }

    // Идемпотентность по object.id: ретраи нотификаций не должны повторно
    // гонять БД-проводку. Первый апдейт занимает ключ (SET NX, 24ч), дубликаты
    // получают мгновенный ok. При ошибке обработки лок снимается в catch —
    // ретрай ЮKassa сможет обработаться заново.
    if (redis && obj.id) {
      dedupKey = `ykwh:${obj.id}`
      try {
        const set = await redis.set(dedupKey, '1', { nx: true, ex: YK_DEDUP_TTL_SEC })
        const claimed = set === 'OK' || set === '1'
        if (!claimed) return NextResponse.json({ ok: true, dedup: true })
      } catch {
        dedupKey = null // Redis недоступен — идемпотентность остаётся на уровне БД
      }
    }

    // Наш платёж ищем по metadata.paymentId (появится при интеграции createPayment),
    // фолбэк — по providerPaymentId.
    const ourId = obj.metadata?.paymentId ?? ''
    const payment = await db.pendingPayment.findFirst({
      where: {
        OR: [
          ...(ourId ? [{ id: ourId }] : []),
          ...(obj.id ? [{ providerPaymentId: obj.id }] : []),
        ],
      },
    })
    if (!payment) {
      // Чужой/неизвестный платёж — отвечаем успехом, чтобы ЮKassa не ретраила
      return NextResponse.json({ ok: true, unknown: true })
    }

    if (body.event === 'payment.canceled') {
      await db.pendingPayment.updateMany({
        where: { id: payment.id, status: 'pending' },
        data: { status: 'canceled' },
      })
      return NextResponse.json({ ok: true })
    }

    // payment.succeeded: проверяем сумму и факт оплаты
    let paid = obj.paid === true && obj.status === 'succeeded'
    let kopFromAmount = obj.amount?.value
      ? Math.round(parseFloat(obj.amount.value) * 100)
      : 0
    // v5.54: без секрета вебхука — перепроверяем платёж напрямую в API ЮKassa
    // (тело нотификации могло быть подделано; API магазина — источник истины)
    if (!trustBody && obj.id) {
      const verified = await yookassaGetPayment(obj.id)
      if (!verified || verified.status !== 'succeeded' || !verified.paid) {
        return NextResponse.json({ ok: true, ignored: 'api verify failed' })
      }
      paid = true
      kopFromAmount = verified.amountKop
    }
    if (!paid || !Number.isFinite(kopFromAmount) || kopFromAmount <= 0) {
      return NextResponse.json({ ok: true, ignored: 'not paid' })
    }
    if (kopFromAmount !== payment.amountKop) {
      // Сумма не совпала — не начисляем (защита от подмены), помечаем для ручного разбора
      console.error('[payments/webhook] amount mismatch', {
        paymentId: payment.id,
        expected: payment.amountKop,
        got: kopFromAmount,
      })
      return NextResponse.json({ ok: false, error: 'amount mismatch' }, { status: 409 })
    }

    // Атомарная идемпотентная проводка: pending → succeeded + зачисление.
    // purpose='balance' → эскроу-баланс рекламодателя; purpose='plus_month'/
    // 'pro_year'/… → активация/продление тарифа Snap (lib/tiers).
    const result = await creditPendingPayment(payment.id, obj.id ?? payment.providerPaymentId)

    return NextResponse.json({ ok: true, credited: result })
  } catch (e) {
    console.error('[payments/webhook]', e)
    // Снимаем лок идемпотентности — ретрай ЮKassa должен обработаться
    if (redis && dedupKey) {
      void redis.del(dedupKey).catch(() => {})
    }
    // 500 → ЮKassa повторит нотификацию позже (это нам и нужно при сбое БД)
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
