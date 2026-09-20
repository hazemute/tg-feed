import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { POST_LIST_SELECT, postDTOFromRow } from '@/lib/dto'
import { guardAuth } from '@/lib/guard'
import type { PostDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

/** Элемент списка закладок: пост + отметка прочтения */
export type BookmarkItemDTO = PostDTO & { readAt: string | null }

/**
 * GET /api/bookmarks — сохранённые посты пользователя (с readAt).
 * Пользователь берётся из Bearer-сессии; лимит 60 запросов в минуту.
 * Выборка обрезана POST_LIST_SELECT (egress): раньше include тянул из Supabase
 * ttsAudio (base64 mp3)/translations/aiSummary всех 100 постов впустую.
 */
export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'bookmarks' })
  if (!g.ok) return g.res
  const userId = g.uid

  try {
    const bookmarks = await db.bookmark.findMany({
      where: { userId },
      select: { readAt: true, post: { select: POST_LIST_SELECT } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })

    const items: BookmarkItemDTO[] = bookmarks.map((b) => ({
      ...postDTOFromRow(b.post, { liked: false, bookmarked: true, subscribed: false }),
      readAt: b.readAt ? b.readAt.toISOString() : null,
    }))

    return NextResponse.json({ items })
  } catch (e) {
    console.error('[bookmarks]', e)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
