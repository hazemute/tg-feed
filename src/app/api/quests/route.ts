import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { guardAuth } from '@/lib/guard'
import { err } from '@/lib/server'
import { cacheAside, famKey } from '@/lib/redis'
import { questLinkOf } from '@/lib/quests'

export const dynamic = 'force-dynamic'

/**
 * GET /api/quests — список активных заданий + мой статус по каждому.
 *
 * Сам список заданий почти не меняется → кэшируется (cacheAside, 20с fresh);
 * персональный статус (done/revoked) кладётся поверх после — строк на юзера
 * единицы, запрос дешёвый. Лимит 60/мин.
 */

type QuestItem = {
  id: string
  kind: string
  title: string
  description: string | null
  rewardSwp: number
  link: string
}

type QuestListPayload = { items: QuestItem[] }

export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'quests' })
  if (!g.ok) return g.res

  try {
    const [list, mine, user] = await Promise.all([
      cacheAside<QuestListPayload>({
        key: await famKey('qt', 'all'),
        ttlSec: 60,
        memoryTtlMs: 20_000,
        fetcher: async () => {
          const rows = await db.quest.findMany({
            where: { active: true },
            orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }],
            select: {
              id: true,
              kind: true,
              title: true,
              description: true,
              rewardSwp: true,
              target: true,
              link: true,
            },
          })
          return {
            items: rows.map((q) => ({
              id: q.id,
              kind: q.kind,
              title: q.title,
              description: q.description,
              rewardSwp: q.rewardSwp,
              link: questLinkOf(q.target, q.link),
            })),
          }
        },
      }),
      db.questCompletion.findMany({
        where: { userId: g.uid },
        select: { questId: true, status: true },
      }),
      db.user.findUnique({ where: { id: g.uid }, select: { swipes: true } }),
    ])

    const status = new Map(mine.map((m) => [m.questId, m.status]))
    return NextResponse.json({
      items: list.items.map((q) => ({ ...q, myStatus: status.get(q.id) ?? null })),
      balance: user?.swipes ?? 0,
    })
  } catch (e) {
    console.error('[quests]', e)
    return err('failed', 500)
  }
}
