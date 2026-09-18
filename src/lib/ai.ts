import { db } from '@/lib/db'
import { chatSimple, chatStream } from '@/lib/openrouter'

/**
 * AI-помощники ленты: перевод постов и краткое содержание.
 *
 * Работают через OpenRouter (самая быстрая дешёвая модель) — доступны и в
 * песочнице, и на Vercel. Результаты кэшируются в БД (Post.translations /
 * Post.aiSummary), а 24/7-движок заранее прогревает их для свежих постов
 * (/api/warm) — пользователь получает перевод/саммари мгновенно.
 */

const MAX_TEXT = 4200 // покрывает ЛЮБОЙ пост Telegram (лимит 4096) целиком —
// раньше 1600 обрезали длинные лонгриды посреди предложения (жалоба «переводится не весь пост»)

const LANG_NAMES: Record<string, string> = {
  ru: 'русском',
  en: 'английском',
  uk: 'украинском',
  be: 'белорусском',
  kk: 'казахском',
  de: 'немецком',
  fr: 'французском',
  es: 'испанском',
  it: 'итальянском',
  tr: 'турецком',
  uz: 'узбекском',
  zh: 'китайском',
  ja: 'японском',
  ar: 'арабском',
  fa: 'персидском',
  pt: 'португальском',
  pl: 'польском',
}

export { LANG_NAMES }

/** Доля кириллицы в тексте: >15% считаем «уже на русском» */
export function cyrillicRatio(text: string): number {
  const letters = text.match(/[a-zA-Zа-яёА-ЯЁ]/g)
  if (!letters || letters.length < 8) return 1 // слишком мало букв — не переводим
  const cyr = text.match(/[а-яёА-ЯЁ]/g)
  return (cyr?.length ?? 0) / letters.length
}

const TRANSLATE_PROMPT = (langName: string) =>
  'Ты переводчик постов. Тебе дают текст поста из Telegram-канала. ' +
  `Переведи его на ${langName} языке. Сохрани форматирование поста: ` +
  '**жирный**, __курсив__, ~~зачёркнутый~~, `код`, ||спойлер||, > цитаты, ' +
  '[текст](ссылка), #хэштеги (хэштеги не переводи). Переносы строк сохрани. ' +
  'Ответь ТОЛЬКО переводом, без пояснений и кавычек вокруг.'

/** Перевод текста поста на язык (без кэша — кэшем управляет вызывающий код) */
export async function translateText(text: string, lang: string): Promise<string> {
  const langName = LANG_NAMES[lang] ?? lang
  const completion = await chatSimple(
    TRANSLATE_PROMPT(langName),
    text.slice(0, MAX_TEXT),
    { maxTokens: 2300, timeoutMs: 40_000 },
  )
  const translated = completion.replace(/^["«»"]+|["«»"]+$/g, '').trim()
  if (translated.length < 4 || translated === text) {
    throw new Error('перевод не удался')
  }
  return translated
}

/**
 * Перевод поста с кэшем в Post.translations ({lang: {text, at}}).
 * Возвращает null — переводить нечего (короткий/русский), ошибку — LLM недоступен.
 */
export async function translatePostCached(
  postId: string,
  lang = 'ru',
): Promise<{ ok: boolean; text?: string; cached?: boolean; reason?: string }> {
  const post = await db.post.findUnique({
    where: { id: postId },
    select: { id: true, text: true, translations: true },
  })
  if (!post) return { ok: false, reason: 'notfound' }

  const text = post.text.trim()
  if (text.length < 24) return { ok: false, reason: 'short' }
  if (cyrillicRatio(text) > 0.15) return { ok: false, reason: 'russian' }

  let cache: Record<string, { text: string; at: string }> = {}
  if (post.translations) {
    try {
      cache = JSON.parse(post.translations)
    } catch {
      cache = {}
    }
  }
  const hit = cache[lang]
  if (hit?.text) return { ok: true, text: hit.text, cached: true }

  const translated = await translateText(text, lang)
  cache[lang] = { text: translated, at: new Date().toISOString() }
  await db.post
    .update({ where: { id: postId }, data: { translations: JSON.stringify(cache) } })
    .catch(() => {})
  return { ok: true, text: translated, cached: false }
}

/**
 * СТРИМинговый перевод: дельты уходят в UI в реальном времени (первый токен
 * ~0.5–1с — «перевод за секунду»), полный текст возвращается вызывающему
 * для записи в кэш. Валидация та же, что у translateText.
 */
