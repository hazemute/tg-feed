import { NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'
import { setMaintenanceAllowed } from '@/lib/maintenance'

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
          createdAt: true,
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
    const body = await readJson<{ userId?: unknown; bypassMaintenance?: unknown }>(request)
    const userId = typeof body.userId === 'string' ? body.userId.trim().slice(0, 80) : ''
    if (!userId) return err('userId required')
    const bypass = body.bypassMaintenance === true
    await setMaintenanceAllowed(userId, bypass)
    return NextResponse.json({ ok: true, userId, bypassMaintenance: bypass })
  } catch (e) {
    console.error('[panel/users PATCH]', e)
    return err('user update failed', 500)
  }
}
