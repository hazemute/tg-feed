import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJson, err } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'
import { runParser } from '@/lib/parse-engine'
import { notifyNewPosts } from '@/lib/tg-bot'

export const dynamic = 'force-dynamic'
export const maxDuration = 60 // парсер может идти дольше обычного запроса (важно для Vercel)

const schema = z.object({
  action: z.literal('parse'),
  perChannel: z.number().int().min(1).max(50).optional(),
  username: z.string().trim().max(64).optional(),
})

/**
 * POST /api/panel/tools { action: 'parse', perChannel?, username? }
 * Ручной запуск парсера из локальной админ-панели.
 * Лимит: 3 запуска в 5 минут на IP (как у кнопки в приложении).
 */
export async function POST(request: Request) {
  const g = guardAdmin(request, { limit: 3, windowMs: 5 * 60_000, bucket: 'panel-tools' })
  if (!g.ok) return g.res

  try {
    const parsed = schema.safeParse(await readJson(request))
    if (!parsed.success) return err('action: parse; perChannel 1..50; username опционален')
    const { perChannel, username } = parsed.data

    const result = await runParser(perChannel ?? 5, username || undefined)

    let notified = { sent: 0, failed: 0, recipients: 0 }
    try {
      notified = await notifyNewPosts(result.newPosts)
    } catch (e) {
      console.error('[panel/tools] notify failed', e)
    }

    return NextResponse.json({
      ok: true,
      result: {
        ok: true,
        results: result.results,
        newPostsCount: result.newPosts.length,
        notified,
      },
    })
  } catch (e) {
    console.error('[panel/tools]', e)
    return err('parse failed', 500)
  }
}