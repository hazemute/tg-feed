import { NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 30

/**
 * GET /api/panel/audit?group=all|tier|moderation|users&page=1
 * — журнал действий администратора (AdminLog): выдача/отзыв подписок, баны,
 * правки балансов, быстрые операции. Доступ: x-admin-key.
 */
export async function GET(request: Request) {
  const g = guardAdmin(request, { limit: 120, windowMs: 60_000, bucket: 'panel-audit' })
  if (!g.ok) return g.res

  try {
    const url = new URL(request.url)
    const pageRaw = Number(url.searchParams.get('page') ?? '1')
    const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.min(500, Math.floor(pageRaw)) : 1
    const group = url.searchParams.get('group') ?? 'all'

    const where: Prisma.AdminLogWhereInput = {}
    if (group === 'tier') where.action = { in: ['tier_grant', 'tier_extend', 'tier_revoke'] }
    else if (group === 'moderation') where.action = { in: ['moderation', 'campaign', 'comment'] }
    else if (group === 'users') {
      where.action = {
        in: ['ban', 'unban', 'swipes', 'premium_on', 'premium_off', 'bypass_on', 'bypass_off'],
      }
    }

    const [total, items, byAction] = await Promise.all([
      db.adminLog.count({ where }),
      db.adminLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      db.adminLog.groupBy({ by: ['action'], _count: { _all: true } }),
    ])

    return NextResponse.json({
      items: items.map((l) => {
        let meta: Record<string, unknown> | null = null
        if (l.meta) {
          try {
            const parsed = JSON.parse(l.meta) as unknown
            if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>
          } catch {
            /* битый JSON не ломает журнал */
          }
        }
        return {
          id: l.id,
          action: l.action,
          target: l.target,
          meta,
          createdAt: l.createdAt.toISOString(),
        }
      }),
      total,
      page,
      pageSize: PAGE_SIZE,
      byAction: Object.fromEntries(byAction.map((s) => [s.action, s._count._all])),
    })
  } catch (e) {
    console.error('[panel/audit]', e)
    return err('audit failed', 500)
  }
}
