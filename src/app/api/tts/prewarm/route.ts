import { NextResponse } from 'next/server'
import { cronAuthorized } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * POST /api/tts/prewarm — ЗАКРЫТО (v5.35).
 *
 * Раньше прогрев писал base64-аудио (мегабайты на пост) в Post.ttsAudio —
 * это раздувало Supabase (DB-размер + egress при каждом чтении). TTS больше
 * НЕ хранится в БД: /api/tts генерирует компактный Edge-MP3 по запросу
 * и кэширует в памяти. Эндпоинт оставлен как дешёвый no-op, чтобы legacy
 * движок 24/7 получал ok и не считал прогрев ошибкой.
 */
export async function POST(request: Request) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  return NextResponse.json({ ok: true, generated: 0, disabled: 'tts-db-cache-removed-v5.35' })
}
