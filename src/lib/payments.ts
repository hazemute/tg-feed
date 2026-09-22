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
      select: { id: true, userId: true, amountKop: true, purpose: true, provider: true },
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

    /*
     * v5.98: СПОНСОР РОЗЫГРЫША (purpose='sponsor', фикс 990 ₽ / эквив Stars).
     * Sponsor PENDING (найден по paymentId) → ACTIVE: канал привязывается к
     * текущему активному розыгрышу — username дописывается в Giveaway.channels
     * (обязательные подписки), после чего задание «спонсоры» засчитывается
     * подписчикам всех активных спонсоров. Идемпотентность — проводка выше.
     */
    if (payment.purpose === 'sponsor') {
      const sponsor = await tx.sponsor.findFirst({
        where: { paymentId: payment.id, status: 'PENDING' },
        select: { id: true, username: true, giveawayId: true },
      })
      if (sponsor) {
        await tx.sponsor.update({
          where: { id: sponsor.id },
          data: { status: 'ACTIVE', paidAt: new Date() },
        })
        // Привязка к розыгрышу: берём записанный giveawayId или активный на момент оплаты
        const gw =
          (sponsor.giveawayId
            ? await tx.giveaway.findUnique({
                where: { id: sponsor.giveawayId },
                select: { id: true, channels: true },
              })
            : null) ??
          (await tx.giveaway.findFirst({
            where: { status: 'active' },
            orderBy: { endAt: 'asc' },
            select: { id: true, channels: true },
          }))
        if (gw) {
          const channels: string[] = JSON.parse(gw.channels || '[]')
          if (!channels.includes(sponsor.username)) channels.push(sponsor.username)
          await tx.giveaway.update({ where: { id: gw.id }, data: { channels: JSON.stringify(channels) } })
          await tx.sponsor.update({ where: { id: sponsor.id }, data: { giveawayId: gw.id } })
        }
      }
      return true
    }

    /*
     * v5.98: СЛОТ РЕКЛАМНОГО КАЛЕНДАРЯ (purpose='adslot:<slotId>', фикс 990 ₽ /
     * эквив Stars) → AdSlot PENDING → PAID. Публикацию в @SnapTeamDev делает
     * крон (lib/ad-slots.ts) в момент runAt (12:00/18:00 МСК).
     */
    if (payment.purpose.startsWith('adslot:')) {
      const slotId = payment.purpose.slice('adslot:'.length)
      await tx.adSlot.updateMany({
        where: { id: slotId, paymentId: payment.id, status: 'PENDING' },
        data: { status: 'PAID' },
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
