import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { POST_LIST_SELECT, postDTOFromRow } from '@/lib/dto'
import { guardPublic } from '@/lib/guard'
import { cacheAside, famKey, shortHash } from '@/lib/redis'
import { isNsfwText, getNsfwChannelIds } from '@/lib/moderation'
import { IS_SQLITE } from '@/lib/server'
import type { PostDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

/** insensitive-фрагмент contains, совместимый и с Postgres, и с SQLite (см. lib/moderation.ts) */
function ci(value: string): Record<string, unknown> {
  return IS_SQLITE ? { contains: value } : { contains: value, mode: 'insensitive' as const }
}

// Публичный поиск; сессия опциональна — от неё зависят только лайк/закладка.
const querySchema = z.object({
  q: z.string().trim().max(100).catch(''),
})

/**
 * GET /api/search?q=...
 * Поиск по ключевым словам ВНУТРИ ПОСТОВ (не по названиям каналов).
 * Регистронезависимый: фильтр ILIKE на стороне Postgres — покрывает ВСЮ
 * историю постов (раньше сканировались только 500 свежайших, остальное
 * было «не найдено»), а тяжёлый JOIN с include не убивает latency:
 * строки фильтруются ДО склейки с каналами.
 *
 * Redis-оптимизация: результаты поиска (глобальная часть) кэшируются по
 * нормализованному запросу на 90с; персональные флаги накладываются после кэша.
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
      memoryTtlMs: 30_000,
      fetcher: async (): Promise<PostDTO[]> => {
        const posts = await db.post.findMany({
          where: {
            text: ci(needle),
            channel: { status: 'active', id: { notIn: await getNsfwChannelIds() } },
          },
          // POST_LIST_SELECT (egress): ttsAudio/translations в выдачу поиска не идут
          select: POST_LIST_SELECT,
          orderBy: { publishedAt: 'desc' },
          take: 30,
        })
        return posts
          .filter((p) => !isNsfwText(p.text)) // NSFW-спам не находится поиском
          .map((p) => postDTOFromRow(p, { liked: false, bookmarked: false, subscribed: false }))
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
