import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { guardAuth } from '@/lib/guard'
import type { ActivityDayDTO, ProfileStatsResponse } from '@/lib/types'

export const dynamic = 'force-dynamic'

/** Окно статистики — 7 дней, включая сегодня */
const DAYS = 7

/** Локальная дата (UTC сервера) в формате YYYY-MM-DD */
function dayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * GET /api/profile/stats — активность пользователя за 7 дней.
 * Пользователь берётся из Bearer-сессии; лимит 60 запросов в минуту.
 *
 * views  — просмотры постов (PostView.createdAt) по дням;
 * reads  — прочитанные закладки (Bookmark.readAt != null) по дням readAt;
 * likes  — лайки (Like.createdAt) по дням;
 * channels — число активных подписок (Subscription).
 *
 * Агрегация в JS: записей в окне немного (сотни), поэтому выбираем только
 * поля дат с WHERE по окну — это проще и безопаснее SQL-группировки.
 */
export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'stats' })
  if (!g.ok) return g.res
  const userId = g.uid

  try {
    const user = await db.user.findUnique({ where: { id: userId }, select: { id: true } })
    if (!user) return NextResponse.json({ error: 'user not found' }, { status: 404 })

    // Начало окна: полночь дня 6 дней назад (итого 7 календарных дней с сегодня)
    const now = new Date()
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    start.setDate(start.getDate() - (DAYS - 1))

    const [views, bookmarks, likes, channels] = await Promise.all([
      db.postView.findMany({
        where: { userId, createdAt: { gte: start } },
        select: { createdAt: true },
      }),
      // gte по nullable-полю автоматически исключает NULL (readAt не null)
      db.bookmark.findMany({
        where: { userId, readAt: { gte: start } },
        select: { readAt: true },
      }),
      db.like.findMany({
        where: { userId, createdAt: { gte: start } },
        select: { createdAt: true },
      }),
      db.subscription.count({ where: { userId } }),
    ])

    // Заготовка дней по возрастанию (пустые дни остаются с нулями)
    const byDate = new Map<string, ActivityDayDTO>()
    for (let i = 0; i < DAYS; i++) {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      const key = dayKey(d)
      byDate.set(key, { date: key, views: 0, reads: 0, likes: 0 })
    }

    // Разкладываем события по дням (записи вне окна отфильтрованы WHERE)
    for (const v of views) {
      const day = byDate.get(dayKey(v.createdAt))
      if (day) day.views++
    }
    for (const b of bookmarks) {
      if (!b.readAt) continue
      const day = byDate.get(dayKey(b.readAt))
      if (day) day.reads++
    }
    for (const l of likes) {
      const day = byDate.get(dayKey(l.createdAt))
      if (day) day.likes++
    }

    const days = [...byDate.values()]
    const dto: ProfileStatsResponse = {
      days,
      totals: {
        views: days.reduce((s, d) => s + d.views, 0),
        reads: days.reduce((s, d) => s + d.reads, 0),
        likes: days.reduce((s, d) => s + d.likes, 0),
        channels,
      },
    }

    return NextResponse.json(dto)
  } catch (e) {
    console.error('[profile/stats]', e)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
