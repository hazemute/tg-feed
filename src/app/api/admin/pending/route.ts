import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/pending
 * Каналы, ожидающие модерации (для кабинета админа).
 * v5.48: guardAdmin вместо guardAuth — очередь модерации не для юзеров.
 */
export async function GET(request: Request) {
  const g = guardAdmin(request, { limit: 30, windowMs: 60_000, bucket: 'adm-pending' })
  if (!g.ok) return g.res

  try {
    const channels = await db.channel.findMany({
      where: { status: 'moderation' },
      include: { category: true, _count: { select: { posts: true } } },
      orderBy: { createdAt: 'desc' },
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
    console.error('[admin/pending]', e)
    return err('pending failed', 500)
  }
}
