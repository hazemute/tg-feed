import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { guardAuth } from '@/lib/guard'
import { proxiedMediaUrl } from '@/lib/media'
import { jsonWithEtag } from '@/lib/etag'

export const dynamic = 'force-dynamic'

/**
 * GET /api/subscriptions — подписки пользователя с флагом «скрыт из ленты».
 * Пользователь берётся из Bearer-сессии; лимит 60 запросов в минуту.
 * egress (11-a): select вместо include — styleProfile (JSON-слепок ИИ),
 * avatarVideoUrl, avatarHash и пр. в ответ не идут, форма DTO прежняя.
 */
export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'subscriptions' })
  if (!g.ok) return g.res
  const userId = g.uid

  try {
    const subs = await db.subscription.findMany({
      where: { userId },
      select: {
        channelId: true,
        hidden: true,
        notify: true,
        channel: {
          select: {
            id: true,
            title: true,
            username: true,
            description: true,
            avatarColor: true,
            avatarUrl: true,
            photoFileId: true,
            membersCount: true,
            subscribersCount: true,
            isPremium: true,
            status: true,
            category: { select: { slug: true, title: true } },
            _count: { select: { posts: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    // v5.49: ETag/304 — при следующем заходе в миниапп подписки рендерятся из
    // локального кэша мгновенно, сервер отдаёт пустой 304, если ничего не менялось
    return jsonWithEtag(request, {
      items: subs.map((s) => ({
        channelId: s.channelId,
        hidden: s.hidden,
        notify: s.notify,
        channel: {
          id: s.channel.id,
          title: s.channel.title,
          username: s.channel.username,
          description: s.channel.description?.replace(/\s+/g, ' ').trim() ?? null,
          avatarColor: s.channel.avatarColor,
          // v5.33: Storage-аватарка через /api/media (CDN-кэш, экономия egress Supabase)
          avatarUrl: proxiedMediaUrl(s.channel.avatarUrl) ?? (s.channel.photoFileId ? `/api/avatar/c_${s.channel.id}` : null),
          subscribersCount: s.channel.membersCount ?? s.channel.subscribersCount,
          isPremium: s.channel.isPremium,
          status: s.channel.status,
          categorySlug: s.channel.category?.slug ?? null,
          categoryTitle: s.channel.category?.title ?? null,
          postsCount: s.channel._count.posts,
          subscribed: true,
        },
      })),
    })
  } catch (e) {
    console.error('[subscriptions]', e)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
