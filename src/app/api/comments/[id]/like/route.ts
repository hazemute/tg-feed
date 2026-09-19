import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { authorOf, notifyUser } from '@/lib/comments-server'

export const dynamic = 'force-dynamic'

/**
 * POST /api/comments/[id]/like — тоггл лайка комментария текущего пользователя.
 * Только привязанные к Telegram (гость получает 401 {auth:true}).
 * Возвращает { liked, likesCount }; при лайке (не дизлайке) автору комментария
 * уходит уведомление типа comment_like (fire-and-forget, кроме самолайка).
 */
type Ctx = { params: Promise<{ id: string }> }

export async function POST(request: Request, ctx: Ctx) {
  const g = guardAuth(request, { limit: 30, windowMs: 60_000, bucket: 'comment-like' })
  if (!g.ok) return g.res
  if (g.guest) {
    return NextResponse.json({ error: 'login required', auth: true }, { status: 401 })
  }

  const { id } = await ctx.params
  if (!/^[a-zA-Z0-9_-]{6,40}$/.test(id)) return err('bad id')

  try {
    const comment = await db.comment.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        text: true,
        likesCount: true,
        postId: true,
        post: { select: { channel: { select: { username: true } } } },
      },
    })
    if (!comment) return err('comment not found', 404)

    const existing = await db.commentLike.findUnique({
      where: { userId_commentId: { userId: g.uid, commentId: id } },
      select: { id: true },
    })

    if (existing) {
      const n = await db.$transaction(async (tx) => {
        await tx.commentLike.delete({ where: { id: existing.id } })
        return tx.comment.update({
          where: { id },
          data: { likesCount: { decrement: 1 } },
          select: { likesCount: true },
        })
      })
      return NextResponse.json({ liked: false, likesCount: Math.max(0, n.likesCount) })
    }

    const n = await db.$transaction(async (tx) => {
      await tx.commentLike.create({ data: { userId: g.uid, commentId: id } })
      return tx.comment.update({
        where: { id },
        data: { likesCount: { increment: 1 } },
        select: { likesCount: true },
      })
    })

    // Уведомление автору комментария (не на свой лайк)
    if (comment.userId !== g.uid) {
      const me = await db.user.findUnique({
        where: { id: g.uid },
        select: { username: true, firstName: true, lastName: true, photoUrl: true },
      })
      if (me) {
        notifyUser({
          userId: comment.userId,
          type: 'comment_like',
          title: authorOf(me).name,
          body: `❤️ ${comment.text}`,
          postId: comment.postId,
          channelUsername: comment.post.channel.username,
        })
      }
    }

    return NextResponse.json({ liked: true, likesCount: n.likesCount })
  } catch (e) {
    console.error('[comment like]', e)
    return err('like failed', 500)
  }
}
