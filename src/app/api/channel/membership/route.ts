import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { invalidateBalance } from '@/lib/balance-cache'
import { buyMembershipFromBalance } from '@/lib/monetize'

export const dynamic = 'force-dynamic'

/**
 * v6.1: ПЛАТНАЯ ПОДПИСКА НА АВТОРА — сторона ЧИТАТЕЛЯ.
 *
 * GET  /api/channel/membership?channelId=…
 *      → { priceKop, benefits, isMember, until } | { priceKop: null } —
 *        подписка выключена.
 *
 * POST /api/channel/membership { channelId }
 *      → покупка/продление 30 дней с рублёвого кошелька. 70% автору
 *        (BalanceLog 'membership_income'), 30% платформе. После покупки
 *        открываются memberOnly-посты канала.
 *      Ошибки: 402 не хватает баланса, 404 канал/подписка недоступны.
 */

const postSchema = z.object({ channelId: z.string().min(1) })

export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'membership-get' })
  if (!g.ok) return g.res
  if (!g.uid) return err('Сессия не найдена', 401)

  try {
    const { searchParams } = new URL(request.url)
    const channelId = searchParams.get('channelId') ?? ''
    if (!channelId) return err('channelId обязателен', 400)

    const channel = await db.channel.findUnique({
      where: { id: channelId },
      select: { membershipPriceKop: true, memberBenefits: true },
    })
    if (!channel?.membershipPriceKop) {
      return NextResponse.json({ ok: true, priceKop: null })
    }
    const ms = await db.channelMembership.findUnique({
      where: { userId_channelId: { userId: g.uid, channelId } },
      select: { until: true },
    })
    const isMember = Boolean(ms && ms.until > new Date())
    return NextResponse.json({
      ok: true,
      priceKop: channel.membershipPriceKop,
      benefits: channel.memberBenefits,
      isMember,
      until: ms?.until ?? null,
    })
  } catch (e) {
    console.error('[membership:get]', e)
    return err('Ошибка', 500)
  }
}

export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 8, windowMs: 60_000, bucket: 'membership-post' })
  if (!g.ok) return g.res
  if (!g.uid) return err('Сессия не найдена', 401)

  try {
    const parsed = postSchema.safeParse(await readJson(request))
    if (!parsed.success) return err('Некорректные параметры', 400)

    const result = await buyMembershipFromBalance(g.uid, parsed.data.channelId)
    if (!result) {
      // Различаем причины: выключена подписка / свой канал / нет денег
      const channel = await db.channel.findUnique({
        where: { id: parsed.data.channelId },
        select: { membershipPriceKop: true, claimedById: true, status: true },
      })
      if (!channel || !channel.membershipPriceKop || channel.status !== 'active') {
        return err('Платная подписка на этот канал недоступна', 404)
      }
      if (channel.claimedById === g.uid) return err('Это ваш канал', 400)
      return err('На балансе не хватает — пополните кошелёк', 402)
    }
    await invalidateBalance(g.uid).catch(() => {})
    return NextResponse.json({ ok: true, until: result.until, priceKop: result.priceKop })
  } catch (e) {
    console.error('[membership:post]', e)
    return err('Не удалось оформить подписку', 500)
  }
}
