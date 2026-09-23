import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { plategaCreatePayment, plategaEnabled, PLATEGA_METHOD } from '@/lib/platega'
import { payWithBalance } from '@/lib/wallet'
import { invalidateBalance } from '@/lib/balance-cache'
import { paymentMethods } from '@/lib/payments'
import {
  VERIFY_PRICE_KOP,
  VERIFY_DAYS,
  verifyPurpose,
  BOOST_PLANS,
  boostPlanById,
  boostPurpose,
  MEMBERSHIP_PRESETS_KOP,
  MEMBERSHIP_MIN_KOP,
  MEMBERSHIP_MAX_KOP,
  MEMBERSHIP_AUTHOR_SHARE,
  assertOwnedChannel,
  isVerifiedEffective,
  isBoostActive,
  extendFrom,
} from '@/lib/monetize'

export const dynamic = 'force-dynamic'

/**
 * v6.1: МОНЕТИЗАЦИЯ ВЛАДЕЛЬЦА КАНАЛА («Мой канал» → раздел «Доход»).
 *
 * GET — состояние всех четырёх продуктов для каналов владельца:
 * верификация (срок/цена), буст каталога (срок/планы), платная подписка
 * (вкл/цена/подписчики/доход за 30 дней), биржа взаимопиара (входящие/
 * исходящие/кандидаты). Плюс рублёвый баланс и способы оплаты.
 *
 * POST (action):
 *  - buyVerify {channelId, method}   — 490 ₽/30 дней: с баланса мгновенно
 *    или счётом Platega (purpose 'verify:<channelId>', зачисление вебхуком);
 *  - buyBoost {channelId, plan, method} — 149 ₽/день, 599 ₽/7 дней
 *    (purpose 'boost:<channelId>:<days>');
 *  - membershipSave {channelId, priceKop|null, benefits?} — включить/выключить
 *    платную подписку (цена 29–2999 ₽/мес);
 *  - crosspromoSend {channelId, targetChannelId, message?} — заявка на
 *    взаимопиар владельцу сопоставимого канала;
 *  - crosspromoRespond {offerId, accept} — принять/отклонить входящую заявку.
 */

const postSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('buyVerify'),
    channelId: z.string().min(1),
    method: z.enum(['balance', 'card']),
  }),
  z.object({
    action: z.literal('buyBoost'),
    channelId: z.string().min(1),
    plan: z.enum(['d1', 'd7']),
    method: z.enum(['balance', 'card']),
  }),
  z.object({
    action: z.literal('membershipSave'),
    channelId: z.string().min(1),
    priceKop: z.number().int().nullable(),
    benefits: z.string().trim().max(300).optional(),
  }),
  z.object({
    action: z.literal('crosspromoSend'),
    channelId: z.string().min(1),
    targetChannelId: z.string().min(1),
    message: z.string().trim().max(300).optional(),
  }),
  z.object({
    action: z.literal('crosspromoRespond'),
    offerId: z.string().min(1),
    accept: z.boolean(),
  }),
  z.object({
    action: z.literal('postMemberToggle'), // v6.1: сделать пост платным/вернуть в общий доступ
    channelId: z.string().min(1),
    postId: z.string().min(1),
    memberOnly: z.boolean(),
  }),
])

/** Покупка с рублёвого баланса (мгновенно) или счётом Platega (вебхук) */
async function chargeOrBill(
  uid: string,
  priceKop: number,
  purpose: string,
  description: string,
  method: 'balance' | 'card',
):
  Promise<{ ok: true; via: 'balance' } | { ok: true; via: 'card'; redirect: string } | { ok: false; error: string; status: number }> {
  if (method === 'balance') {
    const ok = await payWithBalance(uid, priceKop, description)
    if (!ok) return { ok: false, error: 'На балансе не хватает — пополните кошелёк', status: 402 }
    return { ok: true, via: 'balance' }
  }
  if (!plategaEnabled()) {
    return { ok: false, error: 'Оплата картой скоро появится. Сейчас доступна оплата с баланса.', status: 503 }
  }
  const payment = await db.pendingPayment.create({
    data: { userId: uid, amountKop: priceKop, provider: 'platega', purpose },
    select: { id: true },
  })
  const created = await plategaCreatePayment({
    amountKop: priceKop,
    paymentId: payment.id,
    description,
    method: PLATEGA_METHOD.CARD_RU,
  })
  if (!created) {
    await db.pendingPayment
      .updateMany({ where: { id: payment.id, status: 'pending' }, data: { status: 'canceled' } })
      .catch(() => {})
    return { ok: false, error: 'Платёжная система не ответила — попробуйте ещё раз', status: 502 }
  }
  await db.pendingPayment.update({
    where: { id: payment.id },
    data: { providerPaymentId: created.transactionId, confirmationUrl: created.redirect },
  })
  return { ok: true, via: 'card', redirect: created.redirect }
}

