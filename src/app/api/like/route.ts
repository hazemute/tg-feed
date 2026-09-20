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
      try {
        await db.like.delete({ where: { id: existing.id } })
      } catch {
        // гонка (двойной тап): лайк уже снял параллельный запрос — честный ответ
        const fresh = await db.post.findUnique({
          where: { id: postId },
          select: { reactionsTg: true, likesCount: true },
        })
        putFlagsOverride(userId, postId, { liked: false })
        return NextResponse.json({ liked: false, likesCount: Math.max(0, (fresh?.reactionsTg ?? 0) + (fresh?.likesCount ?? 0)) })
      }
      const updated = await db.post.update({
        where: { id: postId },
        data: { likesCount: { decrement: 1 } },
        select: { reactionsTg: true, likesCount: true },
      })
      // Показываем сумму: реакции исходного поста + локальные лайки
      putFlagsOverride(userId, postId, { liked: false })
      return NextResponse.json({
        liked: false,
        likesCount: Math.max(0, updated.reactionsTg + updated.likesCount),
      })
    }

    try {
      await db.like.create({ data: { userId, postId } })
    } catch {
      // гонка (двойной тап): лайк уже поставил параллельный запрос — идемпотентно
      const fresh = await db.post.findUnique({
        where: { id: postId },
        select: { reactionsTg: true, likesCount: true },
      })
      putFlagsOverride(userId, postId, { liked: true })
      return NextResponse.json({ liked: true, likesCount: (fresh?.reactionsTg ?? 0) + (fresh?.likesCount ?? 0) })
    }
    // Лайк — сильный сигнал температуры: +10 (см. lib/rank.ts computeWeight)
    const updated = await db.post.update({
      where: { id: postId },
      data: { likesCount: { increment: 1 }, hotScore: { increment: 10 } },
      select: { reactionsTg: true, likesCount: true },
    })
    putFlagsOverride(userId, postId, { liked: true })
    return NextResponse.json({ liked: true, likesCount: updated.reactionsTg + updated.likesCount })
  } catch (e) {
    console.error('[like]', e)
    return err('like failed', 500)
  }
}
