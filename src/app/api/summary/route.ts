import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { extractiveSummary, summarizePostCached } from '@/lib/ai'

export const dynamic = 'force-dynamic'

// LLM-вызов дорогой: только авторизованные, жёсткий лимит 10 запросов в минуту.
const bodySchema = z.object({
  postId: z.string().min(1).max(64),
})

/**
 * POST /api/summary { postId }
 * AI-саммари поста в 3 пунктах. Результат кэшируется в БД (Post.aiSummary).
 * Если нейросеть недоступна — извлекающий фолбэк (extractiveSummary),
 * чтобы функция не «умирала» целиком. Требуется сессия; 10 запросов в минуту.
 */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 10, windowMs: 60_000, bucket: 'summary' })
  if (!g.ok) return g.res

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('postId required')
    const postId = parsed.data.postId

    const post = await db.post.findUnique({ where: { id: postId } })
    if (!post) return err('post not found', 404)


    let items: string[] = []
    let llmFailed = false
    try {
      // Самая быстрая дешёвая модель OpenRouter (работает и на Vercel) —
      // кэш в Post.aiSummary: LLM вызывается один раз на пост
      const r = await summarizePostCached(postId)
      if (r) {
        if (r.tooShort) {
          return NextResponse.json({ items: [], cached: false, tooShort: true })
        }
        items = r.items
      }
    } catch (e) {
      console.error('[summary] llm failed, fallback on', e)
      llmFailed = true
    }

    if (items.length === 0) {
      // Нейросеть не ответила или вернула мусор — выжимаем предложения сами.
      // Не кэшируем в Post.aiSummary: при следующем запросе попробуем LLM снова.
      const fallback = extractiveSummary(post.text.trim())
      if (fallback.length === 0) {
        return NextResponse.json({ items: [], cached: false, tooShort: true })
      }
      return NextResponse.json({
        items: fallback,
        cached: false,
        ...(llmFailed ? { fallback: true } : {}),
      })
    }

    await db.post.update({ where: { id: postId }, data: { aiSummary: JSON.stringify(items) } })

    return NextResponse.json({ items, cached: false })
  } catch (e) {
    console.error('[summary]', e)
    return err('summary failed', 500)
  }
}
