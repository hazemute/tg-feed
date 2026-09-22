import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { PROMOTE_PACKS, promotePackById, tierAtLeast, tierOfUser } from '@/lib/tiers'
import { paymentMethods } from '@/lib/payments'
import { yookassaCreatePayment, yookassaEnabled } from '@/lib/yookassa'
import { buyPromotePackWithBalance, payWithBalance, refundToBalance } from '@/lib/wallet'

export const dynamic = 'force-dynamic'

const buySchema = z.object({
  // balance — вся сумма с рублёвого кошелька (мгновенно);
  // half — 50/50: половина с баланса сейчас + счёт на половину картой;
  // card — счёт на всю сумму картой (ЮKassa embedded).
  method: z.enum(['balance', 'half', 'card']),
  // v5.74: тир пакета (starter=1 · growth=3 · max=10). Пропуск → growth.
  pack: z.enum(['starter', 'growth', 'max']).optional(),
})

/**
 * Пакет продвижений (v5.69 → v5.74) — докупка к бесплатному месячному лимиту
 * Snap Pro (1 продвижение/месяц). ТИРЫ: starter 1 за 149 ₽, growth 3 за 349 ₽,
 * max 10 за 899 ₽.
 *
 * GET /api/promote-pack — тиры/цены, доступные способы оплаты и рублёвый
 * баланс кошелька (UI переключателя «С баланса / 50/50 / Картой»).
 *
 * POST /api/promote-pack { method, pack } — покупка:
 *  - balance: атомарная транзакция — списание рублей + зачисление кредитов
 *    (buyPromotePackWithBalance), без карт и счетов;
 *  - half: половина списывается с баланса (атомарно, журнал 'purchase'),
 *    на вторую половину создаётся PendingPayment purpose='promote_pack_half'
 *    и счёт ЮKassa; при отмене счёта вебхук возвращает списанную половину;
 *  - card: PendingPayment purpose='promote_pack' на всю сумму + счёт ЮKassa.
 * Зачисление кредитов по счёту — идемпотентно (creditPendingPayment:
 * pending → succeeded атомарно, ретраи вебхука не задвоят кредиты).
 */
export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'promote-pack-get' })
  if (!g.ok) return g.res

  try {
    const user = await db.user.findUnique({
      where: { id: g.uid },
      select: { balanceKop: true, swipes: true, promoteCredits: true },
    })
    return NextResponse.json({
      ok: true,
      // v5.74: тиры пакетов + выбранная по умолчанию позиция (growth)
      packs: PROMOTE_PACKS,
      packId: 'growth',
      priceKop: PROMOTE_PACKS[1].priceKop,
      count: PROMOTE_PACKS[1].count,
      credits: user?.promoteCredits ?? 0,
      wallet: { balanceKop: user?.balanceKop ?? 0, swipes: user?.swipes ?? 0 },
      methods: paymentMethods(),
    })
  } catch (e) {
    console.error('[promote-pack:get]', e)
    return err('Ошибка', 500)
  }
}

