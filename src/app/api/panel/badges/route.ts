import { NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'
import { logAdmin } from '@/lib/admin-log'
import { BADGES, BADGE_LIST, parseBadges, serializeBadges, type BadgeSlug } from '@/lib/badges'
import { emitAppEvent } from '@/lib/events'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 20

/**
 * GET /api/panel/badges?badge=&q=&page=1 — центр бейджей (v5.19):
 *  - counts: держателей по каждому виду бейджа;
 *  - items: держатели выбранного бейджа (или все с любым бейджем), поиск, пагинация;
 *  - recent: последние операции журнала (badge_grant/badge_revoke).
 * Доступ: x-admin-key.
 */
export async function GET(request: Request) {
  const g = guardAdmin(request, { limit: 120, windowMs: 60_000, bucket: 'panel-badges' })
  if (!g.ok) return g.res

  try {
    const url = new URL(request.url)
    const badgeParam = url.searchParams.get('badge') ?? ''
    const badge = badgeParam in BADGES ? (badgeParam as BadgeSlug) : null
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 64)
    const pageRaw = Number(url.searchParams.get('page') ?? '1')
    const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.min(500, Math.floor(pageRaw)) : 1

    // «badges» содержит конкретный слаг: LIKE %"slug"% — JSON-массив без пробелов
    const where: Prisma.UserWhereInput = badge
      ? { badges: { contains: `"${badge}"` } }
      : { NOT: { badges: { in: ['[]', ''] } } }
    if (q) {
      where.OR = [
        { id: { contains: q.toLowerCase() } },
        { username: { contains: q.toLowerCase() } },
        { firstName: { contains: q } },
      ]
    }

    const [counts, total, items, recent] = await Promise.all([
      // Счётчики по каждому слагу одним запросом-группировкой (быстрее N count'ов)
      db.user
        .groupBy({ by: ['badges'], _count: { _all: true }, where: { NOT: { badges: { in: ['[]', ''] } } } })
        .then((rows) => {
          const acc = Object.fromEntries(BADGE_LIST.map((b) => [b.slug, 0])) as Record<BadgeSlug, number>
          for (const row of rows) {
            for (const slug of parseBadges(row.badges)) acc[slug] += row._count._all
          }
          return acc
        }),
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
          badges: true,
          tier: true,
          tierUntil: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      db.adminLog.findMany({
        where: { action: { in: ['badge_grant', 'badge_revoke'] } },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { action: true, target: true, meta: true, createdAt: true },
      }),
    ])

    return NextResponse.json({
      counts,
      items: items.map((u) => ({
        id: u.id,
        username: u.username,
        firstName: u.firstName,
        lastName: u.lastName,
        isGuest: u.isGuest,
        isPremium: u.isPremium,
        badges: parseBadges(u.badges),
        tier: u.tier,
        tierUntil: u.tierUntil ? u.tierUntil.toISOString() : null,
        createdAt: u.createdAt.toISOString(),
      })),
      recent: recent.map((r) => {
        let meta: Record<string, unknown> | null = null
        try {
          meta = r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : null
        } catch {
          meta = null
        }
        return {
          action: r.action,
          target: r.target,
          badge: typeof meta?.badge === 'string' ? meta.badge : null,
          reason: typeof meta?.reason === 'string' ? meta.reason : null,
          createdAt: r.createdAt.toISOString(),
        }
      }),
      total,
      page,
      pageSize: PAGE_SIZE,
    })
  } catch (e) {
    console.error('[panel/badges]', e)
    return err('badges failed', 500)
  }
}

type Body = {
  userId?: unknown
  handle?: unknown
  badge?: unknown
  mode?: unknown
  reason?: unknown
  notify?: unknown
}

/**
 * POST { userId | handle, badge, mode: 'grant'|'revoke', reason?, notify? }
 * — быстрая выдача/снятие бейджа по ID или @username (как у подписок):
 * без поиска в списке, прямо из формы вкладки «Бейджи».
 * Выдача/снятие с notify=true (по умолчанию) кладёт системное уведомление в инбокс.
 */
export async function POST(request: Request) {
  const g = guardAdmin(request, { limit: 60, windowMs: 60_000, bucket: 'panel-badges-post' })
  if (!g.ok) return g.res

  try {
    const body = await readJson<Body>(request)

    const badge = typeof body.badge === 'string' ? body.badge : ''
    if (!(badge in BADGES)) return err('unknown badge')
    const mode = body.mode === 'revoke' ? 'revoke' : 'grant'
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : undefined
    const notify = body.notify !== false

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
      select: { badges: true },
    })
    if (!u) return err('user not found', 404)

    const current = parseBadges(u.badges)
    const has = current.includes(badge as BadgeSlug)

    if (mode === 'grant' && has) {
      return NextResponse.json({ ok: true, userId, badges: current, unchanged: true })
    }
    if (mode === 'revoke' && !has) {
      return NextResponse.json({ ok: true, userId, badges: current, unchanged: true })
    }

    const next =
      mode === 'grant'
        ? serializeBadges([...current, badge as BadgeSlug])
        : serializeBadges(current.filter((b) => b !== badge))

    const updated = await db.user.update({
      where: { id: userId },
      data: { badges: next },
      select: { badges: true },
    })

    await logAdmin(mode === 'grant' ? 'badge_grant' : 'badge_revoke', userId, {
      badge,
      handle: typeof body.handle === 'string' ? body.handle.replace(/^@/, '') : undefined,
      ...(reason ? { reason } : {}),
    })

    // Уведомление в инбокс (не критично для операции)
    if (notify) {
      const def = BADGES[badge as BadgeSlug]
      const title =
        mode === 'grant' ? `Вам выдан бейдж «${def.label}»` : `Бейдж «${def.label}» снят`
      const bodyText =
        mode === 'grant'
          ? (reason?.slice(0, 180) ?? 'Отмечен администрацией Tg Swipe — бейдж виден рядом с вашим именем.')
          : 'Если это ошибка — напишите в поддержку.'
      try {
        await db.notification.create({
          data: { userId, type: 'system', title, body: bodyText },
        })
        emitAppEvent('notif:new', { userId })
      } catch (e) {
        console.error('[panel/badges] notify failed', (e as Error).message)
      }
    }

    return NextResponse.json({ ok: true, userId, badges: parseBadges(updated.badges) })
  } catch (e) {
    console.error('[panel/badges POST]', e)
    return err('badge action failed', 500)
  }
}
