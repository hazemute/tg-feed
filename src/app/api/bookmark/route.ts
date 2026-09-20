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

/** POST /api/bookmark { postId } — переключатель закладки (сохранённые посты) */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'bookmark' })
  if (!g.ok) return g.res
  const userId = g.uid

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('postId required')
    const postId = parsed.data.postId

    // select вместо полной строки (egress: ttsAudio/translations на тоггл не нужны)
    const [user, post] = await Promise.all([
      db.user.findUnique({ where: { id: userId }, select: { id: true } }),
      db.post.findUnique({ where: { id: postId }, select: { id: true } }),
    ])
    if (!user) return err('user not found', 404)
    if (!post) return err('post not found', 404)

    const existing = await db.bookmark.findUnique({
      where: { userId_postId: { userId, postId } },
      select: { id: true },
    })

    if (existing) {
      try {
        await db.bookmark.delete({ where: { id: existing.id } })
      } catch {
        // гонка (двойной тап): закладку уже снял параллельный запрос
      }
      putFlagsOverride(userId, postId, { bookmarked: false })
      return NextResponse.json({ bookmarked: false })
    }

    try {
      await db.bookmark.create({ data: { userId, postId } })
    } catch {
      // гонка (двойной тап): закладка уже стоит — идемпотентно
    }
    putFlagsOverride(userId, postId, { bookmarked: true })
    return NextResponse.json({ bookmarked: true })
  } catch (e) {
    console.error('[bookmark]', e)
    return err('bookmark failed', 500)
  }
}
