import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJson, err } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'
import { runParser } from '@/lib/parse-engine'
import { notifyNewPosts } from '@/lib/tg-bot'
import { runAiModeration, moderationStats } from '@/lib/ai-moderate'

export const dynamic = 'force-dynamic'
export const maxDuration = 60 // парсер/модерация могут идти дольше обычного запроса (важно для Vercel)

const schema = z.object({
  action: z.enum(['parse', 'ai-moderate']),
  perChannel: z.number().int().min(1).max(50).optional(),
  username: z.string().trim().max(64).optional(),
  all: z.boolean().optional(), // прогнать ВСЕ активные каналы (крупный сбор), не только первые 20
  deep: z.boolean().optional(), // углубляться в историю каналов (до 4 страниц ?before=)
  batches: z.number().int().min(0).max(8).optional(), // ai-moderate: пачек за прогон (0 — только статистика)
})

/**
 * POST /api/panel/tools { action: 'parse' | 'ai-moderate', ... }
 * Ручные инструменты админ-панели.
 *
 * parse — ручной запуск парсера (all=true — крупный прогон по всем каналам
 * с тайм-бюджетом 50с; если не успели — truncated=true, UI дообрабатывает).
 * ai-moderate — прогон бесплатной ИИ-модерации по свежим постам без вердикта
 * + статистика вердиктов за 7 дней.
 * Лимит: 15 запусков в 5 минут на IP.
 */
export async function POST(request: Request) {
  const g = guardAdmin(request, { limit: 15, windowMs: 5 * 60_000, bucket: 'panel-tools' })
  if (!g.ok) return g.res

  try {
    const parsed = schema.safeParse(await readJson(request))
    if (!parsed.success) {
      return err('action: parse (perChannel 1..50, username/all) | ai-moderate (batches 1..8)')
    }
    const { perChannel, username, all, deep, action } = parsed.data

    /* ---------- Бесплатная ИИ-модерация (ручной прогон / статистика) ---------- */
    if (action === 'ai-moderate') {
      const batches = parsed.data.batches ?? 0
      const stats = batches > 0 ? await runAiModeration(batches, 8) : null
      const weekly = await moderationStats(7).catch(() => [])
      return NextResponse.json({ ok: true, moderation: stats, weekly })
    }

    /* ---------- Парсер ---------- */
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
    return err('tools failed', 500)
  }
}
