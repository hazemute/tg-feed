/**
 * Бесплатная генерация картинок для ИИ-ассистента (Snap Pro).
 *
 * Провайдер: pollinations.ai — открытый фри-эндпоинт (без ключей, работает
 * и на Vercel, и в песочнице): https://image.pollinations.ai/prompt/<prompt>
 * отдаёт JPEG по прямому URL. Мы НЕ храним картинку у себя: URL детерминирован
 * промптом+сидом, кэшируется CDN'ом pollinations. Если сервис недоступен —
 * публикация просто уходит без картинки (текст главнее).
 */

export function pollinationsImageUrl(prompt: string, seed?: number): string {
  const clean = prompt
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s,.\-!?]/gu, '')
    .trim()
    .slice(0, 400)
  const s = seed ?? Math.floor(Math.random() * 1_000_000)
  const params = new URLSearchParams({
    width: '1024',
    height: '1024',
    seed: String(s),
    nologo: '1',
    model: 'flux',
  })
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(clean)}?${params.toString()}`
}

/**
 * Проверить, что картинка реально отдалась (pollinations генерирует 10–40с
 * при холодном кэше). Таймаут 45с — быстрее всё равно не сгенерируется;
 * ошибка не роняет пост: ассистент отдаст текст без картинки.
 */
export async function verifyImageUrl(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(45_000),
    })
    return res.ok
  } catch {
    return false
  }
}

/* ============================ v5.21: OpenRouter-картинки ============================ *
 *  Генерация через image-модели OpenRouter (gemini «nano banana» → gpt-image-1),
 *  фолбэк — pollinations/flux. data-URL от модели сохраняется в Upload (base64
 *  в Postgres, публичный /api/upload/{id}) — Telegram Bot API принимает
 *  только реальные https-URL, поэтому для публикации нужен именно он.
 */

const PUBLIC_BASE = process.env.APP_URL?.replace(/\/$/, '') || 'https://tg-swipe.vercel.app'

/** Сохранить data-URL в хранилище картинок и вернуть публичный https-URL */
export async function storeDataImageUrl(dataUrl: string, ownerId: string): Promise<string | null> {
  const m = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/)
  if (!m) return null
  const mime = m[1]
  const base64 = m[2]
  const bytes = Math.floor((base64.length * 3) / 4)
  if (bytes > 8_000_000) return null // ≤8МБ — санити
  try {
    const { db } = await import('@/lib/db')
    const row = await db.upload.create({
      data: { ownerId, mime, data: base64, bytes, width: 0, height: 0 },
      select: { id: true },
    })
    return `${PUBLIC_BASE}/api/upload/${row.id}`
  } catch (e) {
    console.error('[ai-image/store]', e)
    return null
  }
}

export type ResolvedImage = {
  /** Публичный https-URL (для показа и публикации) */
  url: string | null
  via: 'openrouter' | 'pollinations'
  /** Не успела догенерироваться (pollinations) — можно публиковать без неё */
  pending: boolean
}

/**
 * Сгенерировать картинку и гарантированно вернуть публичный https-URL:
 * OpenRouter image-модели → data-URL → аплоад; иначе pollinations (URL
 * детерминирован, но догенерация асинхронная — pending=true).
 */
export async function generatePublicImage(prompt: string, ownerId: string): Promise<ResolvedImage> {
  const { generateImageOpenRouter } = await import('@/lib/openrouter')
  const gen = await generateImageOpenRouter(prompt).catch(() => null)
  if (gen?.url) {
    if (gen.url.startsWith('data:')) {
      const publicUrl = await storeDataImageUrl(gen.url, ownerId)
      if (publicUrl) return { url: publicUrl, via: 'openrouter', pending: false }
    } else if (gen.url.startsWith('https://')) {
      return { url: gen.url, via: 'openrouter', pending: false }
    }
  }
  // Фолбэк: бесплатный pollinations
  const poll = pollinationsImageUrl(`clean editorial illustration, high quality: ${prompt}`)
  const ok = await verifyImageUrl(poll).catch(() => false)
  return { url: poll, via: 'pollinations', pending: !ok }
}
