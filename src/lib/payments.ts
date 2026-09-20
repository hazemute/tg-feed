import { db } from '@/lib/db'
import { parseTierPurpose, tierExpiryFor } from '@/lib/tiers'

/**
 * Общая проводка зачисления: pending → succeeded атомарно.
 *  - purpose='balance' (пополнение): РУБЛЁВЫЙ КОШЕЛЁК пользователя растёт ровно
 *    один раз (идемпотентность) — User.balanceKop += amountKop (v5.38: единый
 *    кошелёк, эскроу рекламодателя выведен из оборота);
 *  - purpose='plus_month'/'pro_year'/… (тариф Snap): срок действия тира
 *    продлевается от текущего tierUntil (или от «сейчас», если подписки не было).
 * Используется вебхуком ЮKassa, зачислением Telegram Stars и проверкой TON.
 */
export async function creditPendingPayment(
  paymentId: string,
  providerPaymentId?: string | null,
): Promise<boolean> {
  return db.$transaction(async (tx) => {
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
}

/** Доступность способов пополнения по env (UI скрывает недоступные честно) */
export function paymentMethods(): { card: boolean; stars: boolean; ton: boolean } {
  return {
    // ЮKassa: нужны ключи магазина — до подключения метода не показываем
    card: Boolean(
      process.env.YOOKASSA_SHOP_ID?.trim() && process.env.YOOKASSA_SECRET_KEY?.trim(),
    ),
    // Telegram Stars: работает через нашего бота всегда (XTR-инвойсы)
    stars: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()),
    // TON: нужен адрес кошелька владельца для приёма переводов
    ton: Boolean(process.env.TON_WALLET_ADDRESS?.trim()),
  }
}
