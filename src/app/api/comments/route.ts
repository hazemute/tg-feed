import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth, guardPublic } from '@/lib/guard'
import { authorOf, likedSetFor, notifyUser, toCommentDTO } from '@/lib/comments-server'
import type { CommentDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

/**
 * Комментарии под постом — дерево «как в TikTok» (один уровень вложенности).
 *
 * GET  /api/comments?postId=…&sort=new|top&cursor=…
 *      — корневые комментарии (+2 превью-ответа у каждого); sort=new — хронология
 *        (старые сверху, страницы «назад во времени» по cursor=id), sort=top —
 *        по лайкам (cursor=offset). Публично, лимит по IP/юзеру.
 * GET  /api/comments?postId=…&parentId=…&cursor=…
 *      — ответы ветки (хронология, cursor=id последнего загруженного).
 * POST /api/comments { postId, text, parentId? } — только привязанные к Telegram
 *      (гость получает 401 {auth:true}); с parentId — ответ в ветку (replyToName
 *      денормализуется для плашки «Ответ NAME»). Счётчик Post.commentsCount
 *      денормализован, «температура» поста +5.
 *
 * Текст: трим 1..700 символов, лимит 8 комментариев/мин на пользователя.
 */

const PAGE = 40
const PREVIEW_REPLIES = 2
const MAX_LEN = 700

type Body = { postId?: unknown; text?: unknown; parentId?: unknown }

const AUTHOR_SELECT = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
  photoUrl: true,
  badges: true, // v5.19: бейджи автора (developer/manager/…) — рендер у имени
} as const

