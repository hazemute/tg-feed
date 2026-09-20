import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { guardPublic } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * GET /api/hashtags/trending — топ-8 хэштегов «Сейчас обсуждают».
 *
 * Источники:
 *  1) клики пользователей за последние 72 часа (HashtagClick);
 *  2) если кликов пока мало (<3) — добираем частотными хэштегами из текстов
 *     последних 150 постов, чтобы блок не был пустым на старте.
 * Публичный (персонализации нет), лимит 60/мин на юзера/IP.
 *
 * CDN (11-a): ответ ОДИНАКОВЫЙ для всех (без сессии/куков) — Vercel edge
 * кэширует его на 60с, бёрст поллинга не доходит до функции и БД.
 */
const CDN_CACHE = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300'

export async function GET(request: Request) {
  const g = guardPublic(request, { limit: 60, windowMs: 60_000, bucket: 'trending' })
  if (!g.ok) return g.res

  try {
    const since = new Date(Date.now() - 72 * 60 * 60 * 1000)
    const grouped = await db.hashtagClick.groupBy({
      by: ['tag'],
      where: { createdAt: { gte: since } },
      _count: { tag: true },
      orderBy: { _count: { tag: 'desc' } },
      take: 8,
    })

    let items = grouped.map((r) => ({ tag: r.tag, clicks: r._count.tag }))

    if (items.length < 3) {
      // Фолбэк: частотные хэштеги из свежих постов
      const posts = await db.post.findMany({
        orderBy: { publishedAt: 'desc' },
        take: 150,
        select: { text: true },
      })
      const counts = new Map<string, number>()
      const re = /#([\wа-яё]{2,30})/gi
      for (const p of posts) {
        const tags = p.text.match(re) ?? []
        for (const t of tags) {
          const tag = t.slice(1).toLowerCase()
          counts.set(tag, (counts.get(tag) ?? 0) + 1)
        }
      }
      const fromPosts = [...counts.entries()]
        .map(([tag, n]) => ({ tag, clicks: n }))
        .sort((a, b) => b.clicks - a.clicks)
        .slice(0, 8)

      // Объединяем: клики приоритетнее, фолбэк добирает до 8
      const seen = new Set(items.map((i) => i.tag))
      for (const f of fromPosts) {
        if (items.length >= 8) break
        if (!seen.has(f.tag)) items.push(f)
      }
    }

    return NextResponse.json({ items }, { headers: { 'Cache-Control': CDN_CACHE } })
  } catch (e) {
    console.error('[hashtags/trending]', e)
    return NextResponse.json({ items: [] })
  }
}
