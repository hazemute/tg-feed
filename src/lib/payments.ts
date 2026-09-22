import { db } from '@/lib/db'
import { parseTierPurpose, tierExpiryFor, isPromotePackPurpose, promotePackCountFromPurpose } from '@/lib/tiers'
import { invalidateBalance } from '@/lib/balance-cache'

/**
 * Общая проводка зачисления: pending → succeeded атомарно.
 *  - purpose='balance' (пополнение): РУБЛЁВЫЙ КОШЕЛЁК пользователя растёт ровно
 *    один раз (идемпотентность) — User.balanceKop += amountKop (v5.38: единый
 *    кошелёк, эскроу рекламодателя выведен из оборота);
 *  - purpose='plus_month'/'pro_year'/… (тариф Snap): срок действия тира
 *    продлевается от текущего tierUntil (или от «сейчас», если подписки не было);
 *  - purpose='promote_pack'/'promote_pack_half' (v5.69, пакет продвижений):
 *    User.promoteCredits += PROMOTE_PACK.count (полная сумма картой или половина
 *    при оплате 50/50 — половина с баланса списана до счёта).
 * Используется вебхуком ЮKassa, зачислением Telegram Stars и проверкой TON.
 */
export async function creditPendingPayment(
  paymentId: string,
  providerPaymentId?: string | null,
): Promise<boolean> {
  let creditedUserId: string | null = null
  const ok = await db.$transaction(async (tx) => {
    const claimed = await tx.pendingPayment.updateMany({
      where: { id: paymentId, status: 'pending' },
      data: {
        status: 'succeeded',
        ...(providerPaymentId ? { providerPaymentId } : {}),
      },
    })
    if (claimed.count === 0) return false // уже зачислен — повтор безопасен
    const payment = await tx.pendingPayment.findUnique({
      where: { id: paymentId },
      select: { userId: true, amountKop: true, purpose: true, provider: true },
    })
    if (!payment) return false
    creditedUserId = payment.userId

    // Тарифный платёж: активируем/продлеваем тир вместо зачисления на баланс
    const tierPurpose = parseTierPurpose(payment.purpose)
    if (tierPurpose) {
      const user = await tx.user.findUnique({
        where: { id: payment.userId },
        select: { tierUntil: true },
      })
      await tx.user.update({
        where: { id: payment.userId },
        data: {
          tier: tierPurpose.plan,
          tierUntil: tierExpiryFor(user?.tierUntil ?? null, tierPurpose.period),
        },
      })
      return true
    }

    // Пакет продвижений (v5.69; v5.74 — тиры 1/3/10, размер в purpose ':N'):
    // карта (полная сумма) или половина при 50/50. Идемпотентность — та же
    // атомарная проводка pending → succeeded выше: кредиты начисляются ровно
    // один раз, ретраи вебхука безопасны.
    if (isPromotePackPurpose(payment.purpose)) {
      await tx.user.updateMany({
        where: { id: payment.userId },
        data: { promoteCredits: { increment: promotePackCountFromPurpose(payment.purpose) } },
      })
      return true
    }

    // Пополнение кошелька (v5.38): рубли идут на User.balanceKop
    const updated = await tx.user.updateMany({
      where: { id: payment.userId },
      data: { balanceKop: { increment: payment.amountKop } },
    })
    if (updated.count === 0) {
      // Пользователя нет (не должен случаться: платежи создают только авторизованные) —
      // транзакцию роняем, вебхук вернёт 500 и ЮKassa ретранит позже.
      throw new Error(`creditPendingPayment: user ${payment.userId} not found`)
    }
    await tx.balanceLog.create({
      data: {
        userId: payment.userId,
        kind: 'topup',
        currency: 'rub',
        amount: payment.amountKop,
        note: `пополнение · ${payment.provider}`,
      },
    })
    return true
  })
  // v5.54: кэш баланса устарел — инвалидируем после проводки (раньше edge-роут
  // /api/wallet/balance отдавал старый баланс до 2 минут после пополнения)
  if (ok && creditedUserId) await invalidateBalance(creditedUserId).catch(() => {})
  return ok
}

/** Доступность способов пополнения по env (UI скрывает недоступные честно) */
export function paymentMethods(): { card: boolean; stars: boolean; ton: boolean; sbp: boolean } {
  // v5.83: ЮKassa отключена полностью — ВСЕ рублёвые платежи только через
  // Platega (СБП/QR 8%, карта МИР 9%). «Карта» и «СБП» — один провайдер:
  // card = sbp = plategaEnabled() (без ключей оба метода честно скрыты).
  const platega = Boolean(
    process.env.PLATEGA_MERCHANT_ID?.trim() && process.env.PLATEGA_SECRET?.trim(),
  )
  return {
    // Карта МИР через карточный эквайринг Platega (redirect на страницу оплаты)
    card: platega,
    // Telegram Stars: работает через нашего бота всегда (XTR-инвойсы)
    stars: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()),
    // TON: нужен адрес кошелька владельца для приёма переводов
    ton: Boolean(process.env.TON_WALLET_ADDRESS?.trim()),
    // СБП/QR через Platega
    sbp: platega,
  }
}
