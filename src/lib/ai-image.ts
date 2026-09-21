/**
 * Бесплатная генерация картинок (принцип владельца, v5.33) — НОЛЬ РУБЛЕЙ.
 *
 * Принцип работы: не нужны ключи, токены и библиотеки. Бэкенд берёт текст
 * поста, переводит его суть на английский язык (та же единая бесплатная
 * модель z-ai/glm-5.3-flash:free) и делает обычный запрос к ссылке
 * https://image.pollinations.ai — сервер Pollinations сам генерирует
 * уникальную картинку и отдаёт её. Полностью бесплатно и без лимитов,
 * весь ИИ-контентщик (текст + визуал) стоит ноль рублей.
 *
 * Мы НЕ храним картинку у себя: URL детерминирован промптом+сидом и кэшируется
 * CDN'ом pollinations. Если сервис недоступен — публикация просто уходит без
 * картинки (текст главнее).
 */

import { chatSimple } from '@/lib/openrouter'

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

/* ====================== СУТЬ ТЕКСТА → АНГЛИЙСКИЙ ПРОМПТ ====================== */

/**
 * Перевести суть текста (любого языка) в ПОДРОБНЫЙ английский визуальный
 * промпт для pollinations (v5.34). Единая бесплатная модель (glm-5.3-flash:free).
 *
 * Принцип владельца: модель не просто переводит — она ПЕРЕСКАЗЫВАЕТ запрос
 * понятнее, чем объяснил пользователь: конкретный сюжет, окружение, стиль,
 * свет, палитра, композиция. Как попросил бы профессиональный арт-директор.
 *
 * Мини-кэш в памяти процесса: повторная генерация того же текста (ретрай
 * публикации) не тратит вызов LLM.
 */
const PROMPT_CACHE = new Map<string, string>()
const PROMPT_CACHE_MAX = 200

/** Качественные суффиксы для деградировавшего/короткого промпта */
const QUALITY_TAGS = 'high detail, clean composition, professional quality'

export async function enVisualPrompt(text: string): Promise<string> {
  const src = text.replace(/\s+/g, ' ').trim().slice(0, 1200)
  if (src.length < 8) return `clean minimal editorial illustration, soft lighting, ${QUALITY_TAGS}`

  const key = src.slice(0, 160)
  const hit = PROMPT_CACHE.get(key)
  if (hit) return hit

  try {
    const out = await chatSimple(
      [
        'You are a professional art director writing prompts for an image-generation model (Flux).',
        'The user gives you a post/topic in ANY language. Rewrite its ESSENCE as ONE detailed ENGLISH image prompt that is far clearer and richer than the source text.',
        '',
        'MANDATORY structure (fold into one flowing line, 45-90 words total):',
        '1. SUBJECT — the concrete main scene/objects with specific details (what exactly is shown, what is happening);',
        '2. SETTING — environment/background;',
        '3. STYLE — pick the best fit: photorealistic / editorial illustration / 3D render / flat vector / cinematic photo;',
        '4. LIGHTING — e.g. soft morning light, dramatic rim light, golden hour;',
        '5. COLOR PALETTE — 2-4 named colors;',
        '6. COMPOSITION/ANGLE — close-up / wide shot / top-down / rule of thirds;',
        '7. MOOD in one word.',
        '',
        'HARD RULES: English only; NO text, letters, captions or watermarks in the image; no quotes; no explanations; no lists; output ONLY the prompt line.',
      ].join('\n'),
      src,
      { maxTokens: 220, timeoutMs: 18_000, temperature: 0.55 },
    )
    // Модель могла вернуть пару строк — берём содержимое, чистим разметку
    const prompt = out
      .replace(/^["'\s]+|["'\s]+$/g, '')
      .replace(/^prompt\s*:\s*/i, '')
      .replace(/\s*\n+\s*/g, ', ')
      .slice(0, 420)
    if (prompt.length >= 30) {
      if (PROMPT_CACHE.size >= PROMPT_CACHE_MAX) {
        const first = PROMPT_CACHE.keys().next().value
        if (first !== undefined) PROMPT_CACHE.delete(first)
      }
      PROMPT_CACHE.set(key, prompt)
      return prompt
    }
  } catch {
    // LLM недоступен — фолбэк ниже
  }
  // Фолбэк: сырой текст (pollinations поймёт и не-английский) + стилевой каркас
  return `editorial illustration about: ${src.slice(0, 220)}, soft lighting, harmonious colors, ${QUALITY_TAGS}`
}

export type ResolvedImage = {
  /** Публичный https-URL (для показа и публикации) */
  url: string | null
  via: 'pollinations'
  /** Не успела догенерироваться — можно публиковать без неё */
  pending: boolean
}

/**
 * Сгенерировать бесплатную картинку и вернуть публичный https-URL:
 * суть текста → английский промпт (glm-5.3-flash:free) → pollinations/flux.
 * URL детерминирован, но догенерация асинхронная — pending=true, если сервис
 * ещё не успел отдать файл (клиент покажет картинку, когда она дозреет).
 */
export async function generatePublicImage(prompt: string): Promise<ResolvedImage> {
  const en = await enVisualPrompt(prompt).catch(() => prompt.slice(0, 220))
  const poll = pollinationsImageUrl(en)
  const ok = await verifyImageUrl(poll).catch(() => false)
  return { url: poll, via: 'pollinations', pending: !ok }
}
