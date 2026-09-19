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
