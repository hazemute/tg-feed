import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'

export const dynamic = 'force-dynamic'

// userId из тела игнорируется — пользователь берётся из Bearer-сессии.
const bodySchema = z.object({
  postIds: z.array(z.string().min(1).max(64)).min(1).max(50),
})

/** POST /api/view { postIds: string[] } — учёт просмотров внутри Mini App */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 120, windowMs: 60_000, bucket: 'view' })
  if (!g.ok) return g.res
  const userId = g.uid

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('postIds required')
    const postIds = parsed.data.postIds

    let added = 0
    for (const postId of postIds) {
      const existing = await db.postView.findUnique({
        where: { userId_postId: { userId, postId } },
      })
      if (existing) continue
      try {
        await db.postView.create({ data: { userId, postId } })
        await db.post.update({ where: { id: postId }, data: { viewsCount: { increment: 1 } } })
        added++
      } catch {
        // гонка с параллельным запросом — пропускаем
      }
    }

    return NextResponse.json({ ok: true, added })
  } catch (e) {
    console.error('[view]', e)
    return err('view failed', 500)
  }
}
