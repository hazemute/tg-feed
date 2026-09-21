import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { guardAuth } from '@/lib/guard'
import { err } from '@/lib/server'
import { cacheAside, famKey } from '@/lib/redis'
import { claimQuest, questLinkFor, questProgressInfo } from '@/lib/quests'
import { seedDefaultQuests } from '@/lib/quests-seed'

export const dynamic = 'force-dynamic'

/**
 * GET /api/quests — список активных заданий + мой статус по каждому.
 *
 * Сам список заданий почти не меняется → кэшируется (cacheAside, 20с fresh);
 * персональный статус (done/revoked/прогресс) кладётся поверх после — строк на
 * юзера единицы, запрос дешёвый. Лимит 60/мин.
 *
 * v5.70: прогресс автозачётных видов (прочитано N/M, серия входа) + автозачёт
 * ежедневного входа прямо при открытии вкладки (идемпотентно, раз в сутки).
 */
type QuestItem = {
  id: string
  kind: string
  title: string
  description: string | null
  rewardSwp: number
  target: string
  link: string
}

type QuestListPayload = { items: QuestItem[] }

export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'quests' })
  if (!g.ok) return g.res

  // Самолечение сида (троттлинг внутри: 1 проверка/10 мин на инстанс) —
  // основной вызов живёт в instrumentation при старте сервера
  void seedDefaultQuests().catch(() => {})

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
              target: q.target,
              link: questLinkFor(q.kind, q.target, q.link),
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
    let balance = user?.swipes ?? 0

    // Автозачёт ежедневного входа: вкладка открыта → день засчитан (раз в сутки,
    // атомарно; гости не зарабатывают). Свежая серия вернётся из прогресса ниже.
    const dailyQuest = list.items.find((q) => q.kind === 'daily_checkin')
    if (dailyQuest && !g.guest) {
      const claimed = await claimQuest(g.uid, dailyQuest.id).catch(() => null)
      if (claimed?.status === 'done' && typeof claimed.balance === 'number') {
        balance = claimed.balance
      }
    }

    const items = await Promise.all(
      list.items.map(async (q) => {
        const info = await questProgressInfo(g.uid, q).catch(() => ({
          progress: null,
          goal: null,
          streak: null,
        }))
        return {
          ...q,
          // daily_checkin: QuestCompletion не создаётся — статус «зачтено сегодня»
          // выводим из прогресса (progress=1 → done)
          myStatus:
            status.get(q.id) ??
            (q.kind === 'daily_checkin' && info.progress === 1 ? 'done' : null),
          progress: info.progress,
          goal: info.goal,
          streak: info.streak,
          target: undefined,
        }
      }),
    )

    return NextResponse.json({ items, balance })
  } catch (e) {
    console.error('[quests]', e)
    return err('failed', 500)
  }
}
