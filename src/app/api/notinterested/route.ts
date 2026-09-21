import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * «НЕ ИНТЕРЕСНО» НА УРОВНЕ ПОСТА (v5.68 — замена мьюту всего канала).
 *
 * POST   /api/notinterested { postId }    — скрыть конкретный пост
 * DELETE /api/notinterested { postId }    — «Вернуть» (отмена)
 *
 * Эффекты:
 *  • пост исчезает из персональной ленты (фильтр по PostHide в /api/feed);
 *  • КАНАЛ остаётся в ленте и рекомендациях — мьют не ставится;
 *  • категория поста получает отрицательный сигнал аффинити (понижение
 *    приоритета похожих постов, см. PersonalSignals.dislikeCategories в lib/feed.ts).
 */

const bodySchema = z.object({ postId: z.string().min(1).max(64) })

export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'notinterested' })
  if (!g.ok) return g.res
  if (g.guest) return NextResponse.json({ error: 'login required', auth: true }, { status: 401 })

  const parsed = bodySchema.safeParse(await readJson(request))
  if (!parsed.success) return err('postId required')
  const { postId } = parsed.data

  try {
    const post = await db.post.findUnique({
      where: { id: postId },
      select: { id: true, channel: { select: { categoryId: true } } },
    })
    if (!post) return err('post not found', 404)

    // upsert — двойной тап не роняет
    await db.postHide.upsert({
      where: { userId_postId: { userId: g.uid, postId } },
      update: {},
      create: { userId: g.uid, postId },
    })
    return NextResponse.json({ ok: true, categoryId: post.channel.categoryId })
  } catch (e) {
    console.error('[notinterested POST]', e)
    return err('failed', 500)
  }
}

export async function DELETE(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'notinterested' })
  if (!g.ok) return g.res

  const parsed = bodySchema.safeParse(await readJson(request))
  if (!parsed.success) return err('postId required')

  try {
    await db.postHide.deleteMany({ where: { userId: g.uid, postId: parsed.data.postId } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[notinterested DELETE]', e)
    return err('failed', 500)
  }
}