/** GET: список ответов ветки (parentId задан) */
async function listReplies(
  postId: string,
  parentId: string,
  cursor: string,
  uid: string | null,
) {
  const rows = await db.comment.findMany({
    where: { postId, parentId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: PAGE + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { user: { select: AUTHOR_SELECT } },
  })
  const hasMore = rows.length > PAGE
  const page = hasMore ? rows.slice(0, PAGE) : rows
  const liked = await likedSetFor(uid, page.map((c) => c.id))
  const items = page.map((c) => toCommentDTO(c, uid, liked))
  return { items, nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null }
}

/** GET: корневые комментарии с превью ответов (sort=new — хронология, sort=top — по лайкам) */
async function listRoots(
  postId: string,
  sort: 'new' | 'top',
  cursor: string,
  uid: string | null,
) {
  const where = { postId, parentId: null }
  const rows = await db.comment.findMany({
    where,
    orderBy:
      sort === 'top'
        ? [{ likesCount: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }]
        : [{ createdAt: 'desc' }, { id: 'desc' }],
    take: PAGE + 1,
    // new: страницы «назад во времени» по курсору-id; top: offset-пагинация
    ...(sort === 'new' && cursor
      ? { cursor: { id: cursor }, skip: 1 }
      : sort === 'top'
        ? { skip: Number(cursor) || 0 }
        : {}),
    include: {
      user: { select: AUTHOR_SELECT },
      replies: {
        take: PREVIEW_REPLIES,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: { user: { select: AUTHOR_SELECT } },
      },
    },
  })

  const hasMore = rows.length > PAGE
  const page = hasMore ? rows.slice(0, PAGE) : rows
  const allIds = page.flatMap((c) => [c.id, ...c.replies.map((r) => r.id)])
  const liked = await likedSetFor(uid, allIds)

  // Хронология как в Telegram (sort=new): старые сверху, новые снизу
  const ordered = sort === 'new' ? page.slice().reverse() : page
  const items: CommentDTO[] = ordered.map((c) => ({
    ...toCommentDTO(c, uid, liked),
    replies: c.replies.map((r) => toCommentDTO(r, uid, liked)),
  }))

  const nextCursor =
    hasMore
      ? sort === 'new'
        ? page[page.length - 1]?.id ?? null
        : String((Number(cursor) || 0) + PAGE)
      : null
  return { items, nextCursor }
}

export async function GET(request: Request) {
  const g = guardPublic(request, { limit: 120, windowMs: 60_000, bucket: 'comments-get' })
  if (!g.ok) return g.res

  const url = new URL(request.url)
  const postId = (url.searchParams.get('postId') ?? '').trim()
  const parentId = (url.searchParams.get('parentId') ?? '').trim()
  const cursor = (url.searchParams.get('cursor') ?? '').trim()
  const sort = url.searchParams.get('sort') === 'top' ? 'top' : 'new'
  if (!/^[a-zA-Z0-9_-]{6,40}$/.test(postId)) return err('postId required')
  if (parentId && !/^[a-zA-Z0-9_-]{6,40}$/.test(parentId)) return err('bad parentId')

  try {
    if (parentId) {
      // Ответы конкретного корня — публично, хронология
      return NextResponse.json(await listReplies(postId, parentId, cursor, g.uid))
    }
    return NextResponse.json(await listRoots(postId, sort, cursor, g.uid))
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
    const parentId = typeof body.parentId === 'string' ? body.parentId.trim() : ''
    if (!/^[a-zA-Z0-9_-]{6,40}$/.test(postId)) return err('postId required')
    if (parentId && !/^[a-zA-Z0-9_-]{6,40}$/.test(parentId)) return err('bad parentId')
    if (!text) return err('text required')
    if (text.length > MAX_LEN) return err(`максимум ${MAX_LEN} символов`, 413)

    const post = await db.post.findUnique({
      where: { id: postId },
      select: { id: true, channel: { select: { id: true, title: true, username: true, claimedById: true } } },
    })
    if (!post) return err('post not found', 404)

    // Ответ в ветку: родитель обязан быть из этого же поста; дерево плоское —
    // parentId всегда корень (ответ на ответ → replyToName автора ответа)
    let rootId: string | null = null
    let replyToUserId: string | null = null
    let replyToName: string | null = null
    if (parentId) {
      const parent = await db.comment.findUnique({
        where: { id: parentId },
        select: { id: true, postId: true, parentId: true, userId: true, user: { select: AUTHOR_SELECT } },
      })
      if (!parent || parent.postId !== postId) return err('parent not found', 404)
      rootId = parent.parentId ?? parent.id
      // Кому именно отвечаем: сам родитель (это может быть ответ в чужой ветке)
      replyToUserId = parent.userId
      replyToName = authorOf(parent.user).name
    }

    const created = await db.$transaction(async (tx) => {
      const c = await tx.comment.create({
        data: {
          postId,
          userId: g.uid,
          text,
          parentId: rootId,
          replyToUserId,
          replyToName,
        },
        include: { user: { select: AUTHOR_SELECT } },
      })
      // Денормализованный счётчик + пост «греется» от обсуждения (+5)
      const p = await tx.post.update({
        where: { id: postId },
        data: { commentsCount: { increment: 1 }, hotScore: { increment: 5 } },
        select: { commentsCount: true },
      })
      if (rootId) {
        await tx.comment.update({
          where: { id: rootId },
          data: { repliesCount: { increment: 1 } },
        })
      }
      return { c, commentsCount: p.commentsCount }
    })

    const dto: CommentDTO = {
      ...toCommentDTO(created.c, g.uid, new Set([created.c.id]), []),
      own: true,
      likedByMe: false,
    }

    /* ---- Уведомления (fire-and-forget) ---- */
    if (rootId && replyToUserId && replyToUserId !== g.uid) {
      // Ответ на чей-то комментарий — инбокс автора родителя
      const me = authorOf(created.c.user)
      notifyUser({
        userId: replyToUserId,
        type: 'reply',
        title: me.name,
        body: text,
        postId,
        channelUsername: post.channel.username,
      })
    }
    if (!rootId) {
      // Новый корневой комментарий — владельцу привязанного канала
      const ownerId = post.channel.claimedById
      if (ownerId && ownerId !== g.uid) {
        const me = authorOf(created.c.user)
        notifyUser({
          userId: ownerId,
          type: 'comment',
          title: post.channel.title,
          body: `${me.name}: ${text}`,
          postId,
          channelUsername: post.channel.username,
        })
      }
    }

    return NextResponse.json({ comment: dto, commentsCount: created.commentsCount })
  } catch (e) {
    console.error('[comments POST]', e)
    return err('comment failed', 500)
  }
}
