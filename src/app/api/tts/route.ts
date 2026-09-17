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
const CHUNK_ZAI = 950
const CHUNK_EXT = 470

/** Текст → куски по предложениям (лимит TTS-движка на длину входа) */
function splitChunks(text: string, max: number): string[] {
  const sentences = text.match(/[^.!?…]+[.!?…]+[\s)]*|[^.!?…]+$/g) ?? [text]
  const chunks: string[] = []
  let cur = ''
  for (const s of sentences) {
    if ((cur + s).length <= max) {
      cur += s
    } else {
      if (cur.trim()) chunks.push(cur.trim())
      cur = s.length > max ? s.slice(0, max) : s
    }
  }
  if (cur.trim()) chunks.push(cur.trim())
  return chunks
}

/** Доля кириллицы: выбор голоса внешнего движка (Tatyana/Brian) */
function cyrillicShare(text: string): number {
  const letters = text.match(/[a-zA-Zа-яёА-ЯЁ]/g)
  if (!letters || letters.length === 0) return 1
  const cyr = text.match(/[а-яёА-ЯЁ]/g)
  return (cyr?.length ?? 0) / letters.length
}

/**
 * Движок 1: z-ai-web-dev-sdk (PCM 24 кГц → собираем WAV).
 * Работает в песочнице; на Vercel SDK недоступен (падает при создании) —
 * поэтому там он вторичен, первым идёт внешний движок.
 */
async function ttsZai(plain: string): Promise<Buffer | null> {
  try {
    const zai = await ZAI.create()
    const chunks = splitChunks(plain, CHUNK_ZAI).slice(0, 4) // максимум 4 вызова на пост
    if (chunks.length === 0) return null
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
    if (parts.length === 0) return null

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
    return Buffer.concat([header, pcm])
  } catch {
    return null
  }
}

/**
 * Движок 2: внешний TTS (Amazon Polly голоса через StreamElements, без ключа).
 * Работает отовсюду, включая Vercel; отдаёт MP3 — куски просто склеиваются.
 */
async function ttsExternal(plain: string): Promise<Buffer | null> {
  const ru = cyrillicShare(plain) >= 0.3
  const chunks = splitChunks(plain, CHUNK_EXT).slice(0, 6)
  if (chunks.length === 0) return null
  const parts: Buffer[] = []
  for (const chunk of chunks) {
    try {
      const res = await fetch(
        `https://api.streamelements.com/kappa/v2/speech?voice=${ru ? 'Tatyana' : 'Brian'}&text=${encodeURIComponent(chunk)}`,
        {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TgSwipe/1.0)' },
          signal: AbortSignal.timeout(12_000),
        },
      )
      if (!res.ok) return null
      const buf = Buffer.from(new Uint8Array(await res.arrayBuffer()))
      if (buf.length === 0) return null
      parts.push(buf)
    } catch {
      return null
    }
  }
  return parts.length > 0 ? Buffer.concat(parts) : null
}

/**
 * POST /api/tts { postId }
 *
 * Озвучка поста (кнопка «Слушать»): текст поста читается голосом, результат
 * кэшируется в Post.ttsAudio — повторные включения мгновенны и не тратят квоту.
 * Движки: на Vercel первым идёт внешний (Polly), в песочнице — z-ai SDK;
 * упавший движок заменяется вторым, полностью отказоустойчиво.
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

    // Порядок движков: на Vercel z-ai SDK недоступен — сразу внешний; иначе наоборот
    const onVercel = process.env.VERCEL === '1'
    const wav = onVercel
      ? (await ttsExternal(plain)) ?? (await ttsZai(plain))
      : (await ttsZai(plain)) ?? (await ttsExternal(plain))
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
