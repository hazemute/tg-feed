import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { guardAdmin } from '@/lib/guard'
import { logAdmin } from '@/lib/admin-log'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/panel/tts-cleanup — одноразовая уборка legacy TTS-блобов.
 *
 * До v5.35 озвучка хранилась base64-блобом в Post.ttsAudio (до нескольких
 * МБ на пост) — это раздувало размер БД Supabase и egress при каждом
 * чтении. /api/tts больше НИКОГДА не выбирает ttsAudio (блобы не покидают
 * БД), поэтому столбец можно безопасно обнулить: аудио регенерируется
 * по запросу (Edge MP3 ≈ 6 КБ/с). Эндпоинт освобождает место в БД.
 *
 * Доступ: x-admin-key. Идемпотентно: повторный вызов → cleared: 0.
 */
export async function POST(request: Request) {
  const g = guardAdmin(request, { limit: 10, windowMs: 60_000, bucket: 'panel-tts-cleanup' })
  if (!g.ok) return g.res

  try {
    const r = await db.post.updateMany({
      where: { ttsAudio: { not: null } },
      data: { ttsAudio: null, ttsAt: null },
    })
    await logAdmin('tts-cleanup', 'posts.ttsAudio', { cleared: r.count })
    return NextResponse.json({ ok: true, cleared: r.count })
  } catch (e) {
    console.error('[panel/tts-cleanup]', e)
    return NextResponse.json({ error: 'cleanup failed' }, { status: 500 })
  }
}
