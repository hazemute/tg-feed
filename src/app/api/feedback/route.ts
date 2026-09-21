import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { rateLimit } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

/**
 * ПРЕДЛОЖКА / БАГ-РЕПОРТ (v5.11, приказ владельца): отдельный чат в профиле,
 * сообщения БЕЗ нейронки — сразу уходят в админ-панель (вкладка «Предложки»).
 * Ответ админа приходит сюда же + колокольчиком (Notification, type 'support').
 */

/** Активная feedback-нить пользователя (одна; закрытая не переиспользуется) */
async function activeFeedbackThread(userId: string) {
  const last = await db.supportThread.findFirst({
    where: { userId, kind: 'feedback' },
    orderBy: { createdAt: 'desc' },
    include: { messages: { orderBy: { createdAt: 'asc' }, take: 100 } },
  })
  if (last && last.status !== 'closed') return last
  return null
}

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

/** GET /api/feedback — история чата предложки текущего пользователя */
export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'feedback-get' })
  if (!g.ok) return g.res

  try {
    const thread = await activeFeedbackThread(g.uid)
    if (!thread) return NextResponse.json({ status: null, topic: null, messages: [] })

    if (thread.unreadUser > 0) {
      await db.supportThread
        .update({ where: { id: thread.id }, data: { unreadUser: 0 } })
        .catch(() => {})
    }

    return NextResponse.json({
      status: thread.status,
      topic: thread.topic,
      messages: thread.messages.map(toMsg),
    })
  } catch (e) {
    console.error('[feedback GET]', e)
    return err('feedback failed', 500)
  }
}

const sendSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  topic: z.enum(['idea', 'bug']).optional(),
  images: z
    .array(z.string().regex(/^\/api\/upload\/[a-zA-Z0-9_-]+$/))
    .max(3)
    .optional(),
})

/**
 * DELETE /api/feedback — «Очистить историю» в предложке: удаляет все
 * feedback-нити текущего пользователя вместе с сообщениями. Свои данные —
 * своё право; чужие треды (и очередь админа по другим юзерам) не трогаем.
 */
export async function DELETE(request: Request) {
  const g = guardAuth(request, { limit: 6, windowMs: 60_000, bucket: 'feedback-clear' })
  if (!g.ok) return g.res

  try {
    const threads = await db.supportThread.findMany({
      where: { userId: g.uid, kind: 'feedback' },
      select: { id: true },
    })
    const ids = threads.map((t) => t.id)
    if (ids.length > 0) {
      await db.supportMessage.deleteMany({ where: { threadId: { in: ids } } })
      await db.supportThread.deleteMany({ where: { id: { in: ids } } })
    }
    return NextResponse.json({ ok: true, cleared: ids.length })
  } catch (e) {
    console.error('[feedback DELETE]', e)
    return err('feedback failed', 500)
  }
}

/** POST /api/feedback { text, topic?, images? } — отправить предложение/баг админу */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 10, windowMs: 60_000, bucket: 'feedback-send' })
  if (!g.ok) return g.res
  const userId = g.uid

  try {
    // readJson: кап 64KB до чтения тела (текст ≤2000 симв + ≤3 ссылки на картинки)
    const parsed = sendSchema.safeParse(await readJson(request))
    if (!parsed.success) return err('text required (1..2000)')
    const { text, topic } = parsed.data
    const images = parsed.data.images ?? []

    // Антиспам: интервал ≥ 2.5с и без точных дублей (как в поддержке)
    const pace = rateLimit(`fb-pace:${userId}`, 1, 2_500)
    if (!pace.ok) return err('не так быстро — подождите пару секунд', 429)

    const user = await db.user.findUnique({ where: { id: userId }, select: { id: true } })
    if (!user) return err('user not found', 404)

    const thread = await activeFeedbackThread(userId)
    const lastUserMsg = thread?.messages.filter((m) => m.sender === 'user').at(-1)
    if (lastUserMsg && lastUserMsg.text.trim() === text) {
      return err('дубликат сообщения', 429)
    }

    const threadId =
      thread?.id ??
      (
        await db.supportThread.create({
          data: { userId, status: 'human', kind: 'feedback', topic: topic ?? null },
          select: { id: true },
        })
      ).id

    // Тема (идея/баг) фиксируется на нити: первый выбор сохраняем
    if (topic && !thread?.topic) {
      await db.supportThread.update({ where: { id: threadId }, data: { topic } }).catch(() => {})
    }

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

    return NextResponse.json({ ok: true, messages: [toMsg(userMsg)] })
  } catch (e) {
    console.error('[feedback POST]', e)
    return err('feedback failed', 500)
  }
}
