import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { emitAppEvent } from '@/lib/events'
import { err, readJson } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/** GET /api/panel/support/[id] — нить целиком: пользователь + все сообщения. */
export async function GET(request: Request, ctx: Ctx) {
  const g = guardAdmin(request, { limit: 240, windowMs: 60_000, bucket: 'panel-support-one' })
  if (!g.ok) return g.res

  try {
    const { id } = await ctx.params
    const thread = await db.supportThread.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, username: true, firstName: true, lastName: true, isGuest: true, photoUrl: true } },
        messages: { orderBy: { createdAt: 'asc' }, take: 200 },
      },
    })
    if (!thread) return err('thread not found', 404)

    // Сотрудник открыл диалог — сообщения пользователя прочитаны
    if (thread.unreadAdmin > 0) {
      await db.supportThread
        .update({ where: { id: thread.id }, data: { unreadAdmin: 0 } })
        .catch(() => {})
    }

    return NextResponse.json({
      id: thread.id,
      status: thread.status,
      kind: thread.kind,
      topic: thread.topic,
      unreadUser: thread.unreadUser,
      lastMessageAt: thread.lastMessageAt.toISOString(),
      createdAt: thread.createdAt.toISOString(),
      user: thread.user,
      messages: thread.messages.map((m) => {
        let images: string[] = []
        if (m.images) {
          try {
            const parsed: unknown = JSON.parse(m.images)
            if (Array.isArray(parsed)) images = parsed.filter((x): x is string => typeof x === 'string')
          } catch {
            images = []
          }
        }
        return {
          id: m.id,
          sender: m.sender,
          text: m.text,
          images,
          createdAt: m.createdAt.toISOString(),
        }
      }),
    })
  } catch (e) {
    console.error('[panel/support/[id] GET]', e)
    return err('panel support failed', 500)
  }
}

const replySchema = z.object({ text: z.string().trim().min(1).max(2000) })

/** POST /api/panel/support/[id] { text } — ответ сотрудника. */
export async function POST(request: Request, ctx: Ctx) {
  const g = guardAdmin(request, { limit: 120, windowMs: 60_000, bucket: 'panel-support-reply' })
  if (!g.ok) return g.res

  try {
    const { id } = await ctx.params
    const parsed = replySchema.safeParse(await readJson(request).catch(() => null))
    if (!parsed.success) return err('text required (1..2000)')

    const thread = await db.supportThread.findUnique({ where: { id }, select: { id: true, status: true, userId: true } })
    if (!thread) return err('thread not found', 404)

    const msg = await db.supportMessage.create({
      data: { threadId: id, sender: 'admin', text: parsed.data.text },
    })
    await db.supportThread.update({
      where: { id },
      data: { status: 'human', unreadUser: { increment: 1 }, unreadAdmin: 0, lastMessageAt: new Date() },
    })

    // Уведомление пользователю: поддержка ответила (инбокс «Активность»).
    // Fire-and-forget: ответ сотруднику не должен ждать запись нотификации.
    void db.notification
      .create({
        data: {
          userId: thread.userId,
          type: 'support',
          title: 'Поддержка',
          body: parsed.data.text.slice(0, 200),
        },
      })
      .then(() => emitAppEvent('notif:new', { userId: thread.userId }))
      .catch((e: unknown) => console.error('[panel/support notify]', e))

    return NextResponse.json({
      ok: true,
      message: { id: msg.id, sender: 'admin', text: msg.text, createdAt: msg.createdAt.toISOString() },
    })
  } catch (e) {
    console.error('[panel/support/[id] POST]', e)
    return err('panel support failed', 500)
  }
}

const patchSchema = z.object({ status: z.enum(['ai', 'human', 'closed']) })

/** PATCH /api/panel/support/[id] { status } — передать обратно ИИ / закрыть. */
export async function PATCH(request: Request, ctx: Ctx) {
  const g = guardAdmin(request, { limit: 120, windowMs: 60_000, bucket: 'panel-support-patch' })
  if (!g.ok) return g.res

  try {
    const { id } = await ctx.params
    const parsed = patchSchema.safeParse(await readJson(request).catch(() => null))
    if (!parsed.success) return err('status must be ai | human | closed')

    const thread = await db.supportThread.findUnique({ where: { id }, select: { id: true } })
    if (!thread) return err('thread not found', 404)

    const data: { status: string; unreadAdmin?: number } = { status: parsed.data.status }
    if (parsed.data.status === 'closed') data.unreadAdmin = 0
    if (parsed.data.status === 'ai') {
      data.unreadAdmin = 0
      // Системная заметка о возврате нейросети — чтобы контекст был ясен обеим сторонам
      await db.supportMessage.create({
        data: { threadId: id, sender: 'system', text: 'Диалог возвращён нейросети поддержки' },
      })
    }
    await db.supportThread.update({ where: { id }, data })

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[panel/support/[id] PATCH]', e)
    return err('panel support failed', 500)
  }
}
