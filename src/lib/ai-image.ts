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
 * v5.70: картинка НЕ отдаётся клиенту сырой pollinations-ссылкой (10–40с
 * генерации при холодном кэше, белая страница по клику, домен недоступен
 * из части регионов). После генерации байты скачиваются сервером, сжимаются
 * sharp'ом в визуально безпотерьный WebP (≤350КБ — лимит таблицы Upload)
 * и сохраняются в БД → стабильный вечный URL /api/upload/<id> (immutable,
 * раздаётся нашим доменом и в TG WebView, и Telegram-ботом при публикации).
 * Сырая ссылка pollinations остаётся только фолбэком, если скачивание не
 * удалось — чат в этом случае ведёт себя по-старому и не роняется.
 */

import sharp from 'sharp'
import { db } from '@/lib/db'
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

/* ====================== СКАЧИВАНИЕ + СЖАТИЕ + ХРАНЕНИЕ (v5.70) ====================== */

export type ResolvedImage = {
  /** URL для показа и публикации: наш /api/upload/<id> либо фолбэк-pollinations */
  url: string | null
  via: 'upload' | 'pollinations'
  /** Не успела догенерироваться — можно публиковать без неё */
  pending: boolean
}

/** Лимит бинарника: POST /api/upload принимает ~350КБ (base64 ≤ 480К символов) */
const UPLOAD_BINARY_LIMIT = 340_000
/** Ниже q80 не опускаемся — приказ владельца про качество */
const WEBP_QUALITIES = [90, 85, 80]

/** Детерминированный сид из промпта: тот же текст → та же картинка → кэш работает.
 *  Экспорт — для отладочных скриптов (воспроизвести точный pollinations-URL). */
export function seedFromPrompt(en: string): number {
  let h = 2166136261
  for (let i = 0; i < en.length; i++) {
    h ^= en.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h) % 1_000_000
}

/** Кэш готовых результатов (по детерминированному pollinations-URL = промпт+сид) */
const STORED_CACHE = new Map<string, ResolvedImage>()
const STORED_CACHE_MAX = 120

function cachePut(key: string, value: ResolvedImage): void {
  if (STORED_CACHE.size >= STORED_CACHE_MAX) {
    const first = STORED_CACHE.keys().next().value
    if (first !== undefined) STORED_CACHE.delete(first)
  }
  STORED_CACHE.set(key, value)
}

/**
 * Скачать байты готовой картинки с pollinations, сжать sharp'ом в WebP
 * (визуально без потерь: max 1024×1024 без апскейла, q90→85→80, effort 6,
 * smartSubsample) и сохранить в таблицу Upload (base64) → /api/upload/<id>.
 * null — скачать/сжать/сохранить не удалось (вызывающий уйдёт в фолбэк).
 */
async function storeImageFromPollinations(
  pollUrl: string,
  ownerId: string | undefined,
): Promise<{ url: string; bytes: number } | null> {
  if (!ownerId) return null
  try {
    // 1) Скачиваем готовые байты (генерация на стороне pollinations уже
    //    завершилась после verifyImageUrl; холодный кэш — до 60с)
    const res = await fetch(pollUrl, { signal: AbortSignal.timeout(60_000) })
    if (!res.ok) return null
    const ct = (res.headers.get('content-type') ?? '').toLowerCase()
    if (ct && !ct.startsWith('image/')) return null
    const src = Buffer.from(await res.arrayBuffer())
    if (src.length < 1024) return null

    // 2) Ресайз до max 1024×1024 (без апскейла) + EXIF-поворот
    const resized = await sharp(src, { failOn: 'none' })
      .rotate()
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .toBuffer()
    const meta = await sharp(resized).metadata()
    const width = meta.width ?? 0
    const height = meta.height ?? 0

    // 3) WebP-ступени качества: 90 → 85 → 80 (ниже не опускаемся)
    let best: Buffer | null = null
    for (const q of WEBP_QUALITIES) {
      const buf = await sharp(resized)
        .webp({ quality: q, effort: 6, smartSubsample: true })
        .toBuffer()
      best = buf
      if (buf.length <= UPLOAD_BINARY_LIMIT) break
    }
    if (!best || best.length > UPLOAD_BINARY_LIMIT) return null

    // 4) Прямая запись в таблицу Upload (мы на сервере — свой HTTP дёргать незачем)
    const up = await db.upload.create({
      data: {
        ownerId,
        mime: 'image/webp',
        data: best.toString('base64'),
        bytes: best.length,
        width,
        height,
      },
      select: { id: true },
    })
    return { url: `/api/upload/${up.id}`, bytes: best.length }
  } catch {
    // pollinations не отдал байты / sharp упал / БД недоступна — фолбэк
    return null
  }
}

/**
 * Сгенерировать бесплатную картинку и вернуть URL для клиента:
 * суть текста → английский промпт (glm-5.3-flash:free) → pollinations/flux
 * → скачивание → WebP ≤350КБ → Upload → стабильный /api/upload/<id>.
 *
 * Сид детерминирован промптом: повторный запрос того же текста возвращается
 * из кэша процесса мгновенно и не генерируется заново.
 *
 * ВАЖНО: проверка готовности — сам GET-скачивание (до 60с, генерация на
 * стороне pollinations идёт 10–40с при холодном кэше). HEAD у pollinations
 * ненадёжен (на холодном URL отдаёт 500 при живом GET) — поэтому сначала
 * качаем байты, и только если не вышло, отличаем «ещё рисуется» (pending)
 * от «сервис лежит» по контрольному HEAD. Фолбэк при любом сбое хранения —
 * прежнее поведение (ссылка pollinations / pending), чат не роняем.
 */
export async function generatePublicImage(
  prompt: string,
  opts?: { ownerId?: string },
): Promise<ResolvedImage> {
  const en = await enVisualPrompt(prompt).catch(() => prompt.slice(0, 220))
  const poll = pollinationsImageUrl(en, seedFromPrompt(en))

  const cached = STORED_CACHE.get(poll)
  if (cached) return cached

  // 1) Основной путь: скачиваем готовые байты и сохраняем к себе
  const stored = await storeImageFromPollinations(poll, opts?.ownerId)
  if (stored) {
    const result: ResolvedImage = { url: stored.url, via: 'upload', pending: false }
    cachePut(poll, result)
    return result
  }

  // 2) Скачивание не удалось — HEAD подскажет, жив ли файл вообще
  const ok = await verifyImageUrl(poll).catch(() => false)
  if (ok) {
    // Файл есть (доступен), но скачать/сохранить не вышло — сырая ссылка
    const fallback: ResolvedImage = { url: poll, via: 'pollinations', pending: false }
    cachePut(poll, fallback)
    return fallback
  }

  // 3) Ещё рисуется (или сервис лежит) — pending-фолбэк, НЕ кэшируем:
  //    следующий запрос попробует скачать и сохраниться снова
  return { url: poll, via: 'pollinations', pending: true }
}
