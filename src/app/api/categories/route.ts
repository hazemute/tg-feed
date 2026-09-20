import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { guardPublic } from '@/lib/guard'
import { cacheAside, famKey } from '@/lib/redis'

export const dynamic = 'force-dynamic'

type CategoryItem = {
  id: string
  slug: string
  title: string
  emoji: string | null
  channelCount: number
  todayCount: number
}

/**
 * GET /api/categories
 * Категории без служебной «other» + счётчик «новых постов за сегодня».
 * Полностью публичные данные (персонализации нет) — целиком в Redis на 120с.
 * CDN (11-a): ответ одинаковый для всех — Vercel edge кэширует на 60с.
 * Лимит 120 запросов в минуту.
 */
const CDN_CACHE = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300'

export async function GET(request: Request) {
  const g = guardPublic(request, { limit: 120, windowMs: 60_000, bucket: 'categories' })
  if (!g.ok) return g.res

  try {
    const items = await cacheAside({
      key: await famKey('ct', 'all'),
      ttlSec: 120,
      memoryTtlMs: 15000,
      fetcher: async (): Promise<CategoryItem[]> => {
        const cats = await db.category.findMany({
          where: { slug: { not: 'other' } },
          orderBy: { order: 'asc' },
          include: { _count: { select: { channels: { where: { status: 'active' } } } } },
        })

        const startOfDay = new Date()
        startOfDay.setHours(0, 0, 0, 0)

        const todayPosts = await db.post.findMany({
          where: { publishedAt: { gte: startOfDay }, channel: { status: 'active' } },
          select: { channel: { select: { categoryId: true } } },
        })

        const todayByCategory = new Map<string, number>()
        for (const p of todayPosts) {
          const cid = p.channel.categoryId
          todayByCategory.set(cid, (todayByCategory.get(cid) ?? 0) + 1)
        }

        return cats.map((c) => ({
          id: c.id,
          slug: c.slug,
          title: c.title,
          emoji: c.emoji,
          channelCount: c._count.channels,
          todayCount: todayByCategory.get(c.id) ?? 0,
        }))
      },
    })

    return NextResponse.json({ items }, { headers: { 'Cache-Control': CDN_CACHE } })
  } catch (e) {
    console.error('[categories]', e)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
