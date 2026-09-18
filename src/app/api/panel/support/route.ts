import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * GET /api/panel/support — список нитей поддержки (для админ-панели).
 * Возвращает активные нити (ai | human) + недавно закрытые, по свежести.
 * ?unseen=1 — только с непрочитанными от пользователя.
 */
export async function GET(request: Request) {
  const g = guardAdmin(request, { limit: 240, windowMs: 60_000, bucket: 'panel-support' })
  if (!g.ok) return g.res

  try {
    const { searchParams } = new URL(request.url)
    const unseenOnly = searchParams.get('unseen') === '1'
    // v5.11: kind=feedback — только предложки; kind=support — только поддержка; иначе все
    const kindFilter = searchParams.get('kind')

    const baseWhere: Record<string, unknown> = unseenOnly
      ? { unreadAdmin: { gt: 0 } }
      : { OR: [{ status: { not: 'closed' } }, { lastMessageAt: { gte: new Date(Date.now() - 3 * 86_400_000) } }] }
    if (kindFilter === 'feedback' || kindFilter === 'support') {
      baseWhere.kind = kindFilter
    }

    const threads = await db.supportThread.findMany({
      where: baseWhere,
      orderBy: { lastMessageAt: 'desc' },
      take: 100,
      include: {
        user: { select: { id: true, username: true, firstName: true, lastName: true, isGuest: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    })

    const items = threads.map((t) => ({
      id: t.id,
      status: t.status,
      kind: t.kind,
      topic: t.topic,
      unreadAdmin: t.unreadAdmin,
      unreadUser: t.unreadUser,
      lastMessageAt: t.lastMessageAt.toISOString(),
      createdAt: t.createdAt.toISOString(),
      user: t.user,
      lastMessage: t.messages[0]
        ? { sender: t.messages[0].sender, text: t.messages[0].text, createdAt: t.messages[0].createdAt.toISOString() }
        : null,
    }))

    return NextResponse.json({ items })
  } catch (e) {
    console.error('[panel/support GET]', e)
    return err('panel support failed', 500)
  }
}
