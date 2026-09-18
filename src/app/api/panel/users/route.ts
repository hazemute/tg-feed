import { NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'
import { setMaintenanceAllowed, setBanned } from '@/lib/maintenance'
import { KOPECKS_PER_SWIPE } from '@/lib/money'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 20

/**
 * GET /api/panel/users?q=&page=1 — список пользователей со счётчиками
 * (лайки/подписки/закладки/просмотры). Read-only. Доступ: x-admin-key.
 * Лимит 120/мин/IP.
 */
export async function GET(request: Request) {
  const g = guardAdmin(request, { limit: 120, windowMs: 60_000, bucket: 'panel-users' })
  if (!g.ok) return g.res

  try {
    const url = new URL(request.url)
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 64)
    const pageRaw = Number(url.searchParams.get('page') ?? '1')
    const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.min(500, Math.floor(pageRaw)) : 1

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
          createdAt: true,
          advertiser: { select: { balanceKop: true } },
          _count: { select: { likes: true, subscriptions: true, bookmarks: true, views: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
    ])

    return NextResponse.json({
      items: users.map((u) => ({
        id: u.id,
        username: u.username,
        firstName: u.firstName,
        lastName: u.lastName,
        isGuest: u.isGuest,
        isPremium: u.isPremium,
        bypassMaintenance: u.bypassMaintenance,
        bannedAt: u.bannedAt ? u.bannedAt.toISOString() : null,
        banReason: u.banReason,
        swipes: u.advertiser ? Math.floor(u.advertiser.balanceKop / KOPECKS_PER_SWIPE) : 0,
        createdAt: u.createdAt.toISOString(),
        likes: u._count.likes,
        subscriptions: u._count.subscriptions,
        bookmarks: u._count.bookmarks,
        views: u._count.views,
      })),
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
 * PATCH { userId, bypassMaintenance } — переключить допуск пользователя
 * мимо техработ. Синхронно обновляет БД и Redis-множество для middleware.
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
    }>(request)
    const userId = typeof body.userId === 'string' ? body.userId.trim().slice(0, 80) : ''
    if (!userId) return err('userId required')

    // Прежнее действие: допуск мимо техработ
    if (body.bypassMaintenance !== undefined) {
      const bypass = body.bypassMaintenance === true
      await setMaintenanceAllowed(userId, bypass)
      return NextResponse.json({ ok: true, userId, bypassMaintenance: bypass })
    }

    // v5.11: действия модерации
    const action = typeof body.action === 'string' ? body.action : ''
    if (action === 'ban' || action === 'unban') {
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : undefined
      await setBanned(userId, action === 'ban', reason)
      return NextResponse.json({ ok: true, userId, banned: action === 'ban' })
    }
    if (action === 'swipes') {
      const swipes = typeof body.swipes === 'number' ? Math.round(body.swipes) : NaN
      if (!Number.isFinite(swipes) || swipes < 0 || swipes > 10_000_000) {
        return err('swipes must be 0..10000000')
      }
      const balanceKop = swipes * KOPECKS_PER_SWIPE
      await db.advertiserAccount.upsert({
        where: { userId },
        create: { userId, balanceKop },
        update: { balanceKop },
      })
      return NextResponse.json({ ok: true, userId, swipes })
    }
    if (action === 'premium') {
      const u = await db.user.findUnique({ where: { id: userId }, select: { isPremium: true } })
      if (!u) return err('user not found', 404)
      const next = !u.isPremium
      await db.user.update({ where: { id: userId }, data: { isPremium: next } })
      return NextResponse.json({ ok: true, userId, isPremium: next })
    }

    return err('unknown action')
  } catch (e) {
    console.error('[panel/users PATCH]', e)
    return err('user update failed', 500)
  }
}
