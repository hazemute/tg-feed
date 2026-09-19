import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { buildFeedScope } from '@/lib/feed'
import { detectLang, langPasses } from '@/lib/lang'
import { diversify } from '@/lib/rank'
import { toPostDTO } from '@/lib/dto'
import { guardAuth } from '@/lib/guard'
import { nsfwPostNotIn } from '@/lib/moderation'
import type { PostDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

// userId из query игнорируется — пользователь берётся из Bearer-сессии.
const querySchema = z.object({
  category: z.string().max(32).regex(/^[a-z0-9_-]+$/).catch('all'),
  after: z
    .string()
    .min(1)
    .max(64)
    .refine((v) => !Number.isNaN(new Date(v).getTime()), { message: 'after (ISO date) required' }),
  /** Фильтр языка — пилюля «N новых» обязана совпадать с видимой лентой,
   *  иначе счётчик показывает посты, которых пользователь не увидит */
  lang: z.enum(['any', 'ru', 'foreign']).catch('any'),
})

/**
 * GET /api/feed/fresh?category=all|slug&after=<ISO>
 * Пилюля «N новых постов»: количество новых постов в скоупе ленты
 * + сами посты (новые сверху), чтобы вставить их в начало ленты без полного ре-ранка.
 * Требуется сессия (Bearer); лимит 120 запросов в минуту на пользователя.
 */
export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 120, windowMs: 60_000, bucket: 'fresh' })
  if (!g.ok) return g.res
  const userId = g.uid

  try {
    const { searchParams } = new URL(request.url)
    const parsed = querySchema.safeParse(Object.fromEntries(searchParams))
    if (!parsed.success) return err('after (ISO date) required')
    const { category, after, lang } = parsed.data
    const afterDate = new Date(after)

    const scope = await buildFeedScope(userId, category)
    if (!scope) return err('user not found', 404)

    const posts = await db.post.findMany({
      where: {
        ...scope.where,
        publishedAt: { gt: afterDate },
        AND: [
          ...nsfwPostNotIn(),
          // ИИ-модерация: свежая пачка тоже без junk/nsfw/spam
          { OR: [{ aiFlag: null }, { aiFlag: 'ok' }] },
        ],
      },
      orderBy: { publishedAt: 'desc' },
      take: 30,
      include: { channel: { include: { category: true } }, _count: { select: { bookmarkedBy: true } } },
    })

    // Флаги пользователя для этих постов (недорого: постов ≤ 30)
    const postIds = posts.map((p) => p.id)
    const [likes, bookmarks, subs] = await Promise.all([
      postIds.length
        ? db.like.findMany({ where: { userId, postId: { in: postIds } }, select: { postId: true } })
        : Promise.resolve([]),
      postIds.length
        ? db.bookmark.findMany({ where: { userId, postId: { in: postIds } }, select: { postId: true } })
        : Promise.resolve([]),
      db.subscription.findMany({ where: { userId }, select: { channelId: true } }),
    ])
    const likeSet = new Set(likes.map((l) => l.postId))
    const bookmarkSet = new Set(bookmarks.map((b) => b.postId))
    const subSet = new Set(subs.map((s) => s.channelId))

    const items: PostDTO[] = posts
      .filter((p) => langPasses(detectLang(p.text), lang))
      .map((p) =>
        toPostDTO(
          p,
          {
            liked: likeSet.has(p.id),
            bookmarked: bookmarkSet.has(p.id),
            subscribed: subSet.has(p.channelId),
          },
          p._count.bookmarkedBy,
        ),
      )

    /*
     * Разнообразие: один канал — НЕ подряд даже в свежей пачке. Канал мог
     * выложить несколько постов залпом — без diversify все они аппендились
     * бы в конец ленты сплошной серией (главный источник «повторов подряд»).
     */
    const diversified = diversify(items, (x) => x.channel.id)

    return NextResponse.json({ count: diversified.length, items: diversified })
  } catch (e) {
    console.error('[feed/fresh]', e)
    return err('fresh failed', 500)
  }
}
