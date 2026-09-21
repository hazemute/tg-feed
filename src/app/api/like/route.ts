import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { putFlagsOverride } from '@/lib/page-cache'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'

export const dynamic = 'force-dynamic'

// userId из тела игнорируется — пользователь берётся из Bearer-сессии.
const bodySchema = z.object({
  postId: z.string().min(1).max(64),
})

/** POST /api/like { postId } — переключатель «Интересно» (сессия обязательна) */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'like' })
  if (!g.ok) return g.res
  const userId = g.uid

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('postId required')
    const postId = parsed.data.postId

    // select вместо полной строки (egress: у Post есть тяжёлые колонки
    // ttsAudio/translations — на тоггл они не нужны)
    const [user, post] = await Promise.all([
      db.user.findUnique({ where: { id: userId }, select: { id: true } }),
      db.post.findUnique({
        where: { id: postId },
        select: { id: true, reactionsTg: true, likesCount: true },
      }),
    ])
    if (!user) return err('user not found', 404)
    if (!post) return err('post not found', 404)

    const existing = await db.like.findUnique({
      where: { userId_postId: { userId, postId } },
      select: { id: true },
    })

    if (existing) {
      // v5.48: удаление лайка + декремент счётчика — АТОМАРНО (раньше между
      // delete и update мог упасть decrement → likesCount дрейфовал вверх навсегда)
      try {
        const [, updated] = await db.$transaction([
          db.like.delete({ where: { id: existing.id } }),
          db.post.update({
            where: { id: postId },
            data: { likesCount: { decrement: 1 } },
            select: { reactionsTg: true, likesCount: true },
          }),
        ])
        putFlagsOverride(userId, postId, { liked: false })
        // v5.68: лайки автономны — только мини-апп (без reactionsTg)
        return NextResponse.json({
          liked: false,
          likesCount: Math.max(0, updated.likesCount),
        })
      } catch {
        // гонка (двойной тап): лайк уже снял параллельный запрос — честный ответ
        const fresh = await db.post.findUnique({
          where: { id: postId },
          select: { reactionsTg: true, likesCount: true },
        })
        putFlagsOverride(userId, postId, { liked: false })
        return NextResponse.json({ liked: false, likesCount: Math.max(0, fresh?.likesCount ?? 0) })
      }
    }

    // v5.48: создание лайка + инкремент счётчика/температуры — тоже атомарно
    try {
      const [, updated] = await db.$transaction([
        db.like.create({ data: { userId, postId } }),
        db.post.update({
          where: { id: postId },
          // Лайк — сильный сигнал температуры: +10 (см. lib/rank.ts computeWeight)
          data: { likesCount: { increment: 1 }, hotScore: { increment: 10 } },
          select: { reactionsTg: true, likesCount: true },
        }),
      ])
      putFlagsOverride(userId, postId, { liked: true })
      // v5.68: лайки автономны — только мини-апп (без reactionsTg)
      return NextResponse.json({ liked: true, likesCount: updated.likesCount })
    } catch {
      // гонка (двойной тап): лайк уже поставил параллельный запрос — идемпотентно
      const fresh = await db.post.findUnique({
        where: { id: postId },
        select: { reactionsTg: true, likesCount: true },
      })
      putFlagsOverride(userId, postId, { liked: true })
      return NextResponse.json({ liked: true, likesCount: fresh?.likesCount ?? 0 })
    }
  } catch (e) {
    console.error('[like]', e)
    return err('like failed', 500)
  }
}
