import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { IS_SQLITE, parseJsonArray } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { userAvatarProxyUrl } from '@/lib/media'
import type { ProfileResponse } from '@/lib/types'

export const dynamic = 'force-dynamic'

/**
 * GET /api/profile — профиль + статистика.
 * Пользователь берётся из Bearer-сессии; лимит 60 запросов в минуту.
 *
 * СКОРОСТЬ (v5.69): 4 счётчика (лайки/подписки/просмотры/закладки) считались
 * четырьмя параллельными COUNT — в проде (Supabase Postgres) это до 5 round-trip'ов
 * к БД на каждый запрос. Теперь ВСЯ статистика — один SQL с подзапросами
 * (1 RTT), параллельно с чтением пользователя → всего одна волна запросов.
 */
export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'profile' })
  if (!g.ok) return g.res
  const userId = g.uid

  try {
    // COUNT(*) в Postgres → bigint (Prisma отдаёт BigInt, JSON его не сериализует)
    // → приводим к int (::int). SQLite не знает ::int — там COUNT и так number.
    const c = IS_SQLITE ? Prisma.raw('') : Prisma.raw('::int')

    // select: только поля DTO (egress + меньше байтов из Supabase)
    const [user, statsRows] = await Promise.all([
      db.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          username: true,
          firstName: true,
          lastName: true,
          photoUrl: true,
          isGuest: true,
          isPremium: true,
          languageCode: true,
          categories: true,
          createdAt: true,
          profilePalette: true,
          profileBg: true,
          profileFrame: true,
        },
      }),
      db.$queryRaw<{ likes: number; subscriptions: number; views: number; bookmarks: number }[]>`
        SELECT
          (SELECT COUNT(*)${c} FROM "Like"         WHERE "userId" = ${userId}) AS likes,
          (SELECT COUNT(*)${c} FROM "Subscription" WHERE "userId" = ${userId}) AS subscriptions,
          (SELECT COUNT(*)${c} FROM "PostView"     WHERE "userId" = ${userId}) AS views,
          (SELECT COUNT(*)${c} FROM "Bookmark"     WHERE "userId" = ${userId}) AS bookmarks`,
    ])
    if (!user) return NextResponse.json({ error: 'user not found' }, { status: 404 })

    const s = statsRows[0] ?? { likes: 0, subscriptions: 0, views: 0, bookmarks: 0 }

    const dto: ProfileResponse = {
      user: {
        id: user.id,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        // v5.69: прокси-аватар (сырые telesco.pe-ссылки протухают)
        photoUrl: userAvatarProxyUrl(user.id, user.photoUrl),
        isGuest: user.isGuest,
        isPremium: user.isPremium,
        languageCode: user.languageCode,
        categories: parseJsonArray(user.categories),
        createdAt: user.createdAt.toISOString(),
        style: { palette: user.profilePalette, bg: user.profileBg, frame: user.profileFrame },
      },
      stats: {
        likes: Number(s.likes),
        subscriptions: Number(s.subscriptions),
        views: Number(s.views),
        bookmarks: Number(s.bookmarks),
      },
    }

    return NextResponse.json(dto)
  } catch (e) {
    console.error('[profile]', e)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
