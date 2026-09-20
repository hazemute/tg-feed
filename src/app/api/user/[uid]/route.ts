import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { guardIp } from '@/lib/guard'
import { parseJsonArray } from '@/lib/server'
import { parseBadges } from '@/lib/badges'
import { effectiveTier } from '@/lib/tiers'
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
 */

const UidSchema = z.string().min(3).max(64).regex(/^[a-z0-9_]+$/i)

/** CDN (11-a): ответ без персонализации — edge-кэш 60с снимает бёрсты поллинга */
const CDN_CACHE = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300'

export async function GET(request: Request, { params }: { params: Promise<{ uid: string }> }) {
  const g = guardIp(request, { limit: 60, windowMs: 60_000, bucket: 'pubprof' })
  if (!g.ok) return g.res

  const { uid } = await params
  const parsed = UidSchema.safeParse(uid)
  if (!parsed.success) return NextResponse.json({ error: 'not found' }, { status: 404 })

  try {
    const user = await db.user.findUnique({
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
      },
    })
    if (!user || user.isGuest || user.bannedAt) {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }

    // Лайки, ПОЛУЧЕННЫЕ пользователем: лайки его комментариев (CommentLike → Comment.userId)
    const [comments, likesReceived] = await Promise.all([
      db.comment.count({ where: { userId: user.id } }),
      db.commentLike.count({ where: { comment: { userId: user.id } } }),
    ])

    const name =
      [user.firstName, user.lastName].filter(Boolean).join(' ') ||
      (user.username ? `@${user.username}` : 'Пользователь')

    const dto: PublicProfileResponse = {
      id: user.id,
      name,
      username: user.username,
      photoUrl: user.photoUrl,
      isPremium: user.isPremium,
      tier: effectiveTier(user),
      badges: parseBadges(user.badges),
      memberSince: user.createdAt.toISOString(),
      stats: { comments, likesReceived },
      style: {
        palette: user.profilePalette,
        bg: user.profileBg,
        frame: user.profileFrame,
      },
    }

    return NextResponse.json(dto, { headers: { 'Cache-Control': CDN_CACHE } })
  } catch (e) {
    console.error('[user/public]', e)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
