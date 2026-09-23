import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { checkAndAwardAuto } from '@/lib/giveaway-tickets'
import { evaluateViewsAchievement } from '@/lib/achievements-server'

export const dynamic = 'force-dynamic'

// userId из тела игнорируется — пользователь берётся из Bearer-сессии.
const bodySchema = z.object({
  postIds: z.array(z.string().min(1).max(64)).min(1).max(50),
})

/** POST /api/view { postIds: string[] } — учёт просмотров внутри Mini App */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 120, windowMs: 60_000, bucket: 'view' })
  if (!g.ok) return g.res
  const userId = g.uid

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('postIds required')
    const postIds = [...new Set(parsed.data.postIds)]

    // Дешёвый батч вместо по-постовой цепочки (см. план ниже): один SELECT
    // существующих просмотров + одна транзакция на ОДНОМ соединении пула
    const existing = await db.postView.findMany({
      where: { userId, postId: { in: postIds } },
      select: { postId: true },
    })
    const seen = new Set(existing.map((v) => v.postId))
    const newIds = postIds.filter((id) => !seen.has(id))

    let added = 0
    if (newIds.length > 0) {
      /*
       * Раньше: НА КАЖДЫЙ пост последовательные findUnique → create → update
       * (до 3 RTT до дальнего Supabase × 50 постов = 150 RTT, запрос висел
       * секунды). Теперь: ОДИН атомарный createManyAndReturn + ОДИН updateMany
       * счётчиков внутри транзакции (одно соединение пула — бёрст в пул не
       * ловит P2024). createManyAndReturn возвращает СОЗДАННЫЕ строки —
       * viewsCount инкрементируется ровно по факту (редкая гонка с
       * параллельным запросом того же юзера уходит в построчный фолбэк).
       * Просмотр остужает пост (-1): «горячим» остаётся то, на что реагируют,
       * а не то, что просто показали каждому.
       */
      added = await db.$transaction(
        async (tx) => {
          let createdIds: string[]
          try {
            const rows = await tx.postView.createManyAndReturn({
              data: newIds.map((postId) => ({ userId, postId })),
              select: { postId: true },
            })
            createdIds = rows.map((r) => r.postId)
          } catch {
            // P2002: уникальный конфликт — атомарный INSERT откатился целиком;
            // создаём построчно (в той же транзакции), пропуская уже созданные
            createdIds = []
            for (const postId of newIds) {
              try {
                await tx.postView.create({ data: { userId, postId } })
                createdIds.push(postId)
              } catch {
                /* параллельный запрос уже создал просмотр */
              }
            }
          }
          if (createdIds.length > 0) {
            await tx.post.updateMany({
              where: { id: { in: createdIds } },
              data: { viewsCount: { increment: 1 }, hotScore: { decrement: 1 } },
            })
          }
          return createdIds.length
        },
        /*
         * Таймауты транзакции подняты (v5.42): дефолтных 5с не хватает на
         * холодном старте/дальней БД — транзакция умирала (P2028) и запрос
         * отдавал 500 «view failed», просмотры не засчитывались. 15с + 8с
         * maxWait покрывают и построчный фолбэк на 50 постов, и медленный
         * Supabase; для батча из 2 запросов это безопасно.
         */
        { timeout: 15_000, maxWait: 8_000 },
      )
    }

    // v5.46: пролистанные посты = прогресс задания «активность» в розыгрышах
    // (fire-and-forget: проверка активных розыгрышей + выдача билетов, не тормозит ответ)
    if (added > 0 && !userId.startsWith('guest_')) {
      void checkAndAwardAuto({ id: userId, tgId: Number(userId.slice(3)) || undefined })
      // v5.90: лёгкая проверка ачивки «Листатель» (guard 10 минут — см. модуль)
      void evaluateViewsAchievement(userId)
    }

    /* v6.4.0: новые просмотры должны УЧИТЫВАТЬСЯ сразу: кэш персональных
     * сигналов (15с) иначе отдавал устаревший viewedIds, и pull-to-refresh
     * сразу после скролла возвращал только что виденное. Инвалидация дешёвая
     * (удаление из map), следующий запрос пересоберёт сигналы из БД. */
    if (added > 0) {
      const { invalidatePersonalSignals } = await import('@/lib/feed')
      invalidatePersonalSignals(userId)
    }

    return NextResponse.json({ ok: true, added })
  } catch (e) {
    console.error('[view]', e)
    return err('view failed', 500)
  }
}
