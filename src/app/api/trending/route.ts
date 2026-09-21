import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { guardPublic } from '@/lib/guard'
import { cacheAside, famKey } from '@/lib/redis'
import { computeTrendingCore } from '@/lib/trending-core'
import { jsonWithEtag } from '@/lib/etag'
import type { ChannelDTO, PostDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

/**
 * GET /api/trending — агрегат для вкладки «Тренды».
 *
 * Состав ответа:
 *  • pulse      — пульс за 24 часа: новые посты, лайки, просмотры, клики по #тегам;
 *  • hashtags   — топ-10 хэштегов за 72ч (клики), фолбэк — частотные из свежих постов;
 *  • topPosts   — топ-10 постов за 72ч по вовлечённости (лайки×10 + просмотры/10),
 *                 если за 72ч набирается меньше 5 — окно расширяется до 7 дней;
 *  • topChannels— топ-8 активных каналов по подписчикам.
 *
 * Публичный (сессия опциональна). Redis-оптимизация: глобальное ядро (пульс,
 * хэштеги, топ-посты, топ-каналы с нейтральными флагами) кэшируется на 150с
 * (память 20с): тяжёлый холодный пересчёт максимум раз в 2.5 минуты, обычно
 * клиент попадает в тёплый кэш (плюс prefetch при старте приложения).
 * Тяжёлый fetcher (computeTrendingCore) живёт в lib/trending-core.ts — ЕДИНЫЙ
 * код для route и фонового прогрева (feed-warm): перед наплывом ключ tr:core
 * уже согрет, бёрст пользователей не запускает пересборку на пуле.
 * Лимит 30/мин.
 */
export async function GET(request: Request) {
  const g = guardPublic(request, { limit: 30, windowMs: 60_000, bucket: 'trending' })
  if (!g.ok) return g.res
  const uid = g.uid

  try {
    const core = await cacheAside({
      key: await famKey('tr', 'core'),
      ttlSec: 150,
      memoryTtlMs: 20_000,
      fetcher: computeTrendingCore,
    })

    // Персонализация поверх кэша: только флаги, данные остаются кэшированными
    // v5.49: ETag/304 на гостевом пути тоже (самый частый трафик трендов)
    if (!uid) return jsonWithEtag(request, core)

    const postIds = core.topPosts.map((p) => p.id)
    const channelIds = [
      ...new Set([
        ...core.topChannels.map((c) => c.id),
        ...core.topPosts.map((p) => p.channel.id),
      ]),
    ]

    const [likes, bookmarks, subs] = await Promise.all([
      postIds.length
        ? db.like.findMany({ where: { userId: uid, postId: { in: postIds } }, select: { postId: true } })
        : Promise.resolve([]),
      postIds.length
        ? db.bookmark.findMany({ where: { userId: uid, postId: { in: postIds } }, select: { postId: true } })
        : Promise.resolve([]),
      channelIds.length
        ? db.subscription.findMany({ where: { userId: uid, channelId: { in: channelIds } }, select: { channelId: true } })
        : Promise.resolve([]),
    ])

    const likeSet = new Set(likes.map((l) => l.postId))
    const bookmarkSet = new Set(bookmarks.map((b) => b.postId))
    const subSet = new Set(subs.map((s) => s.channelId))

    const topPosts: PostDTO[] = core.topPosts.map((p) => ({
      ...p,
      liked: likeSet.has(p.id),
      bookmarked: bookmarkSet.has(p.id),
      channel: { ...p.channel, subscribed: subSet.has(p.channel.id) },
    }))
    const topChannels: ChannelDTO[] = core.topChannels.map((c) => ({
      ...c,
      subscribed: subSet.has(c.id),
    }))

    // v5.49: ETag/304 — тренды рендерятся из локального кэша мгновенно
    return jsonWithEtag(request, { ...core, topPosts, topChannels })
  } catch (e) {
    console.error('[trending]', e)
    return err('trending failed', 500)
  }
}
