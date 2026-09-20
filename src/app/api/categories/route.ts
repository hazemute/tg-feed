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
      // v5.52: TTL 120с → 300с — категории и «новое за сегодня» не требуют
      // точности до секунды, а холодная пересборка стоит 2 RTT до дальнего
      // Supabase; 5-минутная свежесть неощутима, экономия RTT огромная.
      ttlSec: 300,
      memoryTtlMs: 60_000,
      fetcher: async (): Promise<CategoryItem[]> => {
        // v5.52: счётчик «новых постов за сегодня» = GROUP BY по индексу
        // (publishedAt + канал), вместо выборки ВСЕХ постов дня в память
        // (раньше: findMany со строками channelId — сотни строк × egress).
        const startOfDay = new Date()
        startOfDay.setHours(0, 0, 0, 0)
        const [cats, todayRows] = await Promise.all([
          db.category.findMany({
            where: { slug: { not: 'other' } },
            orderBy: { order: 'asc' },
            include: { _count: { select: { channels: { where: { status: 'active' } } } } },
          }),
          db.post.groupBy({
            by: ['channelId'],
            where: { publishedAt: { gte: startOfDay }, channel: { status: 'active' } },
            _count: { _all: true },
          }),
        ])
        // channelId → категория одним лёгким запросом только по затронутым каналам
        const channelIds = todayRows.map((r) => r.channelId)
        const todayByCategory = new Map<string, number>()
        if (channelIds.length > 0) {
          const chans = await db.channel.findMany({
            where: { id: { in: channelIds } },
            select: { id: true, categoryId: true },
          })
          const catOf = new Map(chans.map((c) => [c.id, c.categoryId]))
          for (const r of todayRows) {
            const cid = catOf.get(r.channelId)
            if (cid) todayByCategory.set(cid, (todayByCategory.get(cid) ?? 0) + r._count._all)
          }
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
