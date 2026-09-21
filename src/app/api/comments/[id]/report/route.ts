import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { grantXp, XP_RULES } from '@/lib/xp'

export const dynamic = 'force-dynamic'

/**
 * «ПОЖАЛОВАТЬСЯ» НА КОММЕНТАРИЙ (v5.68).
 *
 * POST /api/comments/[id]/report { reason } — одна жалоба на юзера×комментарий.
 * 3+ УНИКАЛЬНЫХ жалобщика → комментарий автоматически скрывается (hidden=true):
 * демократическая модерация без ИИ — то, что трое назвали мусором, другие не видят.
 * Свой скрытый комментарий автор видит с пометкой (в рендере CommentsSheet).
 */

const REASONS = ['spam', 'ad', 'abuse', 'misinfo', 'other'] as const
/** Порог авто-скрытия по жалобам */
export const REPORT_HIDE_THRESHOLD = 3

const bodySchema = z.object({ reason: z.enum(REASONS).catch('other') })

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = guardAuth(request, { limit: 20, windowMs: 60_000, bucket: 'comment-report' })
  if (!g.ok) return g.res
  if (g.guest) return NextResponse.json({ error: 'login required', auth: true }, { status: 401 })

  const { id } = await ctx.params
  if (!id || id.length > 64 || id.startsWith('tmp_')) return err('bad comment id')

  const parsed = bodySchema.safeParse(await readJson(request))
  if (!parsed.success) return err('bad reason')
  const { reason } = parsed.data

  try {
    const comment = await db.comment.findUnique({
      where: { id },
      select: { id: true, hidden: true, reportsCount: true, userId: true },
    })
    if (!comment) return err('comment not found', 404)
    if (comment.userId === g.uid) return err('нельзя жаловаться на свой комментарий', 400)

    const created = await db.commentReport
      .create({ data: { commentId: id, userId: g.uid, reason } })
      .catch(() => null) // P2002 — уже жаловался
    if (!created) return NextResponse.json({ ok: true, already: true })

    const reportsCount = comment.reportsCount + 1
    const hide = reportsCount >= REPORT_HIDE_THRESHOLD
    await db.comment.update({
      where: { id },
      data: {
        reportsCount,
        ...(hide && !comment.hidden ? { hidden: true } : {}),
      },
      select: { id: true },
    })

    // v5.75: комментарий скрыт по жалобам сообщества — штраф XP автору.
    // Только при фактическом скрытии (не за каждый повторный репорт) и один раз.
    if (hide && !comment.hidden) {
      void grantXp(comment.userId, 'violation', XP_RULES.violationComment, 'Комментарий скрыт по жалобам')
    }

    return NextResponse.json({ ok: true, hidden: hide, reportsCount })
  } catch (e) {
    console.error('[comment report]', e)
    return err('failed', 500)
  }
}
