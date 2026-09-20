import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'

export const dynamic = 'force-dynamic'

// userId из тела игнорируется — пользователь берётся из Bearer-сессии.
const bodySchema = z.object({
  postId: z.string().min(1).max(64),
  /** Накопленное время поста на экране (мс). Кап 5 минут за один отчёт. */
  ms: z.number().int().min(0).max(300_000),
})

/**
 * POST /api/view/dwell { postId, ms } — сигнал интереса для рекомендаций.
 *
 * Пользователь держал пост на экране (карточка в вьюпорте) или читал его
 * в полном просмотре — это сильный сигнал «заинтересовало», даже без лайка.
 * Время НАКАПЛИВАЕТСЯ в PostView.dwellMs (сумма по всем сессиям) и входит
 * в аффинити ранжирования (lib/feed loadPersonalSignals).
 * Созданный впервые PostView засчитывает и сам просмотр (viewsCount +1).
 */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 120, windowMs: 60_000, bucket: 'view-dwell' })
  if (!g.ok) return g.res
  const userId = g.uid

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('postId and ms required')
    const { postId, ms } = parsed.data
    if (ms < 1000) return NextResponse.json({ ok: true }) // шум не пишем

    // Дочитывание — сильный сигнал «горячего» поста: задержался 5с+ → +3 к температуре
    const hotDelta = ms >= 5_000 ? 3 : 0

    /*
     * Дешёвый путь (поллится клиентом постоянно): сначала ОДИН updateMany —
     * если просмотр уже есть, на этом всё (1 RTT вместо 2-4: раньше были
     * последовательные findUnique → update). Только для первого просмотра —
     * ветка create с post.update (viewsCount +1, hotScore hotDelta-1).
     * Семантика прежняя, включая гонку с параллельным просмотром.
     */
    const updated = await db.postView.updateMany({
      where: { userId, postId },
      data: { dwellMs: { increment: ms } },
    })
    if (updated.count > 0) {
      if (hotDelta > 0) {
        await db.post.update({ where: { id: postId }, data: { hotScore: { increment: hotDelta } } }).catch(() => {})
      }
      return NextResponse.json({ ok: true })
    }

    try {
      await db.postView.create({ data: { userId, postId, dwellMs: ms } })
      await db.post.update({
        where: { id: postId },
        data: { viewsCount: { increment: 1 }, hotScore: hotDelta - 1 },
      })
    } catch {
      // гонка с параллельным просмотром — досыпаем время поверх
      await db.postView
        .update({ where: { userId_postId: { userId, postId } }, data: { dwellMs: { increment: ms } } })
        .catch(() => {})
    }

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[view/dwell]', e)
    return err('dwell failed', 500)
  }
}
