import { db } from '@/lib/db'
import { chatSimple } from '@/lib/openrouter'

/**
 * AI-помощники ленты: перевод постов и краткое содержание.
 *
 * Работают через OpenRouter (самая быстрая дешёвая модель) — доступны и в
 * песочнице, и на Vercel. Результаты кэшируются в БД (Post.translations /
 * Post.aiSummary), а 24/7-движок заранее прогревает их для свежих постов
 * (/api/warm) — пользователь получает перевод/саммари мгновенно.
 */

const MAX_TEXT = 3500

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
    { maxTokens: 1500, timeoutMs: 18_000 },
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

const SUMMARY_PROMPT =
  'Ты редактор Telegram-канала. Тебе дают текст поста на русском языке. ' +
  'Сделай выжимку ровно из 3 пунктов: каждый — одна законченная мысль до 120 символов, ' +
  'по-русски, без эмодзи и без markdown. ' +
  'Ответь СТРОГО JSON-массивом из 3 строк, например: ["пункт 1","пункт 2","пункт 3"]'

function parseBullets(raw: string): string[] {
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
        if (items.length > 0) return items.slice(0, 3)
      }
    }
  } catch {
    // fallback ниже
  }
  return raw
    .split('\n')
    .map((l) => l.replace(/^[\s\-\d.*•]+/, '').trim())
    .filter((l) => l.length > 8)
    .slice(0, 3)
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

  const raw = await chatSimple(SUMMARY_PROMPT, text.slice(0, 4000), {
    maxTokens: 400,
    timeoutMs: 20_000,
  })
  const items = parseBullets(raw)
  if (items.length === 0) return null

  await db.post
    .update({ where: { id: postId }, data: { aiSummary: JSON.stringify(items) } })
    .catch(() => {})
  return { items, cached: false }
}
