import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'

export const dynamic = 'force-dynamic'

// userId из тела игнорируется — пользователь берётся из Bearer-сессии.
const bodySchema = z.object({
  channelId: z.string().min(1).max(64),
  hidden: z.boolean().catch(false),
})

/** POST /api/subscription/visibility { channelId, hidden } — скрыть/показать канал в ленте */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'visibility' })
  if (!g.ok) return g.res
  const userId = g.uid

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('channelId required')
    const { channelId, hidden } = parsed.data

    const result = await db.subscription.updateMany({
      where: { userId, channelId },
      data: { hidden },
    })
    if (result.count === 0) return err('subscription not found', 404)

    return NextResponse.json({ ok: true, hidden })
  } catch (e) {
    console.error('[subscription/visibility]', e)
    return err('failed', 500)
  }
}
