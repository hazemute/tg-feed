import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardPublic } from '@/lib/guard'
import { aiSearchAllowance, AI_SEARCH_DAILY_LIMIT, TIER_PRICES, tierExpiryFor, tierOfUser } from '@/lib/tiers'
import { paymentMethods } from '@/lib/payments'
import { legalInfo } from '@/lib/legal'
import { plategaCreatePayment, plategaEnabled, PLATEGA_METHOD } from '@/lib/platega'
import { payWithBalance, refundToBalance } from '@/lib/wallet'

export const dynamic = 'force-dynamic'

/**
 * Тарифы Tg Swipe (v5.17).
 *
 * GET /api/tiers — текущий тир сессии + состояние лимита ИИ-поиска + цены +
 * доступные способы оплаты (UI экрана «Тарифы»).
 *
 * POST /api/tiers { plan, period, method? } — счёт на покупку/продление тира:
 *  - method='balance' (v5.39): МГНОВЕННАЯ покупка с рублёвого кошелька, если
 *    денег хватает — без карты и Stars («за баланс покупается всё в сервисе»);
 *  - method='stars' (по умолчанию): Telegram Stars XTR-инвойс → invoiceUrl;
 *  - method='card' (v5.83): Platega (карта МИР) — redirect на страницу оплаты
 *    провайдера, статус ведут вебхук/поллинг (ЮKassa отключена полностью).
 * После оплаты (вебхук Platega / successful_payment бота) тир активируется
 * идемпотентно (lib/payments creditPendingPayment).
 */

const bodySchema = z.object({
  plan: z.enum(['plus', 'pro']),
  period: z.enum(['month', 'year']),
  method: z.enum(['balance', 'stars', 'card']).default('stars'),
})

const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN?.trim() ?? ''

export async function GET(request: Request) {
  const g = guardPublic(request, { limit: 60, windowMs: 60_000, bucket: 'tiers-get' })
  if (!g.ok) return g.res

  const tier = await tierOfUser(g.uid)
  let aiSearch: { used: number; limit: number; remaining: number | null }
  if (g.uid) {
    const a = await aiSearchAllowance(g.uid)
    aiSearch = {
      used: a.tier === 'free' ? AI_SEARCH_DAILY_LIMIT - a.remaining : 0,
      limit: a.tier === 'free' ? AI_SEARCH_DAILY_LIMIT : 0,
      remaining: Number.isFinite(a.remaining) ? a.remaining : null, // null — безлимит
    }
  } else {
    aiSearch = { used: 0, limit: AI_SEARCH_DAILY_LIMIT, remaining: AI_SEARCH_DAILY_LIMIT }
  }

  // tierUntil нужен только владельцу сессии; кошелёк — для кнопки «С баланса»
  let tierUntil: string | null = null
  let wallet: { balanceKop: number; swipes: number } | null = null
  if (g.uid) {
    const u = await db.user.findUnique({
      where: { id: g.uid },
      select: { tierUntil: true, balanceKop: true, swipes: true },
    })
    tierUntil = u?.tierUntil?.toISOString() ?? null
    if (u) wallet = { balanceKop: u.balanceKop, swipes: u.swipes }
  }

  return NextResponse.json({
    tier,
    tierUntil,
    aiSearch,
    prices: TIER_PRICES,
    methods: paymentMethods(),
    // Кошелёк (v5.39): UI показывает «С баланса», когда денег хватает
    wallet,
    // Реквизиты исполнителя: документ «Реквизиты и контакты», оферта (Platega)
    legal: legalInfo(),
  })
}

