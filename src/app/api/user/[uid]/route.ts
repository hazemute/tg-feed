import { NextResponse } from 'next/server'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { guardIp } from '@/lib/guard'
import { IS_SQLITE } from '@/lib/server'
import { parseBadges } from '@/lib/badges'
import { effectiveTier } from '@/lib/tiers'
import { userAvatarProxyUrl } from '@/lib/media'
import type { PublicProfileResponse } from '@/lib/types'

export const dynamic = 'force-dynamic'

/**
 * GET /api/user/[uid] — публичный профиль (v5.27).
 *
 * Отдаётся без сессии (по ссылке/из шапки профиля): имя, аватар, бейджи,
 * тариф, дата регистрации, статистика (комментарии/лайки на комментариях)
 * и оформление (палитра/узор/рамка) — фронтенд рендерит обложку по каталогу
 * src/lib/profile-style.ts.
 *
 * Приватность: гости не показываются, забаненный профиль неотличим от
 * несуществующего (404). Rate limit — по IP (60/мин, bucket pubprof).
 *
 * СКОРОСТЬ (v5.69):
 *  - два COUNT (комментарии + полученные лайки, второй через JOIN) слиты
 *    в ОДИН SQL с подзапросами → одна волна запросов (user + stats параллельно);
 *  - ответ кэшируется в памяти процесса на 30с (профиль публичный и одинаковый
 *    для всех; edge-CDN уже держит 60с — mem-кэш добивает бёрсты и локальный dev).
 */

const UidSchema = z.string().min(3).max(64).regex(/^[a-z0-9_]+$/i)

/** CDN (11-a): ответ без персонализации — edge-кэш 60с снимает бёрсты поллинга */
const CDN_CACHE = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300'

type CachedProfile = { dto: PublicProfileResponse; exp: number }
const profileCache = new Map<string, CachedProfile>()
const PROFILE_TTL_MS = 30_000
const PROFILE_CACHE_MAX = 500

export async function GET(request: Request, { params }: { params: Promise<{ uid: string }> }) {
  const g = guardIp(request, { limit: 60, windowMs: 60_000, bucket: 'pubprof' })
  if (!g.ok) return g.res

  const { uid } = await params
  const parsed = UidSchema.safeParse(uid)
  if (!parsed.success) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const cached = profileCache.get(parsed.data)
  if (cached && cached.exp > Date.now()) {
    return NextResponse.json(cached.dto, { headers: { 'Cache-Control': CDN_CACHE } })
  }

  try {
    // COUNT(*) в Postgres → bigint → приводим к int (::int); SQLite — число как есть
    const c = IS_SQLITE ? Prisma.raw('') : Prisma.raw('::int')

    const [user, statsRows] = await Promise.all([
      db.user.findUnique({
        where: { id: parsed.data },
        select: {
          id: true,
          username: true,
          firstName: true,
          lastName: true,
          photoUrl: true,
          isGuest: true,
          isPremium: true,
          bannedAt: true,
          tier: true,
          tierUntil: true,
          badges: true,
          profilePalette: true,
          profileBg: true,
          profileFrame: true,
          createdAt: true,
          // v5.75: уровень — публично (прогресс-бар в чужом профиле)
          xp: true,
          level: true,
        },
      }),
      db.$queryRaw<{ comments: number; likesReceived: number }[]>`
        SELECT
          (SELECT COUNT(*)${c} FROM "Comment" WHERE "userId" = ${parsed.data}) AS comments,
          (SELECT COUNT(*)${c}
             FROM "CommentLike" cl
             JOIN "Comment" cm ON cm."id" = cl."commentId"
            WHERE cm."userId" = ${parsed.data}) AS likesReceived`,
    ])
    if (!user || user.isGuest || user.bannedAt) {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }
    const st = statsRows[0] ?? { comments: 0, likesReceived: 0 }

    const name =
      [user.firstName, user.lastName].filter(Boolean).join(' ') ||
      (user.username ? `@${user.username}` : 'Пользователь')

    const dto: PublicProfileResponse = {
      id: user.id,
      name,
      username: user.username,
      // v5.69: прокси-аватар (сырые telesco.pe-ссылки протухают через час)
      photoUrl: userAvatarProxyUrl(user.id, user.photoUrl),
      isPremium: user.isPremium,
      tier: effectiveTier(user),
      badges: parseBadges(user.badges),
      memberSince: user.createdAt.toISOString(),
      stats: { comments: Number(st.comments), likesReceived: Number(st.likesReceived) },
      // v5.75: уровень и XP — в публичном профиле
      xp: user.xp,
      level: user.level,
      style: {
        palette: user.profilePalette,
        bg: user.profileBg,
        frame: user.profileFrame,
      },
    }

    // Гигиена кэша: чистим протухшие, при переполнении — первые попавшиеся
    if (profileCache.size >= PROFILE_CACHE_MAX) {
      const now = Date.now()
      for (const [k, v] of profileCache) if (v.exp <= now) profileCache.delete(k)
      if (profileCache.size >= PROFILE_CACHE_MAX) {
        const first = profileCache.keys().next().value
        if (first !== undefined) profileCache.delete(first)
      }
    }
    profileCache.set(parsed.data, { dto, exp: Date.now() + PROFILE_TTL_MS })

    return NextResponse.json(dto, { headers: { 'Cache-Control': CDN_CACHE } })
  } catch (e) {
    console.error('[user/public]', e)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
