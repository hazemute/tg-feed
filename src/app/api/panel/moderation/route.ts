import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'
import { bumpCache } from '@/lib/redis'

export const dynamic = 'force-dynamic'

/**
 * GET /api/panel/moderation — очередь каналов со status='moderation'.
 * Доступ: x-admin-key. Лимит 120/мин/IP.
 */
export async function GET(request: Request) {
  const g = guardAdmin(request, { limit: 120, windowMs: 60_000, bucket: 'panel-mod' })
  if (!g.ok) return g.res

  try {
    const channels = await db.channel.findMany({
      where: { status: 'moderation' },
      include: { category: { select: { title: true } }, _count: { select: { posts: true } } },
      orderBy: { createdAt: 'asc' },
      take: 50,
    })

    return NextResponse.json({
      items: channels.map((c) => ({
        id: c.id,
        title: c.title,
        username: c.username,
        description: c.description,
        avatarColor: c.avatarColor,
        categoryTitle: c.category?.title ?? null,
        postsCount: c._count.posts,
        createdAt: c.createdAt.toISOString(),
      })),
    })
  } catch (e) {
    console.error('[panel/moderation GET]', e)
    return err('moderation failed', 500)
  }
}

const postSchema = z.object({
  channelId: z.string().min(1).max(64),
  action: z.enum(['approve', 'reject']),
})

/**
 * POST /api/panel/moderation { channelId, action: 'approve' | 'reject' }
 * Одобрить (status → active) или отклонить (status → rejected) канал.
 * Лимит 60/мин/IP.
 */
export async function POST(request: Request) {
  const g = guardAdmin(request, { limit: 60, windowMs: 60_000, bucket: 'panel-mod-post' })
  if (!g.ok) return g.res

  try {
    const parsed = postSchema.safeParse(await readJson(request))
    if (!parsed.success) return err('channelId and action (approve|reject) required')
    const { channelId, action } = parsed.data

    const channel = await db.channel.update({
      where: { id: channelId },
      data: { status: action === 'approve' ? 'active' : 'rejected' },
      select: { id: true, title: true, status: true },
    })

    // Инвалидация кэша: состав активных каналов изменился
    await bumpCache(['feed', 'tr', 'ct', 'ch', 'sr'])

    return NextResponse.json({ ok: true, channel })
  } catch (e) {
    console.error('[panel/moderation POST]', e)
    return err('channel not found', 404)
  }
}
