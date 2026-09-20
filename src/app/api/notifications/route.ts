import { NextResponse } from 'next/server'
import { proxiedMediaUrl } from '@/lib/media'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { getCachedNotifications, putCachedNotifications } from '@/lib/notif-cache'
import type { NotificationDTO, NotificationGroupDTO, NotificationPostDTO } from '@/lib/types'

type NotificationsResponse = {
  count: number
  groups: NotificationGroupDTO[]
  since: string
  activity: NotificationDTO[]
  unreadActivity: number
}

export const dynamic = 'force-dynamic'

/** Лимит суммарного числа новых постов в ответе */
const MAX_POSTS = 30
/** Окно «нового» по умолчанию, если пользователь ещё не открывал уведомления */
const DEFAULT_WINDOW_MS = 48 * 60 * 60 * 1000
/** Максимальная длина превью текста поста */
const PREVIEW_LEN = 140

/**
 * Вычистка markdown-мусора из текста поста (Telegram-разметка):
 * фенсы кода, [текст](ссылки), **жирный**, __курсив__, ~~зачёркнутый~~, ||спойлер||, `код`.
 * Одиночные * и ` тоже убираем (остатки разметки); подчёркивания внутри слов не трогаем.
 */
function stripMarkdown(raw: string): string {
  return raw
    .replace(/```[a-zA-Z]*\n?/g, '') // ```lang / ```
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [текст](url) → текст
    .replace(/\*\*(.+?)\*\*/g, '$1') // **жирный**
    .replace(/__(.+?)__/g, '$1') // __курсив__
    .replace(/~~(.+?)~~/g, '$1') // ~~зачёркнутый~~
    .replace(/\|\|(.+?)\|\|/g, '$1') // ||спойлер||
    .replace(/`([^`]+)`/g, '$1') // `код`
    .replace(/[*`]+/g, '') // одиночные остатки
    .replace(/\s+/g, ' ')
    .trim()
}

/** Обрезка превью до max символов с многоточием (по последнему слову) */
function truncate(s: string, max = PREVIEW_LEN): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1).trimEnd()}…`
}

/**
 * GET /api/notifications — новые посты каналов с включённым колокольчиком
 * + инбокс активности (комментарии/поддержка/кампании — таблица Notification).
 * Пользователь берётся из Bearer-сессии; лимит 60 запросов в минуту.
 *
 * Окно «нового»: user.lastSeenNotifiedAt ?? now−48ч.
 * Посты (≤30 суммарно) группируются по каналам; каналы сортируются
 * по числу новых постов (desc), при равенстве — по новизне последнего поста.
 */
export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'notif' })
  if (!g.ok) return g.res
  const userId = g.uid

  // L0-кэш 10с: бейдж опрашивается при каждом bump ленты — бёрсты поллинга
  // не должны умножать 3-5 SQL-запросов (см. src/lib/notif-cache.ts)
  const cached = getCachedNotifications<NotificationsResponse>(userId)
  if (cached) return NextResponse.json(cached)

  try {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, lastSeenNotifiedAt: true },
    })
    if (!user) return err('user not found', 404)

    const since = user.lastSeenNotifiedAt ?? new Date(Date.now() - DEFAULT_WINDOW_MS)

    // Активность (инбокс) считается всегда — и для юзеров без подписок тоже:
    // ответы поддержки не должны зависеть от колокольчиков каналов
    const subs = await db.subscription.findMany({
      where: { userId, notify: true },
      select: { channelId: true },
    })
    const channelIds = subs.map((s) => s.channelId)

    const unreadActivity = await db.notification.count({ where: { userId, readAt: null } })
    const activityRows = await db.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    })
    const activity: NotificationDTO[] = activityRows.map((n) => ({
      id: n.id,
      type: (n.type as NotificationDTO['type']) ?? 'system',
      title: n.title,
      body: n.body,
      postId: n.postId,
      commentId: n.commentId ?? null,
      channelUsername: n.channelUsername,
      read: n.readAt !== null,
      createdAt: n.createdAt.toISOString(),
    }))

    if (channelIds.length === 0) {
      const empty: NotificationsResponse = {
        count: 0,
        groups: [],
        since: since.toISOString(),
        activity,
        unreadActivity,
      }
      putCachedNotifications(userId, empty)
      return NextResponse.json(empty)
    }

    const posts = await db.post.findMany({
      where: { channelId: { in: channelIds }, publishedAt: { gt: since } },
      orderBy: { publishedAt: 'desc' },
      take: MAX_POSTS,
      // egress (11-a): инбоксу нужен только превью-сниппет + шапка канала —
      // include тянул ttsAudio/translations/aiSummary каждого поста впустую
      select: {
        id: true,
        channelId: true,
        text: true,
        mediaUrl: true,
        publishedAt: true,
        channel: {
          select: {
            id: true,
            title: true,
            username: true,
            isPremium: true,
            avatarColor: true,
            avatarUrl: true,
            photoFileId: true,
            category: { select: { slug: true } },
          },
        },
      },
    })

    // Группировка по каналам с сохранением порядка (posts уже desc по времени)
    const byChannel = new Map<string, NotificationPostDTO[]>()
    const channelsById = new Map<string, (typeof posts)[number]['channel']>()
    for (const p of posts) {
      channelsById.set(p.channelId, p.channel)
      let list = byChannel.get(p.channelId)
      if (!list) {
        list = []
        byChannel.set(p.channelId, list)
      }
      list.push({
        id: p.id,
        textPreview: truncate(stripMarkdown(p.text)),
        mediaUrl: p.mediaUrl,
        publishedAt: p.publishedAt.toISOString(),
      })
    }

    const groups: NotificationGroupDTO[] = [...byChannel.entries()].map(([channelId, groupPosts]) => {
      const ch = channelsById.get(channelId)!
      return {
        username: ch.username,
        title: ch.title,
        isPremium: ch.isPremium,
        avatarColor: ch.avatarColor,
        // v5.33: Storage-аватарка через /api/media (CDN-кэш, экономия egress Supabase)
        avatarUrl: proxiedMediaUrl(ch.avatarUrl) ?? (ch.photoFileId ? `/api/avatar/c_${ch.id}` : null),
        categorySlug: ch.category?.slug ?? null,
        count: groupPosts.length,
        posts: groupPosts,
      }
    })

    // Больше новых постов — выше; при равенстве — новее последний пост
    groups.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count
      return b.posts[0].publishedAt.localeCompare(a.posts[0].publishedAt)
    })

    const payload: NotificationsResponse = {
      count: posts.length,
      groups,
      since: since.toISOString(),
      activity,
      unreadActivity,
    }
    putCachedNotifications(userId, payload)
    return NextResponse.json(payload)
  } catch (e) {
    console.error('[notifications]', e)
    return err('notifications failed', 500)
  }
}
