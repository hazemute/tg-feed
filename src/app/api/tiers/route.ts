import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardPublic } from '@/lib/guard'
import { aiSearchAllowance, AI_SEARCH_DAILY_LIMIT, TIER_PRICES, tierOfUser } from '@/lib/tiers'
import { paymentMethods } from '@/lib/payments'

export const dynamic = 'force-dynamic'

/**
 * Тарифы Tg Swipe (v5.17).
 *
 * GET /api/tiers — текущий тир сессии + состояние лимита ИИ-поиска + цены +
 * доступные способы оплаты (UI экрана «Тарифы»).
 *
 * POST /api/tiers { plan, period } — счёт Telegram Stars (XTR) на покупку/
 * продление тира. После оплаты бот присылает successful_payment в вебхук —
 * тир активируется идемпотентно (lib/payments creditPendingPayment).
 */

const bodySchema = z.object({
  plan: z.enum(['plus', 'pro']),
  period: z.enum(['month', 'year']),
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

  // tierUntil нужен только владельцу сессии
  let tierUntil: string | null = null
  if (g.uid) {
    const u = await db.user.findUnique({ where: { id: g.uid }, select: { tierUntil: true } })
    tierUntil = u?.tierUntil?.toISOString() ?? null
  }

  return NextResponse.json({
    tier,
    tierUntil,
    aiSearch,
    prices: TIER_PRICES,
    methods: paymentMethods(),
  })
}

export async function POST(request: Request) {
  const g = guardPublic(request, { limit: 8, windowMs: 60_000, bucket: 'tiers-buy' })
  if (!g.ok) return g.res
  if (!g.uid) return err('Сессия не найдена — обновите приложение', 401)
  if (!BOT_TOKEN()) return err('Оплата Stars временно недоступна', 503)

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('Некорректный тариф')
    const { plan, period } = parsed.data

    const price = TIER_PRICES[plan]
    const stars = period === 'month' ? price.monthStars : price.yearStars
    const purpose = `${plan}_${period}` // plus_month | plus_year | pro_month | pro_year

    const payment = await db.pendingPayment.create({
      data: {
        userId: g.uid,
        amountKop: period === 'month' ? price.monthKop : price.yearKop,
        provider: 'stars',
        purpose,
      },
      select: { id: true },
    })

    const periodLabel = period === 'month' ? 'месяц' : 'год'
    const title = `${plan === 'pro' ? 'Snap Pro' : 'Snap Plus'} — 1 ${periodLabel}`
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        description:
          plan === 'pro'
            ? 'Безлимитный ИИ-поиск, ИИ-ассистент для канала, продвижение 7/нед, CTA-кнопка, бейдж автора.'
            : 'Безлимитный ИИ-поиск, инкогнито, приоритетная скорость, анимированные премиум-эмодзи.',
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

    return NextResponse.json({ ok: true, paymentId: payment.id, invoiceUrl: data.result, stars })
  } catch (e) {
    console.error('[tiers:post]', e)
    return err('Не удалось создать счёт', 500)
  }
}
