import { NextResponse } from 'next/server'
import { err } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { getReadingStats, WEEK_GOAL, WEEK_REWARD } from '@/lib/reading'

export const dynamic = 'force-dynamic'

/**
 * GET /api/reading — статы чтения для профиля (v5.93): стрик, заморозки,
 * рекорд, цель недели, вехи, календарь последних 35 дней.
 * Гостям отдаём нули (UI прячет блок) — данные персональные.
 */
export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'reading' })
  if (!g.ok) return g.res

  try {
    if (g.uid.startsWith('guest_')) {
      return NextResponse.json({
        streak: 0,
        bestStreak: 0,
        freezes: 0,
        todayReads: 0,
        totalReads: 0,
        weekReads: 0,
        weekGoal: WEEK_GOAL,
        weekReward: WEEK_REWARD,
        milestones: [],
        history: [],
      })
    }
    const stats = await getReadingStats(g.uid)
    return NextResponse.json(stats)
  } catch (e) {
    console.error('[reading]', e)
    return err('reading failed', 500)
  }
}