export async function streamTranslate(
  text: string,
  lang: string,
  onDelta: (chunk: string) => void,
): Promise<string> {
  const langName = LANG_NAMES[lang] ?? lang
  const raw = await chatStream(TRANSLATE_PROMPT(langName), text.slice(0, MAX_TEXT), {
    maxTokens: 2300,
    timeoutMs: 55_000,
    onDelta,
  })
  const translated = raw.replace(/^["«»"]+|["«»"]+$/g, '').trim()
  if (translated.length < 4 || translated === text) {
    throw new Error('перевод не удался')
  }
  return translated
}

/** Саммари: ровно 3 строками — построчный формат идеален для СТРИМИНГА
 *  (каждая строка появляется в панели сразу, как только дописана).
 *  Старый JSON-формат тоже принимается (parseBullets умеет оба). */
const SUMMARY_PROMPT =
  'Сделай выжимку текста поста ровно из 3 пунктов. КАЖДЫЙ пункт — ОБЯЗАТЕЛЬНО отдельной строкой ' +
  '(между пунктами перевод строки). Один пункт = одна законченная мысль, до 110 символов, ' +
  'по-русски, без эмодзи, без markdown, без нумерации и маркеров. ' +
  'Ответь только тремя строками, больше ничего.'

export function parseBullets(raw: string): string[] {
  try {
    const cleaned = raw
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim()
    const start = cleaned.indexOf('[')
    const end = cleaned.lastIndexOf(']')
    if (start !== -1 && end !== -1) {
      const arr = JSON.parse(cleaned.slice(start, end + 1))
      if (Array.isArray(arr)) {
        const items = arr.filter((x): x is string => typeof x === 'string' && x.length > 0)
        if (items.length > 0) return splitStickyParagraph(items).slice(0, 3)
      }
    }
  } catch {
    // fallback ниже
  }
  return splitStickyParagraph(
    raw
      .split('\n')
      .map((l) => l.replace(/^[\s\-\d.*•]+/, '').trim())
      .filter((l) => l.length > 8)
      .slice(0, 3),
  )
}

/** Модель склеила пункты в один абзац — делим по предложениям (до 3 штук) */
function splitStickyParagraph(items: string[]): string[] {
  if (items.length !== 1 || (items[0]?.length ?? 0) < 140) return items
  const parts = (items[0] ?? '')
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8)
    .slice(0, 3)
  return parts.length >= 2 ? parts : items
}

/** Саммари поста в 3 пунктах (с кэшем в Post.aiSummary). null — текст короткий */
export async function summarizePostCached(
  postId: string,
): Promise<{ items: string[]; cached: boolean; tooShort?: boolean } | null> {
  const post = await db.post.findUnique({
    where: { id: postId },
    select: { id: true, text: true, aiSummary: true },
  })
  if (!post) return null

  if (post.aiSummary) {
    try {
      const cached = JSON.parse(post.aiSummary)
      if (Array.isArray(cached) && cached.length > 0) {
        return { items: cached, cached: true }
      }
    } catch {
      // перегенерируем
    }
  }

  const text = post.text.trim()
  if (text.length < 200) return { items: [], cached: false, tooShort: true }

  // Экономия токенов: 1600 символов входа хватает на 3 пункта (дальше текст
  // повторяется), 160 на выход — ровно три коротких пункта без «воды»
  const raw = await chatSimple(SUMMARY_PROMPT, text.slice(0, 1600), {
    maxTokens: 160,
    timeoutMs: 20_000,
  })
  const items = parseBullets(raw)
  if (items.length === 0) return null

  await db.post
    .update({ where: { id: postId }, data: { aiSummary: JSON.stringify(items) } })
    .catch(() => {})
  return { items, cached: false }
}

/** Стриминговое саммари: дельты в UI, финальный текст парсится вызывающим */
export function streamSummary(
  text: string,
  onDelta: (chunk: string) => void,
): Promise<string> {
  return chatStream(SUMMARY_PROMPT, text.slice(0, 1600), {
    maxTokens: 160,
    timeoutMs: 24_000,
    onDelta,
  })
}

/** Извлекающий фолбэк: 1–3 первых длинных предложения текста (общий) */
export function extractiveSummary(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  const sentences = clean
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20)
  const picked: string[] = []
  for (const s of sentences) {
    picked.push(s.length > 120 ? s.slice(0, 117) + '…' : s)
    if (picked.length === 3) break
  }
  if (picked.length === 0 && clean.length > 20) {
    picked.push(clean.slice(0, 117) + (clean.length > 117 ? '…' : ''))
  }
  return picked
}
