import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { cyrillicRatio, streamTranslate } from '@/lib/ai'
import { gtxTranslate } from '@/lib/translate'
import { sseStream } from '@/lib/sse'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const bodySchema = z.object({
  postId: z.string().min(1).max(64),
  /** Целевой язык (ISO 639-1). По умолчанию — родной язык пользователя, иначе русский */
  lang: z.string().min(2).max(5).optional(),
})

/**
 * POST /api/translate/stream { postId, lang? } — SSE-стрим перевода.
 *
 * ПЕРЕВОД «ЗА СЕКУНДУ»: дельты LLM летят в UI в реальном времени — переведённый
 * текст печатается на месте оригинала прямо во время генерации (Twitter-style),
 * а не появляется одним куском через 5–15 секунд. Кэш бьётся мгновенно одним
 * событием. Финальный текст пишется в Post.translations (как в обычном роуте).
 *
 * События: delta {v} → done {cached} | fail {reason} → [поток закрывается]
 */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 12, windowMs: 60_000, bucket: 'translate' })
  if (!g.ok) return g.res

  const parsed = bodySchema.safeParse(await readJson(request))
  if (!parsed.success) return err('postId required')
  const { postId } = parsed.data

  const post = await db.post.findUnique({ where: { id: postId }, select: { text: true } })
  if (!post) return err('post not found', 404)

  const text = post.text.trim()

  // Целевой язык: параметр → язык клиента Telegram → русский
  const user = await db.user.findUnique({ where: { id: g.uid } })
  const lang = (parsed.data.lang ?? user?.languageCode ?? 'ru').slice(0, 2).toLowerCase()

  // Быстрые пред-проверки (без LLM) — мгновенный честный ответ
  if (text.length < 24) {
    return sseStream(async (send) => {
      send('fail', { reason: 'short' })
    })
  }
  if (cyrillicRatio(text) > 0.15) {
    return sseStream(async (send) => {
      send('fail', { reason: 'russian' })
    })
  }

  return sseStream(async (send) => {
    // 1) Кэш Post.translations — мгновенный показ без LLM
    const fresh = await db.post.findUnique({
      where: { id: postId },
      select: { translations: true },
    })
    let cache: Record<string, { text: string; at: string }> = {}
    if (fresh?.translations) {
      try {
        cache = JSON.parse(fresh.translations)
      } catch {
        cache = {}
      }
    }
    const hit = cache[lang]
    if (hit?.text) {
      send('delta', { v: hit.text })
      send('done', { cached: true })
      return
    }

    // 2) Холодный путь: СНАЧАЛА бесплатный быстрый gtx (без ключей и лимитов
    //    OpenRouter, ~0.2-1с целиком) — отдаём одним событием; при недоступности
    //    — прежний стрим LLM. Финальный текст в кэш в обоих случаях.
    let provider: 'gtx' | 'llm' = 'llm'
    let translated: string | null = null
    try {
      translated = await gtxTranslate(text, lang)
      if (translated) provider = 'gtx'
    } catch {
      translated = null
    }
    if (!translated) {
      try {
        translated = await streamTranslate(text, lang, (chunk) => send('delta', { v: chunk }))
      } catch {
        send('fail', { reason: 'llm' })
        return
      }
    }
    cache[lang] = { text: translated, at: new Date().toISOString() }
    await db.post
      .update({ where: { id: postId }, data: { translations: JSON.stringify(cache) } })
      .catch(() => {})
    // Журнал для анти-абьюза (раз в пост — не на каждый показ)
    db.translationLog.create({ data: { userId: g.uid, postId, srcLang: lang } }).catch(() => {})
    if (provider === 'gtx') send('delta', { v: translated }) // gtx не стримил дельты — отдаём целиком
    send('done', { cached: false, provider })
  })
}
