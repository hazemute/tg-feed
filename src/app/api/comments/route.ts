import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth, guardPublic } from '@/lib/guard'
import type { CommentDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

/**
 * Комментарии под постом.
 *
 * GET  /api/comments?postId=…&cursor=… — список (новые снизу, страницы по 40,
 *       cursor — id самой старой загруженной; публично, лимит по IP/юзеру).
 * POST /api/comments { postId, text } — только привязанные к Telegram
 *       (гость получает 401 {auth:true} → клиент открывает шторку входа).
 *       Счётчик Post.commentsCount денормализован, «температура» поста +5.
 *
 * Текст: трим 1..700 символов, лимит 8 комментариев/мин на пользователя.
 */

const PAGE = 40
const MAX_LEN = 700

type Body = { postId?: unknown; text?: unknown }

/** Прочный прокси-URL аватарки (дубль логики lib/tg.ts — она клиентская) */
function avatarUrlOf(userId: string, photoUrl: string | null): string | null {
  if (!photoUrl) return null
  if (photoUrl.startsWith('tgfile:')) return `/api/avatar/${userId}`
  return photoUrl
}

/** Публичное представление автора комментария (без приватных полей) */
function authorOf(u: {
  id: string
  username: string | null
  firstName: string | null
  lastName: string | null
  photoUrl: string | null
}) {
  const name =
    [u.firstName, u.lastName].filter(Boolean).join(' ').trim() ||
    (u.username ? `@${u.username}` : 'Читатель')
  return {
    id: u.id,
    name,
    username: u.username,
    avatarUrl: avatarUrlOf(u.id, u.photoUrl),
  }
}

export async function GET(request: Request) {
  const g = guardPublic(request, { limit: 120, windowMs: 60_000, bucket: 'comments-get' })
  if (!g.ok) return g.res

  const url = new URL(request.url)
  const postId = (url.searchParams.get('postId') ?? '').trim()
  const cursor = (url.searchParams.get('cursor') ?? '').trim()
  if (!/^[a-zA-Z0-9_-]{6,40}$/.test(postId)) return err('postId required')

  try {
    const rows = await db.comment.findMany({
      where: { postId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PAGE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        user: { select: { id: true, username: true, firstName: true, lastName: true, photoUrl: true } },
      },
    })

    const hasMore = rows.length > PAGE
    const page = hasMore ? rows.slice(0, PAGE) : rows
    // Хронология как в Telegram: старые сверху, новые снизу
    const items: CommentDTO[] = page
      .slice()
      .reverse()
      .map((c) => ({
        id: c.id,
        postId: c.postId,
        text: c.text,
        createdAt: c.createdAt.toISOString(),
        author: authorOf(c.user),
        own: g.uid !== null && c.userId === g.uid,
      }))

    return NextResponse.json({
      items,
      nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
    })
  } catch (e) {
    console.error('[comments GET]', e)
    return err('comments failed', 500)
  }
}

export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 8, windowMs: 60_000, bucket: 'comment-post' })
  if (!g.ok) return g.res
  // Ленивая регистрация: комментарии — только для привязанных к Telegram
  if (g.guest) {
    return NextResponse.json({ error: 'login required', auth: true }, { status: 401 })
  }

  try {
    const body = await readJson<Body>(request)
    const postId = typeof body.postId === 'string' ? body.postId.trim() : ''
    const text = typeof body.text === 'string' ? body.text.replace(/\s+$/g, '').trim() : ''
    if (!/^[a-zA-Z0-9_-]{6,40}$/.test(postId)) return err('postId required')
    if (!text) return err('text required')
    if (text.length > MAX_LEN) return err(`максимум ${MAX_LEN} символов`, 413)

    const post = await db.post.findUnique({ where: { id: postId }, select: { id: true } })
    if (!post) return err('post not found', 404)

    const created = await db.$transaction(async (tx) => {
      const c = await tx.comment.create({
        data: { postId, userId: g.uid, text },
        include: {
          user: { select: { id: true, username: true, lastName: true, firstName: true, photoUrl: true } },
        },
      })
      // Денормализованный счётчик + пост «греется» от обсуждения (+5)
      const p = await tx.post.update({
        where: { id: postId },
        data: { commentsCount: { increment: 1 }, hotScore: { increment: 5 } },
        select: { commentsCount: true },
      })
      return { c, commentsCount: p.commentsCount }
    })

    const dto: CommentDTO = {
      id: created.c.id,
      postId: created.c.postId,
      text: created.c.text,
      createdAt: created.c.createdAt.toISOString(),
      author: authorOf(created.c.user),
      own: true,
    }
    return NextResponse.json({ comment: dto, commentsCount: created.commentsCount })
  } catch (e) {
    console.error('[comments POST]', e)
    return err('comment failed', 500)
  }
}