/** Кандидаты биржи: привязанные активные каналы других владельцев в ±3x по аудитории */
async function crosspromoCandidates(myChannelId: string, mySize: number) {
  const rows = await db.channel.findMany({
    where: {
      status: 'active',
      claimedById: { not: null },
      id: { not: myChannelId },
      membersCount: {
        gte: Math.max(1, Math.floor(mySize / 3)),
        lte: Math.max(30, mySize * 3),
      },
    },
    select: {
      id: true,
      title: true,
      username: true,
      avatarColor: true,
      avatarUrl: true,
      photoFileId: true,
      subscribersCount: true,
      membersCount: true,
    },
    orderBy: { membersCount: 'desc' },
    take: 24,
  })
  // Убираем каналы, с которыми уже есть заявки/сделки в любую сторону
  const links = await db.crossPromo.findMany({
    where: { OR: [{ fromChannelId: myChannelId }, { toChannelId: myChannelId }] },
    select: { fromChannelId: true, toChannelId: true },
  })
  const linked = new Set(links.flatMap((l) => [l.fromChannelId, l.toChannelId]))
  return rows.filter((r) => !linked.has(r.id))
}

export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'monetize-get' })
  if (!g.ok) return g.res
  if (!g.uid) return err('Сессия не найдена', 401)

  try {
    const channels = await db.channel.findMany({
      where: { claimedById: g.uid },
      select: {
        id: true,
        title: true,
        username: true,
        avatarColor: true,
        avatarUrl: true,
        photoFileId: true,
        verified: true,
        verifiedUntil: true,
        boostUntil: true,
        membershipPriceKop: true,
        memberBenefits: true,
        subscribersCount: true,
        membersCount: true,
        _count: { select: { memberships: true } },
      },
      orderBy: { createdAt: 'asc' },
    })

    const ids = channels.map((c) => c.id)

    // Доход с подписок за 30 дней (по журналам авторов)
    const since = new Date(Date.now() - 30 * 86_400_000)
    const incomeRows = ids.length
      ? await db.balanceLog.findMany({
          where: { userId: g.uid, kind: 'membership_income', createdAt: { gte: since } },
          select: { amount: true },
        })
      : []
    const income30Kop = incomeRows.reduce((s, r) => s + r.amount, 0)

    const incoming = ids.length
      ? await db.crossPromo.findMany({
          where: { toChannelId: { in: ids }, status: 'PENDING' },
          select: {
            id: true,
            message: true,
            createdAt: true,
            fromChannel: {
              select: {
                id: true,
                title: true,
                username: true,
                avatarColor: true,
                avatarUrl: true,
                photoFileId: true,
                subscribersCount: true,
                membersCount: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        })
      : []

    const outgoing = ids.length
      ? await db.crossPromo.findMany({
          where: { fromChannelId: { in: ids } },
          select: {
            id: true,
            status: true,
            createdAt: true,
            message: true,
            toChannel: {
              select: {
                id: true,
                title: true,
                username: true,
                avatarColor: true,
                avatarUrl: true,
                photoFileId: true,
                subscribersCount: true,
                membersCount: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        })
      : []

    const candidates =
      ids.length > 0
        ? await crosspromoCandidates(ids[0], channels[0].membersCount ?? channels[0].subscribersCount)
        : []

    const wallet = await db.user.findUnique({
      where: { id: g.uid },
      select: { balanceKop: true },
    })

    return NextResponse.json({
      ok: true,
      verify: { priceKop: VERIFY_PRICE_KOP, days: VERIFY_DAYS },
      boost: { plans: BOOST_PLANS },
      membership: {
        presets: MEMBERSHIP_PRESETS_KOP,
        minKop: MEMBERSHIP_MIN_KOP,
        maxKop: MEMBERSHIP_MAX_KOP,
        authorShare: MEMBERSHIP_AUTHOR_SHARE,
        income30Kop,
      },
      channels: channels.map((c) => ({
        id: c.id,
        title: c.title,
        username: c.username,
        avatarColor: c.avatarColor,
        avatarUrl: c.avatarUrl,
        photoFileId: c.photoFileId,
        verifiedAdmin: c.verified,
        verifiedPaid: isVerifiedEffective(c) && !c.verified,
        verifiedUntil: c.verifiedUntil,
        boostActive: isBoostActive(c),
        boostUntil: c.boostUntil,
        membershipPriceKop: c.membershipPriceKop,
        memberBenefits: c.memberBenefits,
        membersCount: c._count.memberships,
        audience: c.membersCount ?? c.subscribersCount,
      })),
      crosspromo: {
        incoming: incoming.map((o) => ({
          id: o.id,
          message: o.message,
          createdAt: o.createdAt,
          channel: {
            id: o.fromChannel.id,
            title: o.fromChannel.title,
            username: o.fromChannel.username,
            avatarColor: o.fromChannel.avatarColor,
            avatarUrl: o.fromChannel.avatarUrl,
            photoFileId: o.fromChannel.photoFileId,
            audience: o.fromChannel.membersCount ?? o.fromChannel.subscribersCount,
          },
        })),
        outgoing: outgoing.map((o) => ({
          id: o.id,
          status: o.status,
          createdAt: o.createdAt,
          message: o.message,
          channel: {
            id: o.toChannel.id,
            title: o.toChannel.title,
            username: o.toChannel.username,
            avatarColor: o.toChannel.avatarColor,
            avatarUrl: o.toChannel.avatarUrl,
            photoFileId: o.toChannel.photoFileId,
            audience: o.toChannel.membersCount ?? o.toChannel.subscribersCount,
          },
        })),
        candidates: candidates.map((c) => ({
          id: c.id,
          title: c.title,
          username: c.username,
          avatarColor: c.avatarColor,
          avatarUrl: c.avatarUrl,
          photoFileId: c.photoFileId,
          audience: c.membersCount ?? c.subscribersCount,
        })),
      },
      wallet: { balanceKop: wallet?.balanceKop ?? 0 },
      methods: paymentMethods(),
    })
  } catch (e) {
    console.error('[monetize:get]', e)
    return err('Ошибка', 500)
  }
}

export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 12, windowMs: 60_000, bucket: 'monetize-post' })
  if (!g.ok) return g.res
  if (!g.uid) return err('Сессия не найдена', 401)

  try {
    const parsed = postSchema.safeParse(await readJson(request))
    if (!parsed.success) return err('Некорректные параметры', 400)
    const body = parsed.data

    // ---------- Верификация ----------
    if (body.action === 'buyVerify') {
      const ch = await assertOwnedChannel(g.uid, body.channelId)
      if (!ch) return err('Канал не найден среди ваших', 404)
      const billed = await chargeOrBill(
        g.uid,
        VERIFY_PRICE_KOP,
        verifyPurpose(ch.id),
        `Tg Swipe: верификация канала @${ch.username} · ${VERIFY_DAYS} дней`,
        body.method,
      )
      if (!billed.ok) return err(billed.error, billed.status)
      // С баланса — применяем сразу; счётом — вебхук (creditPendingPayment)
      if (billed.via === 'balance') {
        const cur = await db.channel.findUnique({
          where: { id: ch.id },
          select: { verifiedUntil: true },
        })
        await db.channel.update({
          where: { id: ch.id },
          data: { verifiedUntil: extendFrom(cur?.verifiedUntil ?? null, VERIFY_DAYS) },
        })
        await invalidateBalance(g.uid).catch(() => {})
        return NextResponse.json({ ok: true, via: 'balance' })
      }
      return NextResponse.json({ ok: true, via: 'card', redirect: billed.redirect })
    }

    // ---------- Буст каталога ----------
    if (body.action === 'buyBoost') {
      const ch = await assertOwnedChannel(g.uid, body.channelId)
      if (!ch) return err('Канал не найден среди ваших', 404)
      const plan = boostPlanById(body.plan)
      if (!plan) return err('План не найден', 400)
      const billed = await chargeOrBill(
        g.uid,
        plan.priceKop,
        boostPurpose(ch.id, plan.days),
        `Tg Swipe: буст каталога @${ch.username} · ${plan.label}`,
        body.method,
      )
      if (!billed.ok) return err(billed.error, billed.status)
      if (billed.via === 'balance') {
        const cur = await db.channel.findUnique({
          where: { id: ch.id },
          select: { boostUntil: true },
        })
        await db.channel.update({
          where: { id: ch.id },
          data: { boostUntil: extendFrom(cur?.boostUntil ?? null, plan.days) },
        })
        await invalidateBalance(g.uid).catch(() => {})
        return NextResponse.json({ ok: true, via: 'balance' })
      }
      return NextResponse.json({ ok: true, via: 'card', redirect: billed.redirect })
    }

    // ---------- Настройка платной подписки ----------
    if (body.action === 'membershipSave') {
      const ch = await assertOwnedChannel(g.uid, body.channelId)
      if (!ch) return err('Канал не найден среди ваших', 404)
      if (
        body.priceKop !== null &&
        (body.priceKop < MEMBERSHIP_MIN_KOP || body.priceKop > MEMBERSHIP_MAX_KOP)
      ) {
        return err('Цена вне допустимого диапазона', 400)
      }
      await db.channel.update({
        where: { id: ch.id },
        data: {
          membershipPriceKop: body.priceKop,
          memberBenefits: body.benefits?.trim() || null,
        },
      })
      return NextResponse.json({ ok: true })
    }

    // ---------- Биржа взаимопиара ----------
    if (body.action === 'crosspromoSend') {
      const ch = await assertOwnedChannel(g.uid, body.channelId)
      if (!ch) return err('Канал не найден среди ваших', 404)
      const target = await db.channel.findUnique({
        where: { id: body.targetChannelId },
        select: { id: true, claimedById: true, status: true },
      })
      if (!target || target.status !== 'active' || !target.claimedById) {
        return err('Канал-партнёр недоступен', 404)
      }
      if (target.claimedById === g.uid) return err('Это ваш собственный канал', 400)
      const dup = await db.crossPromo.findFirst({
        where: {
          OR: [
            { fromChannelId: ch.id, toChannelId: target.id },
            { fromChannelId: target.id, toChannelId: ch.id },
          ],
          status: { in: ['PENDING', 'ACCEPTED'] },
        },
        select: { id: true },
      })
      if (dup) return err('Заявка между этими каналами уже существует', 409)
      await db.crossPromo.create({
        data: { fromChannelId: ch.id, toChannelId: target.id, message: body.message || null },
      })
      return NextResponse.json({ ok: true })
    }

    // ---------- Платный пост: включить/выключить memberOnly ----------
    if (body.action === 'postMemberToggle') {
      const ch = await assertOwnedChannel(g.uid, body.channelId)
      if (!ch) return err('Канал не найден среди ваших', 404)
      const post = await db.post.findUnique({
        where: { id: body.postId },
        select: { id: true, channelId: true },
      })
      if (!post || post.channelId !== ch.id) return err('Пост не найден', 404)
      // memberOnly имеет смысл только при включённой подписке
      if (body.memberOnly) {
        const cur = await db.channel.findUnique({
          where: { id: ch.id },
          select: { membershipPriceKop: true },
        })
        if (!cur?.membershipPriceKop) {
          return err('Сначала включите платную подписку на канал', 400)
        }
      }
      await db.post.update({ where: { id: post.id }, data: { memberOnly: body.memberOnly } })
      // Инвалидация индексов ленты: пост уходит из глобального индекса / возвращается
      const { bumpCache } = await import('@/lib/redis')
      void bumpCache(['feed']).catch(() => {})
      return NextResponse.json({ ok: true, memberOnly: body.memberOnly })
    }

    // ---------- crosspromoRespond ----------
    const offer = await db.crossPromo.findUnique({
      where: { id: body.offerId },
      select: {
        id: true,
        status: true,
        toChannelId: true,
        toChannel: { select: { claimedById: true } },
      },
    })
    if (!offer) return err('Заявка не найдена', 404)
    if (offer.toChannel.claimedById !== g.uid) return err('Это не ваша заявка', 403)
    if (offer.status !== 'PENDING') return err('Заявка уже обработана', 409)
    await db.crossPromo.update({
      where: { id: offer.id },
      data: { status: body.accept ? 'ACCEPTED' : 'DECLINED', respondedAt: new Date() },
    })
    return NextResponse.json({ ok: true, status: body.accept ? 'ACCEPTED' : 'DECLINED' })
  } catch (e) {
    console.error('[monetize:post]', e)
    return err('Не удалось выполнить действие', 500)
  }
}
