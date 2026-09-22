import { NextResponse } from 'next/server'
import { z } from 'zod'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { recordRead } from '@/lib/reading'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({ postId: z.string().min(1).max(64) })

/**
 * POST /api/reads { postId } — зачесть ПРОЧТЕНИЕ поста (v5.93).
 *
 * Вызывается из PostOverlay при открытии полного экрана (реальный интент
 * чтения, не скролл ленты). Дедуп «один пост в сутки на юзера» — в Redis
 * внутри recordRead, поэтому повторные вызовы безобидны и дёшевы.
 * Гости не пишутся (наград им не положено, экономим записи).
 */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 120, windowMs: 60_000, bucket: 'reads' })
  if (!g.ok) return g.res

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('postId required')
    if (g.uid.startsWith('guest_')) return NextResponse.json({ ok: true, counted: false })

    const r = await recordRead(g.uid, parsed.data.postId)
    return NextResponse.json({ ok: true, counted: r.counted, streak: r.streak })
  } catch (e) {
    console.error('[reads]', e)
    return err('reads failed', 500)
  }
}
