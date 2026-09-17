import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { toPostDTO } from '@/lib/dto'
import { guardPublic } from '@/lib/guard'
import { cacheAside, famKey, shortHash } from '@/lib/redis'
import type { PostDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

// Публичный поиск; сессия опциональна — от неё зависят только лайк/закладка.
const querySchema = z.object({
  q: z.string().trim().max(100).catch(''),
})

/**
 * GET /api/search?q=...
 * Поиск по ключевым словам ВНУТРИ ПОСТОВ (не по названиям каналов).
 * Регистронезависимый, включая кириллицу (фильтрация на стороне JS).
 * Без сессии — анонимный поиск: liked/bookmarked = false.
 *
 * Redis-оптимизация: это самый тяжёлый роут (скан 500 свежих постов на запрос),
 * поэтому результаты поиска (глобальная часть) кэшируются по нормализованному
 * запросу на 90с; персональные флаги накладываются после кэша.
 */
export async function GET(request: Request) {
  const g = guardPublic(request, { limit: 60, windowMs: 60_000, bucket: 'search' })
  if (!g.ok) return g.res
  const userId = g.uid // string | null

  try {
    const { searchParams } = new URL(request.url)
    const parsed = querySchema.safeParse(Object.fromEntries(searchParams))
    const q = parsed.success ? parsed.data.q : ''

    if (q.length < 2) return NextResponse.json({ items: [], query: q })

    const needle = q.toLowerCase()

    const items = await cacheAside({
      key: await famKey('sr', shortHash(needle)),
      ttlSec: 90,
      memoryTtlMs: 8000,
      fetcher: async (): Promise<PostDTO[]> => {
        const posts = await db.post.findMany({
          where: { channel: { status: 'active' } },
          include: { channel: { include: { category: true } } },
          orderBy: { publishedAt: 'desc' },
          take: 500,
        })
        return posts
          .filter((p) => p.text.toLowerCase().includes(needle))
          .slice(0, 30)
          .map((p) => toPostDTO(p, { liked: false, bookmarked: false, subscribed: false }))
      },
    })

    // Персонализация поверх кэша
    let result = items
    if (userId && items.length > 0) {
      const ids = items.map((p) => p.id)
      const [likes, bookmarks] = await Promise.all([
        db.like.findMany({ where: { userId, postId: { in: ids } }, select: { postId: true } }),
        db.bookmark.findMany({ where: { userId, postId: { in: ids } }, select: { postId: true } }),
      ])
      const likeSet = new Set(likes.map((l) => l.postId))
      const bookmarkSet = new Set(bookmarks.map((b) => b.postId))
      result = items.map((p) => ({
        ...p,
        liked: likeSet.has(p.id),
        bookmarked: bookmarkSet.has(p.id),
      }))
    }

    return NextResponse.json({ items: result, query: q })
  } catch (e) {
    console.error('[search]', e)
    return NextResponse.json({ error: 'search failed' }, { status: 500 })
  }
}
