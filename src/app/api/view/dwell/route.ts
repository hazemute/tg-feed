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

    const existing = await db.postView.findUnique({
      where: { userId_postId: { userId, postId } },
      select: { id: true },
    })
    if (existing) {
      await db.postView.update({
        where: { id: existing.id },
        data: { dwellMs: { increment: ms } },
      })
    } else {
      try {
        await db.postView.create({ data: { userId, postId, dwellMs: ms } })
        await db.post.update({ where: { id: postId }, data: { viewsCount: { increment: 1 } } })
      } catch {
        // гонка с параллельным просмотром — досыпаем время поверх
        await db.postView
          .update({ where: { userId_postId: { userId, postId } }, data: { dwellMs: { increment: ms } } })
          .catch(() => {})
      }
    }

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[view/dwell]', e)
    return err('dwell failed', 500)
  }
}
