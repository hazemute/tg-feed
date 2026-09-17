import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * GET /api/panel/overview — сводка для вкладки «Обзор» локальной админ-панели.
 * Доступ: x-admin-key (guardAdmin), лимит 120 запросов/мин/IP.
 */
export async function GET(request: Request) {
  const g = guardAdmin(request, { limit: 120, windowMs: 60_000, bucket: 'panel-overview' })
  if (!g.ok) return g.res

  try {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)

    const [
      users,
      usersTelegram,
      usersDemo,
      channelsActive,
      channelsModeration,
      channelsRejected,
      posts,
      ads,
      likes,
      subscriptions,
      bookmarks,
      hashtagClicks24h,
      notifiedPosts24h,
    ] = await Promise.all([
      db.user.count(),
      db.user.count({ where: { isDemo: false } }),
      db.user.count({ where: { isDemo: true } }),
      db.channel.count({ where: { status: 'active' } }),
      db.channel.count({ where: { status: 'moderation' } }),
      db.channel.count({ where: { status: 'rejected' } }),
      db.post.count(),
      db.ad.count(),
      db.like.count(),
      db.subscription.count(),
      db.bookmark.count(),
      db.hashtagClick.count({ where: { createdAt: { gte: dayAgo } } }),
      db.post.count({ where: { notifiedAt: { gte: dayAgo } } }),
    ])

    const [freshPosts, recentUsers, topChannels] = await Promise.all([
      db.post.findMany({
        orderBy: { publishedAt: 'desc' },
        take: 8,
        select: {
          id: true,
          text: true,
          mediaUrl: true,
          publishedAt: true,
          channel: { select: { id: true, title: true, username: true, avatarColor: true, photoFileId: true } },
        },
      }),
      db.user.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { id: true, username: true, firstName: true, isDemo: true, createdAt: true },
      }),
      db.channel.findMany({
        orderBy: { subscribersCount: 'desc' },
        take: 6,
        select: {
          id: true,
          title: true,
          username: true,
          avatarColor: true,
          photoFileId: true,
          subscribersCount: true,
          _count: { select: { posts: true } },
        },
      }),
    ])

    return NextResponse.json({
      counts: {
        users,
        usersTelegram,
        usersDemo,
        channelsActive,
        channelsModeration,
        channelsRejected,
        posts,
        ads,
        likes,
        subscriptions,
        bookmarks,
        hashtagClicks24h,
      },
      notif: {
        botConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()),
        sent24h: notifiedPosts24h,
      },
      freshPosts: freshPosts.map((p) => ({
        id: p.id,
        channelTitle: p.channel.title,
        channelUsername: p.channel.username,
        avatarColor: p.channel.avatarColor,
        avatarUrl: p.channel.photoFileId ? `/api/avatar/c_${p.channel.id}` : null,
        text: p.text.slice(0, 220),
        publishedAt: p.publishedAt.toISOString(),
        mediaUrl: p.mediaUrl,
      })),
      recentUsers: recentUsers.map((u) => ({
        id: u.id,
        username: u.username,
        firstName: u.firstName,
        isDemo: u.isDemo,
        createdAt: u.createdAt.toISOString(),
      })),
      topChannels: topChannels.map((c) => ({
        title: c.title,
        username: c.username,
        avatarColor: c.avatarColor,
        avatarUrl: c.photoFileId ? `/api/avatar/c_${c.id}` : null,
        subscribersCount: c.subscribersCount,
        postsCount: c._count.posts,
      })),
      generatedAt: new Date().toISOString(),
    })
  } catch (e) {
    console.error('[panel/overview]', e)
    return err('overview failed', 500)
  }
}
