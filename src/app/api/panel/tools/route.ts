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
  all: z.boolean().optional(), // прогнать ВСЕ активные каналы (крупный сбор), не только первые 20
  deep: z.boolean().optional(), // углубляться в историю каналов (до 4 страниц ?before=)
})

/**
 * POST /api/panel/tools { action: 'parse', perChannel?, username?, all? }
 * Ручной запуск парсера из локальной админ-панели.
 * all=true — крупный прогон по всем каналам (до 500) с тайм-бюджетом 50с:
 * если не успели — ответ truncated=true, дообработайте следующим запуском
 * (UI делает это автоматически).
 * Лимит: 15 запусков в 5 минут на IP.
 */
export async function POST(request: Request) {
  const g = guardAdmin(request, { limit: 15, windowMs: 5 * 60_000, bucket: 'panel-tools' })
  if (!g.ok) return g.res

  try {
    const parsed = schema.safeParse(await readJson(request))
    if (!parsed.success) return err('action: parse; perChannel 1..50; username/all опциональны')
    const { perChannel, username, all, deep } = parsed.data

    const deadline = all ? Date.now() + 50_000 : 0
    const result = await runParser(
      perChannel ?? 5,
      username || undefined,
      all ? 500 : 20,
      deadline,
      deep ? 4 : 1,
    )

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
        truncated: result.truncated ?? false,
        totalTargets: result.totalTargets ?? 0,
      },
    })
  } catch (e) {
    console.error('[panel/tools]', e)
    return err('parse failed', 500)
  }
}