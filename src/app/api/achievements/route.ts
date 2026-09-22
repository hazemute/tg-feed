import { NextResponse } from 'next/server'
import { err } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { buildAchievementsResponse, evaluateAchievements } from '@/lib/achievements-server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/achievements — мои достижения и прогресс (v5.90).
 *
 * Отдаёт разблокировки (tier по каждой ачивке каталога), текущие значения
 * всех метрик и сводку (сколько ступеней открыто). Кэш 30с на юзера
 * (сбрасывается при новой награде — ревизия в achievements-server).
 */
export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'achievements' })
  if (!g.ok) return g.res

  try {
    // v5.90: ленивая синхронизация достижений (раз в 5 минут на юзера) —
    // первый ответ может быть «до начисления», следующий уже с наградами
    void evaluateAchievements(g.uid, 'sync')
    const data = await buildAchievementsResponse(g.uid)
    return NextResponse.json(data)
  } catch (e) {
    console.error('[achievements]', (e as Error).message)
    return err('achievements failed', 500)
  }
}
