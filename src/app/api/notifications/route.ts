import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import type { NotificationGroupDTO, NotificationPostDTO } from '@/lib/types'

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
 * GET /api/notifications — новые посты каналов с включённым колокольчиком.
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

  try {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, lastSeenNotifiedAt: true },
    })
    if (!user) return err('user not found', 404)

    const since = user.lastSeenNotifiedAt ?? new Date(Date.now() - DEFAULT_WINDOW_MS)

    // Каналы пользователя с включённым колокольчиком (JOIN через Subscription)
    const subs = await db.subscription.findMany({
      where: { userId, notify: true },
      select: { channelId: true },
    })
    const channelIds = subs.map((s) => s.channelId)
    if (channelIds.length === 0) {
      return NextResponse.json({ count: 0, groups: [], since: since.toISOString() })
    }

    const posts = await db.post.findMany({
      where: { channelId: { in: channelIds }, publishedAt: { gt: since } },
      orderBy: { publishedAt: 'desc' },
      take: MAX_POSTS,
      include: { channel: { include: { category: true } } },
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
        avatarUrl: ch.avatarUrl ?? (ch.photoFileId ? `/api/avatar/c_${ch.id}` : null),
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

    return NextResponse.json({ count: posts.length, groups, since: since.toISOString() })
  } catch (e) {
    console.error('[notifications]', e)
    return err('notifications failed', 500)
  }
}
