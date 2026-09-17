import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { guardAuth } from '@/lib/guard'
import type { AdminStatsDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/stats
 * Дашборд админа: просмотры в ленте, клики по [+], CTR по каждому каналу.
 * userId берётся из Bearer-сессии (query-параметр игнорируется); 30 запросов в минуту.
 */
export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 30, windowMs: 60_000, bucket: 'adm-stats' })
  if (!g.ok) return g.res
  const userId = g.uid

  try {
    const channels = await db.channel.findMany({
      where: { addedById: userId },
      include: { posts: { select: { viewsCount: true } } },
      orderBy: { createdAt: 'desc' },
    })

    const items: AdminStatsDTO[] = channels.map((c) => {
      const views = c.posts.reduce((s, p) => s + p.viewsCount, 0)
      const clicks = c.clicksCount
      const ctr = views > 0 ? Math.round((clicks / views) * 1000) / 10 : 0
      return {
        channelId: c.id,
        title: c.title,
        username: c.username,
        avatarColor: c.avatarColor,
        avatarUrl: c.photoFileId ? `/api/avatar/c_${c.id}` : null,
        status: c.status,
        isPremium: c.isPremium,
        posts: c.posts.length,
        views,
        clicks,
        ctr,
      }
    })

    return NextResponse.json({ items })
  } catch (e) {
    console.error('[admin/stats]', e)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
