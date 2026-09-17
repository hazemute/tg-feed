import { NextResponse } from 'next/server'
import { z } from 'zod'
import ZAI from 'z-ai-web-dev-sdk'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { stripMarkdown } from '@/lib/markdown'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const bodySchema = z.object({
  postId: z.string().min(1).max(64),
})

/** Лимит озвучки: ~3 минуты речи (TTS принимает до 1024 символов за вызов) */
const MAX_CHARS = 2400
const CHUNK = 950

/** Текст → куски по предложениям (лимит TTS 1024 символа на вызов) */
function splitChunks(text: string): string[] {
  const sentences = text.match(/[^.!?…]+[.!?…]+[\s)]*|[^.!?…]+$/g) ?? [text]
  const chunks: string[] = []
  let cur = ''
  for (const s of sentences) {
    if ((cur + s).length <= CHUNK) {
      cur += s
    } else {
      if (cur.trim()) chunks.push(cur.trim())
      cur = s.length > CHUNK ? s.slice(0, CHUNK) : s
    }
  }
  if (cur.trim()) chunks.push(cur.trim())
  return chunks.slice(0, 4) // максимум 4 вызова на пост
}

/**
 * POST /api/tts { postId }
 *
 * Озвучка поста (кнопка «Слушать»): текст поста читается голосом
 * (z-ai-web-dev-sdk, PCM 24 кГц → собираем WAV), результат кэшируется
 * в Post.ttsAudio — повторные включения мгновенны и не тратят квоту TTS.
 * Лимит 6 генераций в минуту (кэш-попадания лимитом не считаются).
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

    // Чистый текст для диктора: без markdown-маркеров, ссылок и хэштег-мусора
    const plain = stripMarkdown(post.text)
      .replace(/https?:\/\/\S+/g, 'ссылка в описании')
      .replace(/#{1,3}\s/g, '')
      .trim()
    if (plain.length < 12) return NextResponse.json({ ok: false, reason: 'short' })

    const chunks = splitChunks(plain.slice(0, MAX_CHARS))
    if (chunks.length === 0) return NextResponse.json({ ok: false, reason: 'short' })

    const zai = await ZAI.create()
    const parts: Buffer[] = []
    for (const chunk of chunks) {
      const response = await zai.audio.tts.create({
        input: chunk,
        voice: 'tongtong',
        speed: 1.0,
        response_format: 'pcm', // сырые сэмплы 24кГц/16бит/моно — склеиваются без артефактов
        stream: false,
      })
      const buf = Buffer.from(new Uint8Array(await response.arrayBuffer()))
      if (buf.length > 0) parts.push(buf)
    }
    if (parts.length === 0) return err('Озвучка не удалась, попробуйте позже', 502)

    // Собираем один WAV: заголовок + склеенные PCM-сэмплы (24 кГц, 16 бит, моно)
    const pcm = Buffer.concat(parts)
    const header = Buffer.alloc(44)
    header.write('RIFF', 0)
    header.writeUInt32LE(36 + pcm.length, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16) // размер fmt-чанка
    header.writeUInt16LE(1, 20) // PCM
    header.writeUInt16LE(1, 22) // моно
    header.writeUInt32LE(24000, 24) // sample rate
    header.writeUInt32LE(48000, 28) // byte rate = 24000 × 2
    header.writeUInt16LE(2, 32) // block align
    header.writeUInt16LE(16, 34) // bits per sample
    header.write('data', 36)
    header.writeUInt32LE(pcm.length, 40)
    const wav = Buffer.concat([header, pcm])
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
