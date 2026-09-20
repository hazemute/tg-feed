import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { generateTts, getCachedTts, setCachedTts } from '@/lib/tts'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const bodySchema = z.object({
  postId: z.string().min(1).max(64),
})

/**
 * POST /api/tts { postId }
 *
 * Озвучка поста (кнопка «Слушать»).
 *
 * v5.35 — БЕЗ БД-БЛОБОВ: раньше аудио хранилось base64 в Post.ttsAudio
 * (мегабайты на пост) — прогрев-движок 24/7 писал их в Supabase, а каждый
 * тап тянул блоб из БД наружу. Это был главный жор egress. Теперь:
 *  - из БД читается ТОЛЬКО текст поста (блобы ttsAudio больше не
 *    выбираются никогда — старые блобы не покидают Supabase);
 *  - аудио генерируется по запросу (прод: Edge MP3 ≈ 6 КБ/с — 3 минуты
 *    речи ≈ 110 КБ; песочница: z-ai);
 *  - кэш — память инстанса (30 мин, до 8 постов) + сессионный кэш клиента
 *    (TTSButton) — повторы мгновенны и бесплатны.
 */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 6, windowMs: 60_000, bucket: 'tts' })
  if (!g.ok) return g.res

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('postId required')

    // Память инстанса: повторное включение в тёплой функции — мгновенно
    const mem = getCachedTts(parsed.data.postId)
    if (mem) return NextResponse.json({ ok: true, audio: mem, cached: true })

    const post = await db.post.findUnique({
      where: { id: parsed.data.postId },
      select: { id: true, text: true },
    })
    if (!post) return err('post not found', 404)

    const wav = await generateTts(post.text)
    if (!wav) return err('Озвучка не удалась, попробуйте позже', 502)

    const audio = wav.toString('base64')
    // Страховка от гигантских ответов (лимит ответа serverless ~4.5 МБ):
    // компактные прода-движки (Edge/Google MP3) в лимит не попадают
    if (audio.length > 3_500_000) {
      return err('Озвучка не удалась, попробуйте позже', 502)
    }

    setCachedTts(post.id, audio)
    return NextResponse.json({ ok: true, audio, cached: false })
  } catch (e) {
    console.error('[tts]', e)
    return err('Озвучка временно недоступна', 503)
  }
}
