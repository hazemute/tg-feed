import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { levelProgress, XP_RULES } from '@/lib/xp-rules'
import { xpEarnedTodayByKind, xpHistory } from '@/lib/xp'

export const dynamic = 'force-dynamic'

/**
 * GET /api/level — мой уровень и XP (v5.75).
 *
 * Отдаёт прогресс-бар (пороги текущего уровня), дневные заработки по видам
 * активности (лимиты считают компоненты) и последние 15 записей журнала XP.
 * XP за найденные баги здесь НЕ выдаётся — только админ через панель.
 */
export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'level' })
  if (!g.ok) return g.res

  try {
    const user = await db.user.findUnique({
      where: { id: g.uid },
      select: { xp: true, level: true, isGuest: true },
    })
    if (!user) return err('user not found', 404)

    // Гостю отдаём нулевой прогресс (бар в профиле скрыт, шит зовёт на логин)
    const xp = user.isGuest ? 0 : user.xp
    const level = user.isGuest ? 1 : user.level

    const [commentToday, likeToday, history] = await Promise.all([
      user.isGuest ? Promise.resolve(0) : xpEarnedTodayByKind(g.uid, 'comment'),
      user.isGuest ? Promise.resolve(0) : xpEarnedTodayByKind(g.uid, 'like'),
      user.isGuest ? Promise.resolve([]) : xpHistory(g.uid, 15),
    ])

    return NextResponse.json({
      isGuest: user.isGuest,
      ...levelProgress(xp, level),
      today: {
        comment: commentToday,
        commentCap: XP_RULES.commentDailyCap * XP_RULES.comment,
        like: likeToday,
        likeCap: XP_RULES.likeDailyCap * XP_RULES.like,
      },
      history: history.map((h) => ({ ...h, createdAt: h.createdAt.toISOString() })),
    })
  } catch (e) {
    console.error('[level]', e)
    return err('level failed', 500)
  }
}
