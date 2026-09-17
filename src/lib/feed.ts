import { db } from '@/lib/db'
import { parseJsonArray } from '@/lib/server'

/**
 * Общий скоуп ленты для пользователя: активные каналы, минус скрытые,
 * фильтр по категории или интересам. Используется в /api/feed и /api/feed/fresh.
 *
 * sig — сигнатура скоупа для Redis-ключа (категория + интересы + скрытые);
 * null для 'discover' (зависит от истории просмотров, кэш не применяется).
 */
export async function buildFeedScope(userId: string, category: string) {
  const user = await db.user.findUnique({ where: { id: userId } })
  if (!user) return null

  const hidden = await db.subscription.findMany({
    where: { userId, hidden: true },
    select: { channelId: true },
  })
  const hiddenIds = hidden.map((h) => h.channelId)

  const where: {
    channel: {
      status: 'active'
      id?: { notIn: string[] }
      category?: { slug: string } | { slug: { in: string[] } }
    }
    publishedAt?: { gt: Date }
  } = {
    channel: {
      status: 'active',
      id: hiddenIds.length > 0 ? { notIn: hiddenIds } : undefined,
    },
  }

  let interests: string[] = []
  if (category === 'discover') {
    // «Интересное»: категории, которые пользователь смотрит МЕНЬШЕ всего
    // (по истории просмотров PostView → Post → Channel.categoryId).
    // Берём до 4 наименее просмотренных категорий — расширяем кругозор.
    const views = await db.postView.findMany({
      where: { userId },
      select: { post: { select: { channel: { select: { categoryId: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    })
    const viewsByCategory = new Map<string, number>()
    for (const v of views) {
      const cid = v.post?.channel?.categoryId
      if (cid) viewsByCategory.set(cid, (viewsByCategory.get(cid) ?? 0) + 1)
    }

    const allCategories = await db.category.findMany({
      where: { slug: { not: 'other' } },
      select: { id: true, slug: true },
    })
    const leastViewed = allCategories
      .sort((a, b) => (viewsByCategory.get(a.id) ?? 0) - (viewsByCategory.get(b.id) ?? 0))
      .slice(0, 4)
      .map((c) => c.slug)

    // Пустая база категорий — фолбэк на «всё, кроме ничего» (пустой in не отдаст ничего)
    if (leastViewed.length > 0) {
      where.channel.category = { slug: { in: leastViewed } }
    }
  } else if (category !== 'all') {
    where.channel.category = { slug: category }
  } else {
    interests = parseJsonArray(user.categories)
    if (interests.length > 0) {
      where.channel.category = { slug: { in: interests } }
    }
  }

  const sig =
    category === 'discover'
      ? null
      : `${category}|${interests.join(',')}|${hiddenIds.join(',')}`

  return { where, user, sig }
}
