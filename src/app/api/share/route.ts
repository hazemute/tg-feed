import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  postId: z.string().min(1).max(64),
})

/**
 * POST /api/share { postId } — учёт репоста (кнопка «Поделиться»).
 *
 * Репост — самый сильный сигнал «температуры» поста: +20 (просмотр -1,
 * дочитывание 5с+ +3, лайк +10 — см. lib/rank.ts). Вызывается клиентом
 * fire-and-forget из sharePost(); ошибки тихие, на UX не влияет.
 */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 30, windowMs: 60_000, bucket: 'share' })
  if (!g.ok) return g.res

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('postId required')
    const { postId } = parsed.data

    const post = await db.post.findUnique({ where: { id: postId }, select: { id: true } })
    if (!post) return err('post not found', 404)

    await db.post.update({ where: { id: postId }, data: { hotScore: { increment: 20 } } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[share]', e)
    return err('share failed', 500)
  }
}
