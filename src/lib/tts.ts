import ZAI from 'z-ai-web-dev-sdk'
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import { stripMarkdown } from '@/lib/markdown'

/**
 * TTS-движки озвучки постов (кнопка «Слушать»).
 *
 * Три движка с взаимным фолбэком:
 *  - z-ai-web-dev-sdk — работает в песочнице (конфиг /etc/.z-ai-config),
 *    на Vercel недоступен (файла конфига нет);
 *  - Microsoft Edge TTS — без ключа, отличная русская речь (MP3 24 кГц),
 *    работает и из датацентров Vercel — ОСНОВНОЙ движок прода;
 *  - Google Translate TTS — без ключа, но IP датацентров Vercel часто
 *    забанены Google — последний фолбэк.
 *
 * Порядок определяется по process.env.VERCEL. Результат кэшируется вызывающим
 * кодом в Post.ttsAudio (base64; клиент определяет формат по содержимому).
 */

/** Лимит озвучки: ~3 минуты речи */
const MAX_CHARS = 2400
const CHUNK_ZAI = 950
const CHUNK_EDGE = 800

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

/** Доля кириллицы: выбор языка Google TTS */
function cyrillicShare(text: string): number {
  const letters = text.match(/[a-zA-Zа-яёА-ЯЁ]/g)
  if (!letters || letters.length === 0) return 1
  const cyr = text.match(/[а-яёА-ЯЁ]/g)
  return (cyr?.length ?? 0) / letters.length
}

/**
 * Движок 1: z-ai-web-dev-sdk (PCM 24 кГц → собираем WAV).
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
 * Движок 2: Microsoft Edge TTS (без ключа, MP3 24 кГц/48 кбит — трёхминутный
 * пост ≈ 100-200 КБ base64, без проблем с лимитами ответов Vercel).
 * Нейроголос умеет паузы и ударения — звучит заметно лучше Google.
 */
async function ttsEdge(plain: string): Promise<Buffer | null> {
  const ru = cyrillicShare(plain) >= 0.3
  const voice = ru ? 'ru-RU-SvetlanaNeural' : 'en-US-AriaNeural'
  const chunks = splitChunks(plain, CHUNK_EDGE).slice(0, 6)
  if (chunks.length === 0) return null
  try {
    const tts = new MsEdgeTTS()
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
    const parts: Buffer[] = []
    for (const chunk of chunks) {
      const readable = tts.toStream(chunk, { pitch: '+0Hz', rate: 1.0, volume: 100 })
      const bufs: Buffer[] = []
      for await (const c of readable.audioStream) bufs.push(Buffer.from(c))
      const buf = Buffer.concat(bufs)
      if (buf.length === 0) return null
      parts.push(buf)
    }
    return parts.length > 0 ? Buffer.concat(parts) : null
  } catch {
    return null
  }
}

/**
 * Движок 3: Google Translate TTS (без ключа, MP3; лимит ~200 символов на запрос).
 * Работает из датацентров Vercel (браузерный UA обязателен); куски склеиваются —
 * MP3-фреймы конкатенируются корректно для всех популярных плееров.
 */
async function ttsGoogle(plain: string): Promise<Buffer | null> {
  const ru = cyrillicShare(plain) >= 0.3
  const chunks = splitChunks(plain, 190).slice(0, 10)
  if (chunks.length === 0) return null
  const parts: Buffer[] = []
  for (const chunk of chunks) {
    try {
      const res = await fetch(
        `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&ttsspeed=1&tl=${ru ? 'ru' : 'en'}&q=${encodeURIComponent(chunk)}`,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            Referer: 'https://translate.google.com/',
          },
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

/** Чистый текст поста для диктора (без markdown, ссылок и хэштег-мусора) */
export function ttsPlainOf(text: string): string {
  return stripMarkdown(text)
    .replace(/https?:\/\/\S+/g, 'ссылка в описании')
    .replace(/#{1,3}\s/g, '')
    .trim()
}

/** Генерация озвучки тремя движками по порядку (порядок зависит от окружения) */
export async function generateTts(postText: string): Promise<Buffer | null> {
  const plain = ttsPlainOf(postText)
  if (plain.length < 12) return null
  const capped = plain.slice(0, MAX_CHARS)
  const onVercel = process.env.VERCEL === '1'
  return onVercel
    ? (await ttsEdge(capped)) ?? (await ttsGoogle(capped)) ?? (await ttsZai(capped))
    : (await ttsZai(capped)) ?? (await ttsEdge(capped)) ?? (await ttsGoogle(capped))
}
