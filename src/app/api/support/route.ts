import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { rateLimit } from '@/lib/rate-limit'
import { supportAiReply, AI_FALLBACK_REPLY } from '@/lib/support-ai'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Суточный лимит AI-ответов на пользователя (приказ владельца: «чтобы тип
 * просто так не мог с нейронкой общаться и не жрал лимиты»). Исчерпан →
 * нить автоматически уходит человеку (status=human), AI молчит.
 */
const AI_DAILY_LIMIT = 20

/** Форма сообщения, отдаваемая клиенту */
type MsgDTO = { id: string; sender: string; text: string; images: string[]; createdAt: string }

function toMsg(m: { id: string; sender: string; text: string; images: string | null; createdAt: Date }): MsgDTO {
  let images: string[] = []
  if (m.images) {
    try {
      images = JSON.parse(m.images)
    } catch {
      images = []
    }
  }
  return { id: m.id, sender: m.sender, text: m.text, images, createdAt: m.createdAt.toISOString() }
}

/**
 * Активная нить поддержки пользователя (одна на пользователя; закрытая
 * нить не переиспользуется — новый вопрос начинает новый диалог).
 */
async function activeThread(userId: string) {
  const last = await db.supportThread.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: { messages: { orderBy: { createdAt: 'asc' }, take: 100 } },
  })
  if (last && last.status !== 'closed') return last
  return null
}

/**
 * GET /api/support — состояние чата поддержки текущего пользователя.
 * Открытие чата сбрасывает счётчик непрочитанных от поддержки.
 */
export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'support-get' })
  if (!g.ok) return g.res
  const userId = g.uid

  try {
    const thread = await activeThread(userId)
    if (!thread) return NextResponse.json({ status: null, messages: [] })

    if (thread.unreadUser > 0) {
      await db.supportThread
        .update({ where: { id: thread.id }, data: { unreadUser: 0 } })
        .catch(() => {})
    }

    return NextResponse.json({
      status: thread.status,
      messages: thread.messages.map(toMsg),
    })
  } catch (e) {
    console.error('[support GET]', e)
    return err('support failed', 500)
  }
}

const sendSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  /** Картинки: заранее загружены через POST /api/upload → /api/upload/{id} */
  images: z
    .array(z.string().regex(/^\/api\/upload\/[a-zA-Z0-9_-]+$/))
    .max(3)
    .optional(),
})

/**
 * POST /api/support { text } — отправить сообщение в поддержку.
 *
 * Пока нить в статусе ai — отвечает нейросеть (самая дешёвая модель
 * OpenRouter; знания о приложении — в lib/support-ai). Эскалация переводит
 * нить на сотрудника: обращение появляется в админ-панели, ответ приходит
 * в этот же чат.
 */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 10, windowMs: 60_000, bucket: 'support-send' })
  if (!g.ok) return g.res
  const userId = g.uid

  try {
    const parsed = sendSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return err('text required (1..2000)')
    const text = parsed.data.text
    const images = parsed.data.images ?? []

    // --- АНТИСПАМ (приказ владельца) ---
    // 1) интервал между сообщениями ≥ 2.5с (in-memory, слой 2)
    const pace = rateLimit(`sup-pace:${userId}`, 1, 2_500)
    if (!pace.ok) return err('не так быстро — подождите пару секунд', 429)

    const user = await db.user.findUnique({ where: { id: userId }, select: { languageCode: true } })
    if (!user) return err('user not found', 404)

    const thread = await activeThread(userId)

    // 2) точный дубль последнего сообщения — молча отклоняем
    const lastUserMsg = thread?.messages.filter((m) => m.sender === 'user').at(-1)
    if (lastUserMsg && lastUserMsg.text.trim() === text) {
      return err('дубликат сообщения', 429)
    }

    const threadId =
      thread?.id ??
      (
        await db.supportThread.create({
          data: { userId, status: 'ai' },
          select: { id: true },
        })
      ).id

    const userMsg = await db.supportMessage.create({
      data: {
        threadId,
        sender: 'user',
        text,
        images: images.length > 0 ? JSON.stringify(images) : null,
      },
    })
    await db.supportThread.update({
      where: { id: threadId },
      data: { unreadAdmin: { increment: 1 }, lastMessageAt: new Date() },
    })

    const newMessages: MsgDTO[] = [toMsg(userMsg)]
    let status = thread?.status ?? 'ai'

    /* --- Ответ нейросети: пока нить у AI И не исчерпан суточный лимит --- */
    if (status === 'ai') {
      const dayAgo = new Date(Date.now() - 86_400_000)
      const aiCount = await db.supportMessage.count({
        where: { sender: 'ai', createdAt: { gte: dayAgo }, thread: { userId } },
      })
      if (aiCount >= AI_DAILY_LIMIT) {
        // Лимит исчерпан: нить уходит человеку, нейронка не тратится
        const note = await db.supportMessage.create({
          data: {
            threadId,
            sender: 'system',
            text: 'Суточный лимит ответов ассистента исчерпан — обращение передано оператору поддержки',
          },
        })
        newMessages.push(toMsg(note))
        status = 'human'
        await db.supportThread.update({ where: { id: threadId }, data: { status } })
      } else {
        try {
          const history = [
            ...(thread?.messages ?? []).map((m) => ({ sender: m.sender, text: m.text })),
            { sender: 'user', text },
          ]
          const { text: reply, escalate } = await supportAiReply(history, user.languageCode)

          const aiMsg = await db.supportMessage.create({
            data: { threadId, sender: 'ai', text: reply },
          })
          newMessages.push(toMsg(aiMsg))

          if (escalate) {
            const note = await db.supportMessage.create({
              data: {
                threadId,
                sender: 'system',
                text: 'Обращение передано сотруднику поддержки',
              },
            })
            newMessages.push(toMsg(note))
            status = 'human'
            await db.supportThread.update({ where: { id: threadId }, data: { status } })
          }
        } catch (e) {
          console.error('[support AI]', e)
          const fb = await db.supportMessage.create({
            data: { threadId, sender: 'ai', text: AI_FALLBACK_REPLY },
          })
          newMessages.push(toMsg(fb))
        }
      }
    }

    return NextResponse.json({ ok: true, status, messages: newMessages })
  } catch (e) {
    console.error('[support POST]', e)
    return err('support failed', 500)
  }
}
