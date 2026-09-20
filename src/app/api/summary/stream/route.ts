import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { extractiveSummary, parseBullets, streamSummary } from '@/lib/ai'
import { sseStream } from '@/lib/sse'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// LLM-вызов дорогой: только авторизованные, жёсткий лимит 10 запросов в минуту.
const bodySchema = z.object({
  postId: z.string().min(1).max(64),
})

/**
 * POST /api/summary/stream { postId } — SSE-стрим краткого содержания.
 *
 * ПАНЕЛЬ ОТКРЫВАЕТСЯ МГНОВЕННО, генерация идёт ВНУТРИ панели: каждый пункт
 * появляется в ней сразу, как только модель его дописала (построчный стрим),
 * — вместо скелетонов на 5–15 секунд, которые выглядели как «кнопка не работает».
 * Кэш (Post.aiSummary) отдаётся одним событием — мгновенно.
 *
 * События: delta {v} → done {items, fallback} | cached {items, fallback}
 *        | tooShort {} | fail {reason} → [поток закрывается]
 */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 10, windowMs: 60_000, bucket: 'summary' })
  if (!g.ok) return g.res

  // v5.48: try/catch до SSE — сбой БД раньше давал сырую 500 без лога
  let postId = ''
  let text = ''
  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('postId required')
    postId = parsed.data.postId

    // select вместо полной строки (egress: ttsAudio/translations не нужны)
    const post = await db.post.findUnique({ where: { id: postId }, select: { text: true, aiSummary: true } })
    if (!post) return err('post not found', 404)
    text = post.text.trim()
  } catch (e) {
    console.error('[summary/stream]', e)
    return err('summary failed', 500)
  }

  return sseStream(async (send) => {
    // 1) Слишком короткий — саммари не нужно (честно и мгновенно)
    if (text.length < 200) {
      send('tooShort', {})
      return
    }

    // 2) Кэш Post.aiSummary — мгновенный показ
    if (post.aiSummary) {
      try {
        const cached = JSON.parse(post.aiSummary)
        if (Array.isArray(cached) && cached.length > 0) {
          send('cached', { items: cached, fallback: false })
          return
        }
      } catch {
        // битый кэш — генерируем заново
      }
    }

    // 3) Холодный путь: построчный стрим LLM → в конце парсим и кэшируем
    try {
      const raw = await streamSummary(text, (chunk) => send('delta', { v: chunk }))
      const items = parseBullets(raw)
      if (items.length === 0) throw new Error('пустое саммари')
      await db.post
        .update({ where: { id: postId }, data: { aiSummary: JSON.stringify(items) } })
        .catch(() => {})
      send('done', { items, fallback: false })
    } catch {
      // Нейросеть не ответила — извлекающий фолбэк, функция не «умирает»
      const fallback = extractiveSummary(text)
      if (fallback.length === 0) {
        send('tooShort', {})
        return
      }
      // Не кэшируем: при следующем запросе снова попробуем LLM
      send('done', { items: fallback, fallback: true })
    }
  })
}
