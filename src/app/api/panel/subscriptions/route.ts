import { NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 20
const DAY_MS = 86_400_000
const TIER_PURPOSES = ['plus_month', 'plus_year', 'pro_month', 'pro_year']

/**
 * GET /api/panel/subscriptions?q=&page=1 — управление подписками Snap Plus/Pro.
 * Возвращает метрики (активные Plus/Pro, истекающие ≤3д/≤7д, статистика журнала)
 * и список подписчиков с сроком действия. Доступ: x-admin-key.
 */
export async function GET(request: Request) {
  const g = guardAdmin(request, { limit: 120, windowMs: 60_000, bucket: 'panel-subs' })
  if (!g.ok) return g.res

  try {
    const url = new URL(request.url)
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 64)
    const pageRaw = Number(url.searchParams.get('page') ?? '1')
    const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.min(500, Math.floor(pageRaw)) : 1
    const view = url.searchParams.get('view') === 'expiring' ? 'expiring' : 'active'

    const now = Date.now()
    const where: Prisma.UserWhereInput = {
      tier: { in: ['plus', 'pro'] },
      OR: [{ tierUntil: { gt: new Date(now) } }, { tierUntil: null }],
    }
    if (view === 'expiring') {
      where.tierUntil = { gt: new Date(now), lte: new Date(now + 7 * DAY_MS) }
    }
    if (q) {
      where.AND = [
        {
          OR: [
            { id: { contains: qLower(q) } },
            { username: { contains: qLower(q) } },
            { firstName: { contains: qLower(q) } },
            { firstName: { contains: q } },
          ],
        },
      ]
    }

    const [total, items, cntPlus, cntPro, expiring3, expiring7, logStats, recentPayments] =
      await Promise.all([
        db.user.count({ where }),
        db.user.findMany({
          where,
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            isGuest: true,
            tier: true,
            tierUntil: true,
            createdAt: true,
          },
          orderBy: view === 'expiring' ? [{ tierUntil: 'asc' }] : [{ createdAt: 'desc' }],
          skip: (page - 1) * PAGE_SIZE,
          take: PAGE_SIZE,
        }),
        db.user.count({
          where: { tier: 'plus', OR: [{ tierUntil: { gt: new Date(now) } }, { tierUntil: null }] },
        }),
        db.user.count({
          where: { tier: 'pro', OR: [{ tierUntil: { gt: new Date(now) } }, { tierUntil: null }] },
        }),
        db.user.count({
          where: {
            tier: { in: ['plus', 'pro'] },
            tierUntil: { gt: new Date(now), lte: new Date(now + 3 * DAY_MS) },
          },
        }),
        db.user.count({
          where: {
            tier: { in: ['plus', 'pro'] },
            tierUntil: { gt: new Date(now), lte: new Date(now + 7 * DAY_MS) },
          },
        }),
        db.adminLog.groupBy({
          by: ['action'],
          _count: { _all: true },
          where: { action: { in: ['tier_grant', 'tier_extend', 'tier_revoke'] } },
        }),
        db.pendingPayment.findMany({
          where: { status: 'succeeded', purpose: { in: TIER_PURPOSES } },
          orderBy: { createdAt: 'desc' },
          take: 8,
          select: {
            userId: true,
            amountKop: true,
            purpose: true,
            createdAt: true,
          },
        }),
      ])

    // Имена плательщиков одним запросом (у PendingPayment нет relation на User)
    const payers = await db.user.findMany({
      where: { id: { in: recentPayments.map((p) => p.userId) } },
      select: { id: true, username: true, firstName: true, lastName: true },
    })
    const payerMap = new Map(payers.map((u) => [u.id, u]))

    return NextResponse.json({
      metrics: {
        activePlus: cntPlus,
        activePro: cntPro,
        expiring3d: expiring3,
        expiring7d: expiring7,
        granted: logStats.find((s) => s.action === 'tier_grant')?._count._all ?? 0,
        extended: logStats.find((s) => s.action === 'tier_extend')?._count._all ?? 0,
        revoked: logStats.find((s) => s.action === 'tier_revoke')?._count._all ?? 0,
      },
      items: items.map((u) => ({
        id: u.id,
        username: u.username,
        firstName: u.firstName,
        lastName: u.lastName,
        isGuest: u.isGuest,
        tier: u.tier,
        tierUntil: u.tierUntil ? u.tierUntil.toISOString() : null,
        createdAt: u.createdAt.toISOString(),
      })),
      recentPayments: recentPayments.map((p) => {
        const payer = payerMap.get(p.userId)
        return {
          userId: p.userId,
          username: payer?.username ?? null,
          firstName: payer?.firstName ?? null,
          lastName: payer?.lastName ?? null,
          amountKop: p.amountKop,
          purpose: p.purpose,
          createdAt: p.createdAt.toISOString(),
        }
      }),
      total,
      page,
      pageSize: PAGE_SIZE,
    })
  } catch (e) {
    console.error('[panel/subscriptions]', e)
    return err('subscriptions failed', 500)
  }
}

