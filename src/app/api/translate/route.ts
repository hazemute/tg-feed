import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { chatSimple, openRouterEnabled } from '@/lib/openrouter'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  postId: z.string().min(1).max(64),
  /** Целевой язык (ISO 639-1). По умолчанию — родной язык пользователя, иначе русский */
  lang: z.string().min(2).max(5).optional(),
})

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

/**
 * POST /api/translate { postId, lang? }
 *
 * Перевод поста на родной язык читателя (как в Twitter: кнопка «Перевести»
 * под постом). Вызов самой дешёвой модели OpenRouter; результат кэшируется
 * в Post.translations ({lang: {text, at}}) — нейросеть вызывается один раз
 * на пару (пост, язык). Лимит 12 запросов в минуту.
 */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 12, windowMs: 60_000, bucket: 'translate' })
  if (!g.ok) return g.res

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('postId required')
    const { postId } = parsed.data

    const post = await db.post.findUnique({ where: { id: postId } })
    if (!post) return err('post not found', 404)

    const text = post.text.trim()
    if (text.length < 24) {
      return NextResponse.json({ ok: false, reason: 'short' }, { status: 200 })
    }
    // Уже на русском (или почти) — переводить нечего
    if (cyrillicRatio(text) > 0.15) {
      return NextResponse.json({ ok: false, reason: 'russian' }, { status: 200 })
    }

    // Целевой язык: параметр → язык клиента Telegram → русский
    const user = await db.user.findUnique({ where: { id: g.uid } })
    const lang = (parsed.data.lang ?? user?.languageCode ?? 'ru').slice(0, 2).toLowerCase()
    const langName = LANG_NAMES[lang] ?? lang

    // Кэш переводов
    let cache: Record<string, { text: string; at: string }> = {}
    if (post.translations) {
      try {
        cache = JSON.parse(post.translations)
      } catch {
        cache = {}
      }
    }
    const hit = cache[lang]
    if (hit?.text) {
      return NextResponse.json({ ok: true, text: hit.text, lang, cached: true })
    }

    if (!openRouterEnabled()) {
      return err('translation temporarily unavailable', 503)
    }

    const completion = await chatSimple(
      'Ты переводчик постов. Тебе дают текст поста из Telegram-канала. ' +
        `Переведи его на ${langName} языке. Сохрани форматирование поста: ` +
        '**жирный**, __курсив__, ~~зачёркнутый~~, `код`, ||спойлер||, > цитаты, ' +
        '[текст](ссылка), #хэштеги (хэштеги не переводи). Переносы строк сохрани. ' +
        'Ответь ТОЛЬКО переводом, без пояснений и кавычек вокруг.',
      text.slice(0, MAX_TEXT),
      { maxTokens: 1500 },
    )

    const translated = completion.replace(/^["«»"]+|["«»"]+$/g, '').trim()
    if (translated.length < 4 || translated === text) {
      return err('перевод не удался, попробуйте позже', 502)
    }

    // Записываем кэш (аккуратно: пост могли удалить — catch)
    cache[lang] = { text: translated, at: new Date().toISOString() }
    await db.post
      .update({ where: { id: postId }, data: { translations: JSON.stringify(cache) } })
      .catch(() => {})

    // Журнал для анти-абьюза (раз в пост — не на каждый показ)
    db.translationLog
      .create({ data: { userId: g.uid, postId, srcLang: lang } })
      .catch(() => {})

    return NextResponse.json({ ok: true, text: translated, lang, cached: false })
  } catch (e) {
    console.error('[translate]', e)
    return err('перевод временно недоступен', 503)
  }
}
