import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'

export const dynamic = 'force-dynamic'

// Модерация — приватное действие; только админ-ключ (v5.48: раньше было
// guardAuth — любой юзер с Bearer-сессией мог одобрить/отклонить любой канал).
const bodySchema = z.object({
  channelId: z.string().min(1).max(64),
  action: z.enum(['approve', 'reject']),
})

/**
 * POST /api/admin/moderate { channelId, action: 'approve' | 'reject' }
 * Одобрить канал (status -> active, канал появится в каталоге и ленте)
 * или отклонить (status -> rejected). Лимит 30 запросов в минуту.
 */
export async function POST(request: Request) {
  const g = guardAdmin(request, { limit: 30, windowMs: 60_000, bucket: 'adm-mod' })
  if (!g.ok) return g.res

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('channelId and action (approve|reject) required')
    const { channelId, action } = parsed.data

    const status = action === 'approve' ? 'active' : 'rejected'
    const channel = await db.channel.update({
      where: { id: channelId },
      data: { status },
      select: { id: true, title: true, status: true },
    })

    return NextResponse.json({ ok: true, channel })
  } catch (e) {
    console.error('[admin/moderate]', e)
    return err('moderate failed', 500)
  }
}
