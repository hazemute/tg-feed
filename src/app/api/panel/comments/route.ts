import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'
import { IS_SQLITE } from '@/lib/server'
import { logAdmin } from '@/lib/admin-log'
import { avatarUrlOf } from '@/lib/comments-server'
import { grantXp, XP_RULES } from '@/lib/xp'

export const dynamic = 'force-dynamic'

/** insensitive-фрагмент contains, совместимый и с Postgres, и с SQLite (см. lib/moderation.ts) */
function ci(value: string): Record<string, unknown> {
  return IS_SQLITE ? { contains: value } : { contains: value, mode: 'insensitive' as const }
}

/**
 * Модерация комментариев (админка, x-admin-key).
 *
 * GET /api/panel/comments?q=…&limit=50 — последние комментарии (новые сверху)
 *   с автором, постом и каналом; q ищет по тексту/имени/@username автора.
 * DELETE /api/panel/comments { id } — удалить ЛЮБОЙ комментарий
 *   (счётчик Post.commentsCount уменьшается, не ниже 0).
 */

export async function GET(request: Request) {
  const g = guardAdmin(request, { limit: 120, windowMs: 60_000, bucket: 'panel-comments' })
  if (!g.ok) return g.res

  const url = new URL(request.url)
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 64)
  const limitRaw = Number(url.searchParams.get('limit') ?? 50)
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(10, Math.floor(limitRaw))) : 50

  try {
    const rows = await db.comment.findMany({
      // SQLite (локальная песочница) не знает mode:'insensitive' — ci() совместим с обеими БД
      where: q
        ? {
            OR: [
              { text: ci(q) },
              { user: { username: ci(q.replace(/^@/, '')) } },
              { user: { firstName: ci(q) } },
              { user: { lastName: ci(q) } },
            ],
          }
        : undefined,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        text: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            photoUrl: true,
            bannedAt: true,
          },
        },
        post: {
          select: {
            id: true,
            text: true,
            commentsCount: true,
            channel: { select: { id: true, title: true, username: true } },
          },
        },
      },
    })

    return NextResponse.json({
      items: rows.map((c) => ({
        id: c.id,
        text: c.text,
        createdAt: c.createdAt.toISOString(),
        author: {
          id: c.user.id,
          name:
            [c.user.firstName, c.user.lastName].filter(Boolean).join(' ').trim() ||
            (c.user.username ? `@${c.user.username}` : 'Читатель'),
          username: c.user.username,
          avatarUrl: avatarUrlOf(c.user.id, c.user.photoUrl),
          banned: c.user.bannedAt !== null,
        },
        post: {
          id: c.post.id,
          excerpt: (c.post.text ?? '').slice(0, 120),
          commentsCount: c.post.commentsCount,
          channelTitle: c.post.channel.title,
          channelUsername: c.post.channel.username,
        },
      })),
    })
  } catch (e) {
    console.error('[panel/comments GET]', e)
    return err('comments failed', 500)
  }
}

const delSchema = z.object({ id: z.string().min(1).max(64) })

export async function DELETE(request: Request) {
  const g = guardAdmin(request, { limit: 60, windowMs: 60_000, bucket: 'panel-comments-del' })
  if (!g.ok) return g.res

  try {
    const parsed = delSchema.safeParse(await readJson(request))
    if (!parsed.success) return err('id required')

    const result = await db.$transaction(async (tx) => {
      const c = await tx.comment.findUnique({
        where: { id: parsed.data.id },
        select: { id: true, postId: true, userId: true },
      })
      if (!c) return null
      await tx.comment.delete({ where: { id: c.id } })
      const p = await tx.post.update({
        where: { id: c.postId },
        data: { commentsCount: { decrement: 1 } },
        select: { commentsCount: true },
      })
      return { commentsCount: Math.max(0, p.commentsCount), authorId: c.userId }
    })

    if (!result) return err('comment not found', 404)
    // v5.75: удаление комментария модератором — нарушение (−15 XP автору).
    // Гость штрафа не боится: grantXp сам пропускает guest_*.
    void grantXp(result.authorId, 'violation', XP_RULES.violationComment, 'Комментарий удалён модератором')
    await logAdmin('comment', parsed.data.id, { op: 'delete_comment', postId: null })
    return NextResponse.json({ ok: true, commentsCount: result.commentsCount })
  } catch (e) {
    console.error('[panel/comments DELETE]', e)
    return err('delete failed', 500)
  }
}
