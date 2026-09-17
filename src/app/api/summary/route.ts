import { NextResponse } from 'next/server'
import { z } from 'zod'
import ZAI from 'z-ai-web-dev-sdk'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'

export const dynamic = 'force-dynamic'

// LLM-вызов дорогой: только авторизованные, жёсткий лимит 10 запросов в минуту.
const bodySchema = z.object({
  postId: z.string().min(1).max(64),
})

const SYSTEM_PROMPT =
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
  // Fallback: разбиваем построчно
  return raw
    .split('\n')
    .map((l) => l.replace(/^[\s\-\d.*•]+/, '').trim())
    .filter((l) => l.length > 8)
    .slice(0, 3)
}

/**
 * POST /api/summary { postId }
 * AI-саммари поста в 3 пунктах. Результат кэшируется в БД (Post.aiSummary).
 * Требуется сессия (Bearer); лимит 10 запросов в минуту на пользователя.
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

    if (post.aiSummary) {
      try {
        const cached = JSON.parse(post.aiSummary)
        if (Array.isArray(cached) && cached.length > 0) {
          return NextResponse.json({ items: cached, cached: true })
        }
      } catch {
        // перегенерируем
      }
    }

    const text = post.text.trim()
    if (text.length < 200) {
      return NextResponse.json({ items: [], cached: false, tooShort: true })
    }

    const zai = await ZAI.create()
    const completion = await zai.chat.completions.create({
      messages: [
        { role: 'assistant', content: SYSTEM_PROMPT },
        { role: 'user', content: text.slice(0, 4000) },
      ],
      thinking: { type: 'disabled' },
    })

    const raw = completion.choices[0]?.message?.content ?? ''
    const items = parseBullets(raw)

    if (items.length === 0) {
      return NextResponse.json({ items: [], cached: false, tooShort: true })
    }

    await db.post.update({ where: { id: postId }, data: { aiSummary: JSON.stringify(items) } })

    return NextResponse.json({ items, cached: false })
  } catch (e) {
    console.error('[summary]', e)
    return err('summary failed', 500)
  }
}
