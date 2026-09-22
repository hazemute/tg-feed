import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { POST_LIST_SELECT, postDTOFromRow } from '@/lib/dto'
import { guardPublic } from '@/lib/guard'
import { cacheAside, famKey, shortHash } from '@/lib/redis'
import { isNsfwText, getNsfwChannelIds } from '@/lib/moderation'
import { IS_SQLITE } from '@/lib/server'
import type { ChannelDTO, PostDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

/** insensitive-фрагмент contains, совместимый и с Postgres, и с SQLite (см. lib/moderation.ts) */
function ci(value: string): Record<string, unknown> {
  return IS_SQLITE ? { contains: value } : { contains: value, mode: 'insensitive' as const }
}

// Публичный поиск; сессия опциональна — от неё зависят только лайк/закладка.
const querySchema = z.object({
  q: z.string().trim().max(100).catch(''),
  offset: z.coerce.number().int().min(0).max(300).catch(0),
})

/** Страница постов и лимит выдачи (пагинация v5.91) */
const PAGE_SIZE = 30
const SCAN_LIMIT = 300

/**
 * GET /api/search?q=...&offset=0
 * Поиск по ключевым словам ВНУТРИ ПОСТОВ (не по названиям каналов).
 * Регистронезависимый: фильтр ILIKE на стороне Postgres — покрывает ВСЮ
 * историю постов, а тяжёлый JOIN с include не убивает latency:
 * строки фильтруются ДО склейки с каналами.
 *
 * v5.91 — ПОИСК v2:
 *  - РЕЛЕВАНТНОСТЬ вместо «только свежее»: совпадение в названии канала,
 *    совпадение в начале поста, число вхождений, свежесть — взвешенный скор;
 *  - КАНАЛЫ ИЗ БД: response.channels — активные каналы по title/username
 *    (раньше вкладка «Каналы» видела только уже загруженный каталог);
 *  - ПАГИНАЦИЯ: ?offset=0/30/60… + nextOffset в ответе («Показать ещё»).
 *
 * Redis-оптимизация: результаты поиска (глобальная часть) кэшируются по
 * нормализованному запросу+смещению на 90с; персональные флаги
 * (лайк/закладка/подписка) накладываются после кэша.
 */
export async function GET(request: Request) {
  const g = guardPublic(request, { limit: 60, windowMs: 60_000, bucket: 'search' })
  if (!g.ok) return g.res
  const userId = g.uid // string | null

  try {
    const { searchParams } = new URL(request.url)
    const parsed = querySchema.safeParse(Object.fromEntries(searchParams))
    const q = parsed.success ? parsed.data.q : ''
    const offset = parsed.success ? parsed.data.offset : 0

    if (q.length < 2) return NextResponse.json({ items: [], query: q, channels: [], nextOffset: null })

    const needle = q.toLowerCase()

    /* ------------------------- Глобальная часть (кэш) ------------------------ */
    const global = await cacheAside({
      key: await famKey('sr', `${shortHash(needle)}:${offset}`),
      ttlSec: 90,
      memoryTtlMs: 30_000,
      fetcher: async (): Promise<{ items: PostDTO[]; channels: ChannelDTO[]; nextOffset: number | null }> => {
        // Сканируем с запасом на смещение: offset+страница (кап 300 — ищем в свежем ядре)
        const scan = Math.min(offset + PAGE_SIZE, SCAN_LIMIT)
        const rows = await db.post.findMany({
          where: {
            text: ci(needle),
            channel: { status: 'active', id: { notIn: await getNsfwChannelIds() } },
          },
          // POST_LIST_SELECT (egress): ttsAudio/translations в выдачу поиска не идут
          select: POST_LIST_SELECT,
          orderBy: { publishedAt: 'desc' as const },
          take: scan,
        })

        // РЕЛЕВАНТНОСТЬ: название канала > начало поста > число вхождений > свежесть.
        // Детерминизм: publishedAt desc + id asc при равном скоринге.
        const weekAgo = Date.now() - 7 * 24 * 3_600_000
        const scored = rows
          .filter((p) => !isNsfwText(p.text)) // NSFW-спам не находится поиском
          .map((p) => {
            const text = p.text.toLowerCase()
            const first = text.indexOf(needle)
            let occurrences = 0
            if (first >= 0) {
              occurrences = 1
              let i = first + needle.length
              while (occurrences < 6) {
                const next = text.indexOf(needle, i)
                if (next < 0) break
                occurrences++
                i = next + needle.length
              }
            }
            let score = occurrences * 10
            if (p.channel.title.toLowerCase().includes(needle)) score += 1000
            if (first === 0) score += 300
            else if (first > 0 && first <= 100) score += 80
            if (p.publishedAt.getTime() >= weekAgo) score += 25
            return { p, score, publishedAt: p.publishedAt.getTime(), id: p.id }
          })
          .sort((a, b) => b.score - a.score || b.publishedAt - a.publishedAt || a.id.localeCompare(b.id))

        const page = scored.slice(offset, offset + PAGE_SIZE)
        const items = page.map((x) =>
          postDTOFromRow(x.p, { liked: false, bookmarked: false, subscribed: false }),
        )
        const nextOffset =
          scored.length > offset + PAGE_SIZE && offset + PAGE_SIZE < SCAN_LIMIT
            ? offset + PAGE_SIZE
            : null

        // КАНАЛЫ ИЗ БД: title/username по запросу (раньше — только каталог клиента)
        const channelRows = await db.channel.findMany({
          where: {
            status: 'active',
            OR: [{ title: ci(needle) }, { username: ci(needle) }],
          },
          select: {
            id: true,
            title: true,
            username: true,
            description: true,
            avatarColor: true,
            avatarUrl: true,
            isPremium: true,
            verified: true,
            status: true,
            subscribersCount: true,
            teaserMode: true,
            teaserLimit: true,
            category: { select: { slug: true, title: true } },
          },
          orderBy: { subscribersCount: 'desc' },
          take: 6,
        })
        const channels: ChannelDTO[] = channelRows.map((c) => ({
          id: c.id,
          title: c.title,
          username: c.username,
          description: c.description,
          avatarColor: c.avatarColor,
          avatarUrl: c.avatarUrl,
          isPremium: c.isPremium,
          verified: c.verified,
          status: c.status,
          subscribersCount: c.subscribersCount,
          teaserMode: c.teaserMode,
          teaserLimit: c.teaserLimit,
          categorySlug: c.category.slug,
          categoryTitle: c.category.title,
          subscribed: false,
        }))

        return { items, channels, nextOffset }
      },
    })

    let items = global.items
    let channels = global.channels

    // Персонализация поверх кэша: лайк/закладка постов + флаг подписки каналов
    if (userId) {
      if (items.length > 0) {
        const ids = items.map((p) => p.id)
        const [likes, bookmarks] = await Promise.all([
          db.like.findMany({ where: { userId, postId: { in: ids } }, select: { postId: true } }),
          db.bookmark.findMany({ where: { userId, postId: { in: ids } }, select: { postId: true } }),
        ])
        const likeSet = new Set(likes.map((l) => l.postId))
        const bookmarkSet = new Set(bookmarks.map((b) => b.postId))
        items = items.map((p) => ({
          ...p,
          liked: likeSet.has(p.id),
          bookmarked: bookmarkSet.has(p.id),
        }))
      }
      if (channels.length > 0) {
        const subs = await db.subscription.findMany({
          where: { userId, channelId: { in: channels.map((c) => c.id) } },
          select: { channelId: true },
        })
        const subSet = new Set(subs.map((s) => s.channelId))
        channels = channels.map((c) => ({ ...c, subscribed: subSet.has(c.id) }))
      }
    }

    return NextResponse.json({ items, query: q, channels, nextOffset: global.nextOffset })
  } catch (e) {
    console.error('[search]', e)
    return NextResponse.json({ error: 'search failed' }, { status: 500 })
  }
}