export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 8, windowMs: 60_000, bucket: 'promote-pack-buy' })
  if (!g.ok) return g.res
  if (!g.uid) return err('Сессия не найдена — обновите приложение', 401)

  try {
    const parsed = buySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('Некорректный способ оплаты')
    const { method } = parsed.data
    const pack = promotePackById(parsed.data.pack ?? 'growth') ?? PROMOTE_PACKS[1]

    // Пакет — докупка к месячному бесплатному продвижению Snap Pro:
    // без тира кредиты невозможно использовать, не продаём бесполезное.
    const tier = await tierOfUser(g.uid)
    if (!tierAtLeast(tier, 'pro')) {
      return NextResponse.json(
        { error: 'pro_required', message: 'Пакет продвижений доступен на тарифе Snap Pro' },
        { status: 402 },
      )
    }

    const { priceKop, count, id: packId } = pack
    const note = `пакет продвижений · ${count} шт`
    // v5.74: размер пакета едет в purpose — вебхук начисляет ровно столько кредитов
    const purposeFull = `promote_pack:${count}`
    const purposeHalf = `promote_pack_half:${count}`

    /* С БАЛАНСА: рублей хватает → кредиты зачисляются мгновенно, одной транзакцией */
    if (method === 'balance') {
      const ok = await buyPromotePackWithBalance(g.uid, priceKop, count, note)
      if (!ok) {
        return err('На балансе не хватает — пополните кошелёк в профиле', 402)
      }
      const user = await db.user.findUnique({
        where: { id: g.uid },
        select: { promoteCredits: true, balanceKop: true },
      })
      return NextResponse.json({
        ok: true,
        method: 'balance',
        pack: packId,
        credits: user?.promoteCredits ?? 0,
        balanceKop: user?.balanceKop ?? 0,
      })
    }

    /* 50/50: половина с баланса сейчас + счёт на половину картой */
    if (method === 'half') {
      if (!yookassaEnabled()) {
        return err('Оплата картой скоро появится. Сейчас доступна оплата с баланса.', 503)
      }
      const halfKop = Math.ceil(priceKop / 2)
      // Атомарное списание половины (условный декремент — не уйдёт в минус)
      const debited = await payWithBalance(g.uid, halfKop, `${note} · 50% с баланса`)
      if (!debited) {
        return err('На балансе не хватает даже на половину — пополните кошелёк', 402)
      }
      // v5.54-паттерн компенсации: сбой после списания → возврат половины
      try {
        const payment = await db.pendingPayment.create({
          data: {
            userId: g.uid,
            amountKop: halfKop,
            provider: 'yookassa',
            purpose: purposeHalf,
          },
          select: { id: true },
        })
        const yk = await yookassaCreatePayment({
          amountKop: halfKop,
          description: `Tg Swipe: пакет продвижений ×${count} · вторая половина (50/50)`,
          paymentId: payment.id,
        })
        if (!yk || !yk.confirmationToken) {
          console.error('[promote-pack:half] yookassa create failed')
          await db.pendingPayment.updateMany({
            where: { id: payment.id, status: 'pending' },
            data: { status: 'canceled' },
          })
          await refundToBalance(g.uid, halfKop, 'возврат: счёт не создан (пакет 50/50)')
          return err('Эквайринг не ответил — попробуйте ещё раз', 502)
        }
        await db.pendingPayment.update({
          where: { id: payment.id },
          data: { providerPaymentId: yk.id, confirmationUrl: yk.confirmationUrl },
        })
        return NextResponse.json({
          ok: true,
          method: 'half',
          paymentId: payment.id,
          confirmationToken: yk.confirmationToken,
        })
      } catch (e) {
        await refundToBalance(g.uid, halfKop, 'возврат: сбой счёта (пакет 50/50)').catch(() => {})
        throw e
      }
    }

    /* КАРТОЙ: счёт на всю сумму (ЮKassa embedded — виджет на сайте) */
    const payment = await db.pendingPayment.create({
      data: {
        userId: g.uid,
        amountKop: priceKop,
        provider: 'yookassa',
        purpose: purposeFull,
      },
      select: { id: true },
    })

    if (!yookassaEnabled()) {
      await db.pendingPayment.updateMany({
        where: { id: payment.id, status: 'pending' },
        data: { status: 'canceled' },
      })
      return err('Оплата картой скоро появится. Сейчас доступна оплата с баланса.', 503)
    }

    const yk = await yookassaCreatePayment({
      amountKop: priceKop,
      description: `Tg Swipe: пакет продвижений ×${count}`,
      paymentId: payment.id,
    })
    if (!yk || !yk.confirmationToken) {
      console.error('[promote-pack:card] yookassa create failed')
      await db.pendingPayment.updateMany({
        where: { id: payment.id, status: 'pending' },
        data: { status: 'canceled' },
      })
      return err('Эквайринг не ответил — попробуйте ещё раз', 502)
    }
    await db.pendingPayment.update({
      where: { id: payment.id },
      data: { providerPaymentId: yk.id, confirmationUrl: yk.confirmationUrl },
    })
    return NextResponse.json({
      ok: true,
      method: 'card',
      paymentId: payment.id,
      confirmationToken: yk.confirmationToken,
    })
  } catch (e) {
    console.error('[promote-pack:post]', e)
    return err('Не удалось оформить покупку', 500)
  }
}
