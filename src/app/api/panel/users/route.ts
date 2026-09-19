import { NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'
import { setMaintenanceAllowed, setBanned } from '@/lib/maintenance'
import { KOPECKS_PER_SWIPE } from '@/lib/money'
import { logAdmin } from '@/lib/admin-log'
import { type Tier } from '@/lib/tiers'
import { BADGES, parseBadges, serializeBadges } from '@/lib/badges'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 20
const MAX_DAYS = 36_500 // «100 лет» — практическое «навсегда»
const DAY_MS = 86_400_000

/**
 * GET /api/panel/users?q=&page=1&filter=all|tg|guests|banned|plus|pro|paid|expiring
 * — список пользователей со счётчиками, тирами и сроками подписок.
 * Доступ: x-admin-key. Лимит 120/мин/IP.
 */
export async function GET(request: Request) {
  const g = guardAdmin(request, { limit: 120, windowMs: 60_000, bucket: 'panel-users' })
  if (!g.ok) return g.res

  try {
    const url = new URL(request.url)
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 64)
    const pageRaw = Number(url.searchParams.get('page') ?? '1')
    const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.min(500, Math.floor(pageRaw)) : 1
    const filter = url.searchParams.get('filter') ?? 'all'

    const now = Date.now()
    const where: Prisma.UserWhereInput = {}
    if (q) {
      const qLower = q.toLowerCase()
      where.OR = [
        { id: { contains: qLower } },
        { username: { contains: qLower } },
        { firstName: { contains: qLower } },
        { firstName: { contains: q } },
      ]
    }
    // v5.18: фильтры по типу аккаунта, бану и подписке
    switch (filter) {
      case 'tg':
        where.isGuest = false
        break
      case 'guests':
        where.isGuest = true
        break
      case 'banned':
        where.bannedAt = { not: null }
        break
      case 'plus':
        where.tier = 'plus'
        where.OR = [{ tierUntil: { gt: new Date(now) } }, { tierUntil: null }]
        break
      case 'pro':
        where.tier = 'pro'
        where.OR = [{ tierUntil: { gt: new Date(now) } }, { tierUntil: null }]
        break
      case 'paid':
        where.tier = { in: ['plus', 'pro'] }
        where.OR = [{ tierUntil: { gt: new Date(now) } }, { tierUntil: null }]
        break
      case 'expiring':
        where.tier = { in: ['plus', 'pro'] }
        where.tierUntil = { gt: new Date(now), lte: new Date(now + 7 * DAY_MS) }
        break
      default:
        break
    }

    const [total, users] = await Promise.all([
      db.user.count({ where }),
      db.user.findMany({
        where,
        select: {
          id: true,
          username: true,
          firstName: true,
          lastName: true,
          isGuest: true,
          isPremium: true,
          bypassMaintenance: true,
          bannedAt: true,
          banReason: true,
          tier: true,
          tierUntil: true,
          badges: true,
          createdAt: true,
          advertiser: { select: { balanceKop: true } },
          _count: { select: { likes: true, subscriptions: true, bookmarks: true, views: true } },
        },
        orderBy:
          filter === 'expiring'
            ? { tierUntil: 'asc' }
            : { createdAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
    ])

    return NextResponse.json({
      items: users.map((u) => {
        const tier = u.tier === 'plus' || u.tier === 'pro' ? (u.tier as Tier) : 'free'
        const active = tier !== 'free' && (!u.tierUntil || u.tierUntil.getTime() > now)
        return {
          id: u.id,
          username: u.username,
          firstName: u.firstName,
          lastName: u.lastName,
          isGuest: u.isGuest,
          isPremium: u.isPremium,
          bypassMaintenance: u.bypassMaintenance,
          bannedAt: u.bannedAt ? u.bannedAt.toISOString() : null,
          banReason: u.banReason,
          tier: active ? tier : 'free',
          tierUntil: active && u.tierUntil ? u.tierUntil.toISOString() : null,
          badges: parseBadges(u.badges),
          swipes: u.advertiser ? Math.floor(u.advertiser.balanceKop / KOPECKS_PER_SWIPE) : 0,
          createdAt: u.createdAt.toISOString(),
          likes: u._count.likes,
          subscriptions: u._count.subscriptions,
          bookmarks: u._count.bookmarks,
          views: u._count.views,
        }
      }),
      total,
      page,
      pageSize: PAGE_SIZE,
    })
  } catch (e) {
    console.error('[panel/users]', e)
    return err('users failed', 500)
  }
}

/**
 * PATCH { userId, … } — действия над пользователем. v5.18: выдача/отзыв
 * подписки (tier) на произвольный срок + аудит всех операций в AdminLog.
 *
 *  { action:'tier', tier:'plus'|'pro', days: N, mode:'grant'|'revoke', reason? }
 *    grant — выдать/продлить: срок суммируется от действующего tierUntil
 *            (или от «сейчас»); days 1..36500 (36500 = практическое «навсегда»).
 *    revoke — отозвать: tier='free', tierUntil=null.
 */
export async function PATCH(request: Request) {
  const g = guardAdmin(request, { limit: 60, windowMs: 60_000, bucket: 'panel-users-post' })
  if (!g.ok) return g.res

  try {
    const body = await readJson<{
      userId?: unknown
      bypassMaintenance?: unknown
      action?: unknown
      swipes?: unknown
      reason?: unknown
      tier?: unknown
      days?: unknown
      mode?: unknown
      badge?: unknown
    }>(request)
    const userId = typeof body.userId === 'string' ? body.userId.trim().slice(0, 80) : ''
    if (!userId) return err('userId required')

    // Прежнее действие: допуск мимо техработ
    if (body.bypassMaintenance !== undefined) {
      const bypass = body.bypassMaintenance === true
      await setMaintenanceAllowed(userId, bypass)
      await logAdmin(bypass ? 'bypass_on' : 'bypass_off', userId)
      return NextResponse.json({ ok: true, userId, bypassMaintenance: bypass })
    }

    // v5.11: действия модерации
    const action = typeof body.action === 'string' ? body.action : ''
    if (action === 'ban' || action === 'unban') {
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : undefined
      await setBanned(userId, action === 'ban', reason)
      await logAdmin(action, userId, reason ? { reason } : undefined)
      return NextResponse.json({ ok: true, userId, banned: action === 'ban' })
    }
    if (action === 'swipes') {
      const swipes = typeof body.swipes === 'number' ? Math.round(body.swipes) : NaN
      if (!Number.isFinite(swipes) || swipes < 0 || swipes > 10_000_000) {
        return err('swipes must be 0..10000000')
      }
      const balanceKop = swipes * KOPECKS_PER_SWIPE
      // topupsTotalKop ≥ баланс: админ-грант считается «пополнением» — иначе
      // стерилизация (purge_demo, удаляет балансы без единого пополнения)
      // вычистила бы выданный панелью баланс при следующем деплое.
      const existing = await db.advertiserAccount.findUnique({
        where: { userId },
        select: { topupsTotalKop: true },
      })
      await db.advertiserAccount.upsert({
        where: { userId },
        create: { userId, balanceKop, topupsTotalKop: balanceKop },
        update: {
          balanceKop,
          topupsTotalKop: Math.max(existing?.topupsTotalKop ?? 0, balanceKop),
        },
      })
      await logAdmin('swipes', userId, { swipes })
      return NextResponse.json({ ok: true, userId, swipes })
    }
    if (action === 'premium') {
      const u = await db.user.findUnique({ where: { id: userId }, select: { isPremium: true } })
      if (!u) return err('user not found', 404)
      const next = !u.isPremium
      await db.user.update({ where: { id: userId }, data: { isPremium: next } })
      await logAdmin(next ? 'premium_on' : 'premium_off', userId)
      return NextResponse.json({ ok: true, userId, isPremium: next })
    }

    // === v5.19: бейджи — выдача/снятие одного слага (модалка юзера) ===
    if (action === 'badge') {
      const mode = body.mode === 'revoke' ? 'revoke' : 'grant'
      const badge = typeof body.badge === 'string' ? body.badge : ''
      if (!(badge in BADGES)) return err('unknown badge')
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : undefined

      const u = await db.user.findUnique({
        where: { id: userId },
        select: { badges: true },
      })
      if (!u) return err('user not found', 404)

      const current = parseBadges(u.badges)
      const has = current.includes(badge as keyof typeof BADGES)
      let next: string
      if (mode === 'grant') {
        if (has) return NextResponse.json({ ok: true, userId, badges: current, unchanged: true })
        next = serializeBadges([...current, badge as keyof typeof BADGES])
      } else {
        if (!has) return NextResponse.json({ ok: true, userId, badges: current, unchanged: true })
        next = serializeBadges(current.filter((b) => b !== badge))
      }

      await db.user.update({ where: { id: userId }, data: { badges: next } })
      await logAdmin(mode === 'grant' ? 'badge_grant' : 'badge_revoke', userId, {
        badge,
        ...(reason ? { reason } : {}),
      })

      // Уведомление в инбокс (не критично для операции)
      try {
        const def = BADGES[badge as keyof typeof BADGES]
        await db.notification.create({
          data: {
            userId,
            type: 'system',
            title:
              mode === 'grant'
                ? `Вам выдан бейдж «${def.label}»`
                : `Бейдж «${def.label}» снят`,
            body:
              mode === 'grant'
                ? (reason?.slice(0, 180) ?? 'Отмечен администрацией Tg Swipe — бейдж виден рядом с вашим именем.')
                : 'Если это ошибка — напишите в поддержку.',
          },
        })
      } catch (ne) {
        console.error('[panel/users badge] notify failed', (ne as Error).message)
      }

      return NextResponse.json({ ok: true, userId, badges: parseBadges(next) })
    }

    // === v5.18: управление подпиской (Snap Plus / Snap Pro) ===
    if (action === 'tier') {
      const mode = body.mode === 'revoke' ? 'revoke' : 'grant'

      if (mode === 'revoke') {
        const u = await db.user.findUnique({
          where: { id: userId },
          select: { tier: true, tierUntil: true },
        })
        if (!u) return err('user not found', 404)
        const had = (u.tier === 'plus' || u.tier === 'pro') && (!u.tierUntil || u.tierUntil.getTime() > Date.now())
        await db.user.update({
          where: { id: userId },
          data: { tier: 'free', tierUntil: null },
        })
        await logAdmin('tier_revoke', userId, { tier: u.tier, had: had ? u.tierUntil?.toISOString() : null })
        return NextResponse.json({ ok: true, userId, tier: 'free', tierUntil: null })
      }

      // Выдача/продление
      const tier = body.tier
      if (tier !== 'plus' && tier !== 'pro') return err("tier must be 'plus' | 'pro'")
      const days = typeof body.days === 'number' ? Math.round(body.days) : NaN
      if (!Number.isFinite(days) || days < 1 || days > MAX_DAYS) {
        return err(`days must be 1..${MAX_DAYS}`)
      }
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : undefined
      const rank: Record<Tier, number> = { free: 0, plus: 1, pro: 2 }
      if (rank[tier] === undefined) return err('bad tier')

      const u = await db.user.findUnique({
        where: { id: userId },
        select: { tier: true, tierUntil: true },
      })
      if (!u) return err('user not found', 404)

      const now = Date.now()
      const currentActive =
        u.tierUntil && u.tierUntil.getTime() > now ? u.tierUntil.getTime() : now
      const base = tier === u.tier && currentActive > now ? currentActive : now
      const untilMs = base + days * DAY_MS

      const updated = await db.user.update({
        where: { id: userId },
        data: { tier, tierUntil: new Date(untilMs) },
        select: { tier: true, tierUntil: true },
      })

      const extended = tier === u.tier && currentActive > now && base !== now
      await logAdmin(extended ? 'tier_extend' : 'tier_grant', userId, {
        tier,
        days,
        until: new Date(untilMs).toISOString(),
        ...(reason ? { reason } : {}),
      })
      return NextResponse.json({
        ok: true,
        userId,
        tier: updated.tier,
        tierUntil: updated.tierUntil ? updated.tierUntil.toISOString() : null,
      })
    }

    return err('unknown action')
  } catch (e) {
    console.error('[panel/users PATCH]', e)
    return err('user update failed', 500)
  }
}