export async function POST(request: Request) {
  const g = guardPublic(request, { limit: 8, windowMs: 60_000, bucket: 'tiers-buy' })
  if (!g.ok) return g.res
  if (!g.uid) return err('Сессия не найдена — обновите приложение', 401)

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('Некорректный тариф')
    const { plan, period, method } = parsed.data

    const price = TIER_PRICES[plan]
    const stars = period === 'month' ? price.monthStars : price.yearStars
    const amountKop = period === 'month' ? price.monthKop : price.yearKop
    const purpose = `${plan}_${period}` // plus_month | plus_year | pro_month | pro_year

    /* С БАЛАНСА (v5.39): рублей хватает → тир активируется сразу, без счёта.
     * Идентичный creditPendingPayment сценарий: срок продлевается от tierUntil. */
    if (method === 'balance') {
      const paid = await payWithBalance(
        g.uid,
        amountKop,
        `тариф ${plan === 'pro' ? 'Snap Pro' : 'Snap Plus'} · ${period === 'month' ? 'месяц' : 'год'}`,
      )
      if (!paid) {
        return err('На балансе не хватает — пополните кошелёк в профиле', 402)
      }
      // v5.54: сбой после списания больше не «съедает» деньги — компенсирующий возврат
      try {
        const u = await db.user.findUnique({ where: { id: g.uid }, select: { tierUntil: true } })
        const until = tierExpiryFor(u?.tierUntil ?? null, period)
        await db.user.update({ where: { id: g.uid }, data: { tier: plan, tierUntil: until } })
        return NextResponse.json({
          ok: true,
          method: 'balance',
          tier: plan,
          tierUntil: until.toISOString(),
        })
      } catch (e) {
        await refundToBalance(g.uid, amountKop, `возврат: тариф не выдан (${plan}_${period})`).catch(() => {})
        throw e
      }
    }

    const payment = await db.pendingPayment.create({
      data: {
        userId: g.uid,
        amountKop,
        provider: method === 'card' ? 'platega' : 'stars',
        purpose,
      },
      select: { id: true },
    })

    const periodLabel = period === 'month' ? 'месяц' : 'год'
    const title = `${plan === 'pro' ? 'Snap Pro' : 'Snap Plus'} — 1 ${periodLabel}`
    const description =
      plan === 'pro'
        ? 'Безлимитный Snap Search, Snap Ассистент для канала, продвижение 1/мес + пакеты, CTA-кнопка, бейдж автора.'
        : 'Безлимитный Snap Search, инкогнито, приоритетная скорость, анимированные премиум-эмодзи.'

    /* Карта: Platega (v5.83, ЮKassa отключена) — redirect на страницу оплаты */
    if (method === 'card') {
      if (!plategaEnabled()) {
        await db.pendingPayment.updateMany({
          where: { id: payment.id, status: 'pending' },
          data: { status: 'canceled' },
        })
        return err('Оплата картой скоро появится. Сейчас доступна оплата в Telegram Stars.', 503)
      }
      const created = await plategaCreatePayment({
        amountKop,
        paymentId: payment.id,
        description: `Tg Swipe: ${title}. ${description}`,
        method: PLATEGA_METHOD.CARD_RU,
      })
      if (!created) {
        console.error('[tiers] platega create failed')
        await db.pendingPayment.updateMany({
          where: { id: payment.id, status: 'pending' },
          data: { status: 'canceled' },
        })
        return err('Платёжная система не ответила — попробуйте ещё раз', 502)
      }
      await db.pendingPayment.update({
        where: { id: payment.id },
        data: { providerPaymentId: created.transactionId, confirmationUrl: created.redirect },
      })
      return NextResponse.json({
        ok: true,
        paymentId: payment.id,
        method: 'card',
        redirect: created.redirect,
      })
    }

    /* Звёзды: XTR-инвойс через бота */
    if (!BOT_TOKEN()) return err('Оплата Stars временно недоступна', 503)

    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        description,
        payload: `tier:${g.uid}:${purpose}:${payment.id}`,
        currency: 'XTR',
        prices: [{ label: title, amount: stars }],
      }),
      signal: AbortSignal.timeout(8000),
    })
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean
      result?: string
      description?: string
    } | null
    if (!data?.ok || typeof data.result !== 'string') {
      console.error('[tiers] createInvoiceLink failed', data?.description)
      await db.pendingPayment.updateMany({
        where: { id: payment.id, status: 'pending' },
        data: { status: 'canceled' },
      })
      return err('Telegram не выдал счёт — попробуйте ещё раз', 502)
    }

    await db.pendingPayment.update({
      where: { id: payment.id },
      data: { providerPaymentId: `tier:${g.uid}:${purpose}:${payment.id}` },
    })

    return NextResponse.json({ ok: true, paymentId: payment.id, method: 'stars', invoiceUrl: data.result, stars })
  } catch (e) {
    console.error('[tiers:post]', e)
    return err('Не удалось создать счёт', 500)
  }
}
