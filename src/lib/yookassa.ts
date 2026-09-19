/**
 * Эквайринг ЮKassa (v5.17.1) — оплата КАРТОЙ НА САЙТЕ, без переадресации.
 *
 * Требование СБ ЮKassa: «оплата должна происходить непосредственно на вашем
 * сайте, без переадресаций на сторонние ресурсы». Поэтому используем ТОЛЬКО
 * confirmation: 'embedded' — сервер получает confirmation_token, а фронт
 * рисует платёжную форму виджетом ЮKassa внутри приложения (YooKassaWidget).
 *
 * Ключи: YOOKASSA_SHOP_ID + YOOKASSA_SECRET_KEY (env). Без ключей методы
 * карты честно скрываются из UI (paymentMethods()), а эндпоинты отвечают 503.
 */

const API = 'https://api.yookassa.ru/v3/payments'

export function yookassaEnabled(): boolean {
  return Boolean(process.env.YOOKASSA_SHOP_ID?.trim() && process.env.YOOKASSA_SECRET_KEY?.trim())
}

/** Реквизиты исполнителя для документов/СБ (env, заполняет владелец) */
export function legalInfo(): { name: string; inn: string; email: string } {
  return {
    name: process.env.LEGAL_NAME?.trim() ?? '',
    inn: process.env.LEGAL_INN?.trim() ?? '',
    email: process.env.SUPPORT_EMAIL?.trim() ?? '',
  }
}

export type YkPayment = {
  id: string
  confirmationToken: string | null
  confirmationUrl: string | null
}

/**
 * Создать платёж в ЮKassa (embedded-подтверждение).
 * Возвращает confirmation_token для виджета. Ошибки — null ( caller даёт 502).
 */
export async function yookassaCreatePayment(opts: {
  amountKop: number
  description: string
  paymentId: string
  email?: string | null
}): Promise<YkPayment | null> {
  const shopId = process.env.YOOKASSA_SHOP_ID?.trim() ?? ''
  const secretKey = process.env.YOOKASSA_SECRET_KEY?.trim() ?? ''
  if (!shopId || !secretKey) return null

  const body: Record<string, unknown> = {
    amount: { value: (opts.amountKop / 100).toFixed(2), currency: 'RUB' },
    capture: true, // одностадийная оплата — деньги списываются сразу
    confirmation: { type: 'embedded' }, // ВАЖНО: виджет на сайте, не redirect
    description: opts.description.slice(0, 128),
    metadata: { paymentId: opts.paymentId },
  }
  // Чек по 54-ФЗ: email плательщика, если знаем (profile.email недоступен —
  // передаём только когда явно пришёл из формы)
  if (opts.email) {
    body.receipt = {
      customer: { email: opts.email.slice(0, 128) },
      items: [
        {
          description: opts.description.slice(0, 128),
          quantity: '1.00',
          amount: { value: (opts.amountKop / 100).toFixed(2), currency: 'RUB' },
          vat_code: 1, // без НДС (УСН)
          payment_subject: 'service',
          payment_mode: 'full_payment',
        },
      ],
    }
  }

  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotence-Key': opts.paymentId, // наш cuid — идеальный ключ идемпотентности
        Authorization: `Basic ${Buffer.from(`${shopId}:${secretKey}`).toString('base64')}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    })
    const data = (await res.json().catch(() => null)) as {
      id?: string
      confirmation_token?: string
      confirmation?: { confirmation_token?: string; confirmation_url?: string }
      description?: string
    } | null
    if (!res.ok || !data?.id) {
      console.error('[yookassa] create failed', data?.description)
      return null
    }
    return {
      id: data.id,
      confirmationToken: data.confirmation_token ?? data.confirmation?.confirmation_token ?? null,
      confirmationUrl: data.confirmation?.confirmation_url ?? null,
    }
  } catch (e) {
    console.error('[yookassa] create error', e)
    return null
  }
}
