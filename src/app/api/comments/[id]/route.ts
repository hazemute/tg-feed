import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { guardAuth } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * DELETE /api/comments/[id] — удалить СВОЙ комментарий.
 * Счётчик Post.commentsCount уменьшается (не ниже 0); «температуру» не трогаем
 * (разогрев уже случился — откатом можно накрутить -5 удалениями).
 */
type Ctx = { params: Promise<{ id: string }> }

export async function DELETE(request: Request, ctx: Ctx) {
  const g = guardAuth(request, { limit: 20, windowMs: 60_000, bucket: 'comment-del' })
  if (!g.ok) return g.res

  const { id } = await ctx.params
  if (!/^[a-zA-Z0-9_-]{6,40}$/.test(id)) return err('bad id')

  try {
    const deleted = await db.$transaction(async (tx) => {
      const c = await tx.comment.findUnique({ where: { id }, select: { id: true, userId: true, postId: true } })
      if (!c) return { status: 404 as const, commentsCount: null }
      if (c.userId !== g.uid) return { status: 403 as const, commentsCount: null }
      await tx.comment.delete({ where: { id } })
      const p = await tx.post.update({
        where: { id: c.postId },
        data: { commentsCount: { decrement: 1 } },
        select: { commentsCount: true },
      })
      return { status: 200 as const, commentsCount: Math.max(0, p.commentsCount), postId: c.postId }
    })

    if (deleted.status === 404) return err('comment not found', 404)
    if (deleted.status === 403) return err('чужой комментарий', 403)
    return NextResponse.json({ ok: true, commentsCount: deleted.commentsCount })
  } catch (e) {
    console.error('[comments DELETE]', e)
    return err('delete failed', 500)
  }
}
