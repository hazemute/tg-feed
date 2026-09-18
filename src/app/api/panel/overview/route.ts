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
    const days14Ago = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)

    /*
     * Все каунты одним $transaction-массивом: Prisma выполняет их по ОДНОЙ
     * коннекции из пула (connection_limit=1 при pgbouncer) — большой
     * Promise.all исчерпывает пул и падает по таймауту.
     */
    const [
      users,
      usersTelegram,
      usersGuest,
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
      users24h,
      posts24h,
      likes24h,
      views24h,
      subs24h,
    ] = await db.$transaction([
      db.user.count(),
      db.user.count({ where: { isGuest: false } }),
      db.user.count({ where: { isGuest: true } }),
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
      db.user.count({ where: { createdAt: { gte: dayAgo } } }),
      db.post.count({ where: { publishedAt: { gte: dayAgo } } }),
      db.like.count({ where: { createdAt: { gte: dayAgo } } }),
      db.postView.count({ where: { createdAt: { gte: dayAgo } } }),
      db.subscription.count({ where: { createdAt: { gte: dayAgo } } }),
    ])

    // Посты по дням (14 дней) для спарклайна «Обзора» — лёгкая выборка дат;
    // свежие посты/юзеры/каналы — одной коннекцией в транзакции (пул = 1)
    const [recentPostDates, freshPosts, recentUsers, topChannels] = await db.$transaction([
      db.post.findMany({
        where: { publishedAt: { gte: days14Ago } },
        select: { publishedAt: true },
      }),
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
        select: { id: true, username: true, firstName: true, isGuest: true, createdAt: true },
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
    const postsPerDay: number[] = []
    {
      const buckets = new Array<number>(14).fill(0)
      const startOfDay = new Date()
      startOfDay.setHours(0, 0, 0, 0)
      for (const p of recentPostDates) {
        const dayIdx = Math.floor(
          (startOfDay.getTime() - p.publishedAt.getTime()) / (24 * 60 * 60 * 1000),
        )
        // 0 — сегодня, 13 — 13 дней назад; будущее (сдвиг часового пояса) клампим в сегодня
        const idx = Math.min(13, Math.max(0, dayIdx))
        buckets[idx] += 1
      }
      // разворачиваем: слева — старые, справа — сегодня
      for (let i = 13; i >= 0; i--) postsPerDay.push(buckets[i])
    }

    return NextResponse.json({
      counts: {
        users,
        usersTelegram,
        usersGuest,
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
      deltas24h: {
        users: users24h,
        posts: posts24h,
        likes: likes24h,
        views: views24h,
        subscriptions: subs24h,
      },
      postsPerDay,
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
        isGuest: u.isGuest,
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
