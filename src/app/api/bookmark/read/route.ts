import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'

export const dynamic = 'force-dynamic'

// userId из тела игнорируется — пользователь берётся из Bearer-сессии.
const bodySchema = z.object({
  postId: z.string().min(1).max(64).optional(),
  all: z.boolean().optional(),
})

/**
 * POST /api/bookmark/read — отметка «прочитано» для сохранённых постов.
 * { postId } — один пост; { all: true } — все непрочитанные.
 */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'bookmark-read' })
  if (!g.ok) return g.res
  const userId = g.uid

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('postId required')
    const { postId, all } = parsed.data

    if (all) {
      const r = await db.bookmark.updateMany({
        where: { userId, readAt: null },
        data: { readAt: new Date() },
      })
      return NextResponse.json({ updated: r.count })
    }

    if (!postId) return err('postId required')

    await db.bookmark.updateMany({
      where: { userId, postId, readAt: null },
      data: { readAt: new Date() },
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[bookmark/read]', e)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
