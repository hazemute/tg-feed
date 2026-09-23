import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { tierAtLeast, tierOfUser } from '@/lib/tiers'

export const dynamic = 'force-dynamic'

/**
 * v6.1: PRO ANALYTICS — расширенная аналитика канала для владельца.
 * Доступ: только Snap Pro (драйвер подписки: фрижу ценность, продаём тир).
 *
 * GET /api/mychannel/analytics?channelId=…&days=14|30|90
 * → {
 *   totals: { views, likes, comments, bookmarks, members, avgDwellSec, subscribedNow },
 *   series: [{ date, views, likes, subs }],
 *   topPosts: [{ id, title, views, likes, publishedAt }],
 * }
 *
 * Агрегация в JS поверх findMany (не raw SQL) — единый код для Postgres (прод)
 * и SQLite (локальная песочница); объёмы канала (десятки тысяч сигналов) малы
 * для 90 дней, лимиты take страхуют от аномалий.
 */

const querySchema = z.object({
  channelId: z.string().min(1),
  days: z.coerce.number().int().refine((d) => [7, 14, 30, 90].includes(d)).catch(14),
})

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 30, windowMs: 60_000, bucket: 'analytics' })
  if (!g.ok) return g.res
  if (!g.uid) return err('Сессия не найдена', 401)

  try {
    const { searchParams } = new URL(request.url)
    const q = querySchema.safeParse(Object.fromEntries(searchParams))
    if (!q.success) return err('Некорректные параметры', 400)
    const { channelId, days } = q.data

    // Pro-гейт (учитывает срок подписки)
    const tier = await tierOfUser(g.uid)
    if (!tierAtLeast(tier, 'pro')) {
      return NextResponse.json(
        { error: 'pro_required', message: 'Pro Analytics доступна на тарифе Snap Pro' },
        { status: 402 },
      )
    }

    const channel = await db.channel.findUnique({
      where: { id: channelId },
      select: { id: true, claimedById: true, subscribersCount: true, membersCount: true },
    })
    if (!channel || channel.claimedById !== g.uid) return err('Канал не найден среди ваших', 404)

    const since = new Date(Date.now() - days * 86_400_000)

    // Все сигналы канала одним батчем на сущность (дальше — агрегация в памяти)
    const posts = await db.post.findMany({
      where: { channelId, publishedAt: { gte: since } },
      select: { id: true, text: true, viewsCount: true, likesCount: true, commentsCount: true, publishedAt: true },
      orderBy: { publishedAt: 'desc' },
      take: 500,
    })
    const postIds = posts.map((p) => p.id)

    const [views, likes, bookmarks, comments, subs] = await Promise.all([
      postIds.length
        ? db.postView.findMany({
            where: { postId: { in: postIds }, createdAt: { gte: since } },
            select: { postId: true, createdAt: true, dwellMs: true },
            take: 20_000,
          })
        : Promise.resolve([]),
      postIds.length
        ? db.like.findMany({
            where: { postId: { in: postIds }, createdAt: { gte: since } },
            select: { postId: true, createdAt: true },
            take: 10_000,
          })
        : Promise.resolve([]),
      postIds.length
        ? db.bookmark.findMany({
            where: { postId: { in: postIds }, createdAt: { gte: since } },
            select: { postId: true, createdAt: true },
            take: 10_000,
          })
        : Promise.resolve([]),
      postIds.length
        ? db.comment.findMany({
            where: { postId: { in: postIds }, createdAt: { gte: since }, hidden: false },
            select: { postId: true, createdAt: true },
            take: 10_000,
          })
        : Promise.resolve([]),
      db.subscription.findMany({
        where: { channelId, createdAt: { gte: since } },
        select: { createdAt: true },
        take: 10_000,
      }),
    ])

    // Каркас серии по дням
    const seriesMap = new Map<string, { views: number; likes: number; subs: number }>()
    for (let i = days - 1; i >= 0; i--) {
      const d = dayKey(new Date(Date.now() - i * 86_400_000))
      seriesMap.set(d, { views: 0, likes: 0, subs: 0 })
    }
    for (const v of views) {
      const k = dayKey(v.createdAt)
      const row = seriesMap.get(k)
      if (row) row.views++
    }
    for (const l of likes) {
      const k = dayKey(l.createdAt)
      const row = seriesMap.get(k)
      if (row) row.likes++
    }
    for (const s of subs) {
      const k = dayKey(s.createdAt)
      const row = seriesMap.get(k)
      if (row) row.subs++
    }

    // Посты с ИИ-просмотрами по postId (viewsCount уже денормализован) — dwell средний
    const dwellSum = views.reduce((s, v) => s + (v.dwellMs ?? 0), 0)
    const avgDwellSec = views.length > 0 ? Math.round(dwellSum / views.length / 1000) : 0

    // Топ постов: по фактическим просмотрам в окне (по журналам), фолбэк — viewsCount
    const viewsByPost = new Map<string, number>()
    for (const v of views) viewsByPost.set(v.postId, (viewsByPost.get(v.postId) ?? 0) + 1)
    const topPosts = [...posts]
      .map((p) => ({
        id: p.id,
        title: p.text.slice(0, 80) || (p.text ? '' : 'Без текста'),
        views: Math.max(viewsByPost.get(p.id) ?? 0, p.viewsCount),
        likes: p.likesCount,
        publishedAt: p.publishedAt,
      }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 5)

    const membersNow = await db.channelMembership.count({
      where: { channelId, until: { gt: new Date() } },
    })

    return NextResponse.json({
      ok: true,
      totals: {
        views: views.length,
        likes: likes.length,
        comments: comments.length,
        bookmarks: bookmarks.length,
        members: membersNow,
        avgDwellSec,
        subscribedNow: channel.membersCount ?? channel.subscribersCount,
      },
      series: [...seriesMap.entries()].map(([date, v]) => ({ date, ...v })),
      topPosts,
    })
  } catch (e) {
    console.error('[analytics]', e)
    return err('Ошибка аналитики', 500)
  }
}
