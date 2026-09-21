import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { invalidatePersonalSignals } from '@/lib/feed'
import { clearUserPages } from '@/lib/page-cache'

export const dynamic = 'force-dynamic'

/**
 * «ПОЖАЛОВАТЬСЯ» НА ПОСТ (v5.68).
 *
 * POST /api/report { postId, reason } — reason: spam | ad | abuse | misinfo | other.
 * Одна жалоба на юзера×пост (unique). Денормализованный Post.reportsCount растёт —
 * агрегат ПО КАНАЛУ служит антирекламным сигналом ранжирования: канал, чьи посты
 * стабильно собирают жалобы, понижается в ленте (см. REPORT_PENALTY в lib/feed.ts).
 * Решения об удалении — людьми в админке, автоматика только понижает приоритет.
 */

const REASONS = ['spam', 'ad', 'abuse', 'misinfo', 'other'] as const
const bodySchema = z.object({
  postId: z.string().min(1).max(64),
  reason: z.enum(REASONS).catch('other'),
})

export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 20, windowMs: 60_000, bucket: 'report' })
  if (!g.ok) return g.res
  if (g.guest) return NextResponse.json({ error: 'login required', auth: true }, { status: 401 })

  const parsed = bodySchema.safeParse(await readJson(request))
  if (!parsed.success) return err('postId required')
  const { postId, reason } = parsed.data

  try {
    const post = await db.post.findUnique({
      where: { id: postId },
      select: { id: true, channelId: true, reportsCount: true },
    })
    if (!post) return err('post not found', 404)

    const created = await db.postReport
      .create({ data: { postId, userId: g.uid, reason } })
      .catch(() => null) // P2002 — уже жаловался
    if (!created) return NextResponse.json({ ok: true, already: true })

    await db.post.update({
      where: { id: postId },
      data: { reportsCount: { increment: 1 } },
      select: { id: true },
    })
    // Task 5-c: пожалованный пост исчезает из рекомендаций жаловавшегося сразу
    invalidatePersonalSignals(g.uid)
    // и из L0-кэша страниц — он отдаётся до свежих фильтров видимости
    clearUserPages(g.uid)
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[report]', e)
    return err('failed', 500)
  }
}
