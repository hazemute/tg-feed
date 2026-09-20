import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'

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
      added = await db.$transaction(async (tx) => {
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
      })
    }

    return NextResponse.json({ ok: true, added })
  } catch (e) {
    console.error('[view]', e)
    return err('view failed', 500)
  }
}
