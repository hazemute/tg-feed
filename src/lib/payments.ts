import { db } from '@/lib/db'

/**
 * Общая проводка зачисления свайпов: pending → succeeded атомарно,
 * эскроу-баланс рекламодателя растёт ровно один раз (идемпотентность).
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
      select: { userId: true, amountKop: true },
    })
    if (!payment) return false
    await tx.advertiserAccount.upsert({
      where: { userId: payment.userId },
      update: {
        balanceKop: { increment: payment.amountKop },
        topupsTotalKop: { increment: payment.amountKop },
      },
      create: {
        userId: payment.userId,
        balanceKop: payment.amountKop,
        topupsTotalKop: payment.amountKop,
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
