import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { generateTts } from '@/lib/tts'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const bodySchema = z.object({
  postId: z.string().min(1).max(64),
})

/**
 * POST /api/tts { postId }
 *
 * Озвучка поста (кнопка «Слушать»): текст поста читается голосом, результат
 * кэшируется в Post.ttsAudio — повторные включения мгновенны и не тратят квоту.
 * Движки: на Vercel первым идёт Google TTS, в песочнице — z-ai SDK;
 * упавший движок заменяется вторым. Кроме того движок 24/7 предпрогревает
 * кэш (/api/tts/prewarm) — большинство постов озвучены заранее.
 */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 6, windowMs: 60_000, bucket: 'tts' })
  if (!g.ok) return g.res

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('postId required')
    const post = await db.post.findUnique({
      where: { id: parsed.data.postId },
      select: { id: true, text: true, ttsAudio: true, ttsAt: true, publishedAt: true },
    })
    if (!post) return err('post not found', 404)

    // Кэш валиден, пока текст поста не менялся (парсер мог обновить разметку)
    if (post.ttsAudio && post.ttsAt && post.ttsAt > post.publishedAt) {
      return NextResponse.json({ ok: true, audio: post.ttsAudio, cached: true })
    }

    const wav = await generateTts(post.text)
    if (!wav) return err('Озвучка не удалась, попробуйте позже', 502)

    const audio = wav.toString('base64')

    await db.post
      .update({
        where: { id: post.id },
        data: { ttsAudio: audio, ttsAt: new Date() },
      })
      .catch(() => {})

    return NextResponse.json({ ok: true, audio, cached: false })
  } catch (e) {
    console.error('[tts]', e)
    return err('Озвучка временно недоступна', 503)
  }
}
