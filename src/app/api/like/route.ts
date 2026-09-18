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

    const [user, post] = await Promise.all([
      db.user.findUnique({ where: { id: userId } }),
      db.post.findUnique({ where: { id: postId } }),
    ])
    if (!user) return err('user not found', 404)
    if (!post) return err('post not found', 404)

    const existing = await db.like.findFirst({ where: { userId, postId } })

    if (existing) {
      await db.like.delete({ where: { id: existing.id } })
      const updated = await db.post.update({
        where: { id: postId },
        data: { likesCount: { decrement: 1 } },
      })
      // Показываем сумму: реакции исходного поста + локальные лайки
      putFlagsOverride(userId, postId, { liked: false })
      return NextResponse.json({
        liked: false,
        likesCount: Math.max(0, updated.reactionsTg + updated.likesCount),
      })
    }

    await db.like.create({ data: { userId, postId } })
    const updated = await db.post.update({
      where: { id: postId },
      data: { likesCount: { increment: 1 } },
    })
    putFlagsOverride(userId, postId, { liked: true })
    return NextResponse.json({ liked: true, likesCount: updated.reactionsTg + updated.likesCount })
  } catch (e) {
    console.error('[like]', e)
    return err('like failed', 500)
  }
}
