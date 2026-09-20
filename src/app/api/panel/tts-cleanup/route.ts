import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { guardAdmin } from '@/lib/guard'
import { logAdmin } from '@/lib/admin-log'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/panel/tts-cleanup — уборка legacy TTS-блобов (батчами).
 *
 * До v5.35 озвучка хранилась base64-блобом в Post.ttsAudio (мегабайты на
 * пост) — раздувало БД Supabase и egress. /api/tts больше НЕ выбирает
 * ttsAudio, поэтому столбец безопасно обнулить: аудио регенерируется
 * по запросу (Edge MP3 ≈ 6 КБ/с).
 *
 * Один updateMany по всем строкам не влезает в 60с лимит функции (переписывание
 * мегабайтных TOAST-строк), поэтому чистим БАТЧАМИ с бюджетом ~20с на вызов:
 * эндпоинт идемпотентный — вызывайте повторно, пока { done: true }.
 *
 * Доступ: x-admin-key.
 */
const BATCH = 8
const BUDGET_MS = 20_000

export async function POST(request: Request) {
  const g = guardAdmin(request, { limit: 30, windowMs: 60_000, bucket: 'panel-tts-cleanup' })
  if (!g.ok) return g.res

  try {
    const t0 = Date.now()
    let cleared = 0
    let lastBatch = 0

    for (;;) {
      // select только id: проверка IS NOT NULL не тянет сам блоб из TOAST
      const rows = await db.post.findMany({
        where: { ttsAudio: { not: null } },
        select: { id: true },
        take: BATCH,
        orderBy: { id: 'asc' },
      })
      lastBatch = rows.length
      if (lastBatch === 0) break
      await db.post.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { ttsAudio: null, ttsAt: null },
      })
      cleared += lastBatch
      if (Date.now() - t0 > BUDGET_MS) break
    }

    const done = lastBatch < BATCH
    await logAdmin('tts-cleanup', 'posts.ttsAudio', { cleared, done })
    return NextResponse.json({ ok: true, cleared, done })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[panel/tts-cleanup]', msg)
    return NextResponse.json({ error: 'cleanup failed', detail: msg.slice(0, 200) }, { status: 500 })
  }
}