function qLower(q: string): string {
  return q.toLowerCase()
}

/**
 * POST { userId | handle, tier: 'plus'|'pro', days, reason? } — быстрая выдача
 * подписки по ID или @username прямо со вкладки «Подписки» (без поиска в юзерах).
 */
export async function POST(request: Request) {
  const g = guardAdmin(request, { limit: 60, windowMs: 60_000, bucket: 'panel-subs-post' })
  if (!g.ok) return g.res

  try {
    const body = (await request.json()) as {
      userId?: unknown
      handle?: unknown
      tier?: unknown
      days?: unknown
      reason?: unknown
    }

    const tier = body.tier
    if (tier !== 'plus' && tier !== 'pro') return err("tier must be 'plus' | 'pro'")
    const days = typeof body.days === 'number' ? Math.round(body.days) : NaN
    if (!Number.isFinite(days) || days < 1 || days > 36_500) return err('days must be 1..36500')
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : undefined

    // адресат: userId или @username (tg_/guest_ — это ID, ищем напрямую)
    let userId = typeof body.userId === 'string' ? body.userId.trim().slice(0, 80) : ''
    if (!userId && typeof body.handle === 'string') {
      const handle = body.handle.trim().replace(/^@/, '')
      if (!handle) return err('userId or handle required')
      if (handle.startsWith('tg_') || handle.startsWith('guest_')) {
        const byId = await db.user.findUnique({ where: { id: handle }, select: { id: true } })
        if (!byId) return err(`пользователь ${handle.slice(0, 24)}… не найден`, 404)
        userId = byId.id
      } else {
        const found = await db.user.findFirst({
          where: { username: handle },
          select: { id: true },
        })
        if (!found) return err(`пользователь @${handle} не найден`, 404)
        userId = found.id
      }
    }
    if (!userId) return err('userId or handle required')

    const u = await db.user.findUnique({
      where: { id: userId },
      select: { tier: true, tierUntil: true },
    })
    if (!u) return err('user not found', 404)

    const now = Date.now()
    const wasActive = u.tierUntil && u.tierUntil.getTime() > now ? u.tierUntil.getTime() : 0
    const base = tier === u.tier && wasActive > 0 ? wasActive : now
    const until = new Date(base + days * DAY_MS)

    const updated = await db.user.update({
      where: { id: userId },
      data: { tier, tierUntil: until },
      select: { tier: true, tierUntil: true },
    })

    const { logAdmin } = await import('@/lib/admin-log')
    await logAdmin(wasActive > 0 && tier === u.tier ? 'tier_extend' : 'tier_grant', userId, {
      tier,
      days,
      until: until.toISOString(),
      ...(reason ? { reason } : {}),
    })

    return NextResponse.json({
      ok: true,
      userId,
      tier: updated.tier,
      tierUntil: updated.tierUntil ? updated.tierUntil.toISOString() : null,
    })
  } catch (e) {
    console.error('[panel/subscriptions POST]', e)
    return err('grant failed', 500)
  }
}
