import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * СЕССИИ ИИ-ЧАТОВ (v5.74) — «история чатов в иишках»: список прошлых
 * разговоров, «Новый чат», удаление, переименование. Работает для обеих
 * поверхностей (assistant — ассистент канала, search — ИИ-поиск).
 *
 *  GET    ?surface=assistant&channelId=…        — список сессий (новые сверху)
 *         + превью последнего сообщения (строка списка, как в Telegram).
 *  POST   {surface, channelId?, title?}         — создать пустую сессию («Новый чат»).
 *  PATCH  {id, title}                           — переименовать.
 *  DELETE ?id=…                                 — удалить сессию вместе с сообщениями.
 *         (без id — очистить все сессии поверхности)
 *
 * Сами сообщения живут в AiChatMessage.sessionId; сессия создаётся и сервером
 * автоматически при первом сообщении в пустом чате (assistant/search POST chat).
 */

const surfaceSchema = z.enum(['assistant', 'search'])

export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'ai-sessions' })
  if (!g.ok) return g.res

  try {
    const url = new URL(request.url)
    const parsed = surfaceSchema.safeParse(url.searchParams.get('surface'))
    if (!parsed.success) return err('Некорректная поверхность')
    const channelId = url.searchParams.get('channelId') || undefined

    const sessions = await db.aiChatSession.findMany({
      where: { userId: g.uid, surface: parsed.data, ...(channelId ? { channelId } : {}) },
      orderBy: { updatedAt: 'desc' },
      take: 40,
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    })
    if (sessions.length === 0) return NextResponse.json({ sessions: [] })

    // Последнее сообщение каждой сессии — превью в списке чатов (как в TG).
    // 40 индексных точечных выборок по (sessionId, createdAt) — дёшево.
    const previews = await Promise.all(
      sessions.map(async (s) => {
        const last = await db.aiChatMessage.findFirst({
          where: { userId: g.uid, sessionId: s.id },
          orderBy: { createdAt: 'desc' },
          select: { role: true, content: true },
        })
        return {
          id: s.id,
          title: s.title,
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
          lastPreview: last
            ? `${last.role === 'user' ? 'Вы: ' : ''}${last.content.slice(0, 120)}`
            : null,
        }
      }),
    )
    return NextResponse.json({ sessions: previews })
  } catch (e) {
    console.error('[ai/sessions:get]', e)
    return err('Ошибка', 500)
  }
}

const createSchema = z.object({
  surface: surfaceSchema,
  channelId: z.string().max(64).optional(),
  title: z.string().trim().max(80).optional(),
})

export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 30, windowMs: 60_000, bucket: 'ai-sessions' })
  if (!g.ok) return g.res
  try {
    const parsed = createSchema.safeParse(await readJson(request))
    if (!parsed.success) return err('Некорректные данные')
    const s = await db.aiChatSession.create({
      data: {
        userId: g.uid,
        surface: parsed.data.surface,
        channelId: parsed.data.channelId ?? null,
        title: parsed.data.title ?? 'Новый чат',
      },
      select: { id: true, title: true, createdAt: true },
    })
    return NextResponse.json({
      ok: true,
      session: { ...s, createdAt: s.createdAt.toISOString() },
    })
  } catch (e) {
    console.error('[ai/sessions:post]', e)
    return err('Ошибка', 500)
  }
}

const patchSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(80),
})

export async function PATCH(request: Request) {
  const g = guardAuth(request, { limit: 30, windowMs: 60_000, bucket: 'ai-sessions' })
  if (!g.ok) return g.res
  try {
    const parsed = patchSchema.safeParse(await readJson(request))
    if (!parsed.success) return err('Некорректные данные')
    // updateMany с условием по владельцу — чужую сессию не переименовать
    const r = await db.aiChatSession.updateMany({
      where: { id: parsed.data.id, userId: g.uid },
      data: { title: parsed.data.title },
    })
    if (r.count === 0) return err('Чат не найден', 404)
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[ai/sessions:patch]', e)
    return err('Ошибка', 500)
  }
}

export async function DELETE(request: Request) {
  const g = guardAuth(request, { limit: 30, windowMs: 60_000, bucket: 'ai-sessions' })
  if (!g.ok) return g.res
  try {
    const url = new URL(request.url)
    const id = url.searchParams.get('id')
    if (!id) {
      // Без id — «очистить всё»: удаляем все сессии поверхности (+ channelId)
      const surface = surfaceSchema.safeParse(url.searchParams.get('surface'))
      if (!surface.success) return err('Некорректная поверхность')
      const channelId = url.searchParams.get('channelId') || undefined
      const own = await db.aiChatSession.findMany({
        where: { userId: g.uid, surface: surface.data, ...(channelId ? { channelId } : {}) },
        select: { id: true },
      })
      const ids = own.map((x) => x.id)
      await db.aiChatMessage.deleteMany({ where: { sessionId: { in: ids }, userId: g.uid } })
      await db.aiChatSession.deleteMany({ where: { id: { in: ids }, userId: g.uid } })
      return NextResponse.json({ ok: true, removed: ids.length })
    }
    // Удаляем сессию владельца + её сообщения (where userId — двойная защита)
    const del = await db.aiChatSession.deleteMany({ where: { id, userId: g.uid } })
    if (del.count === 0) return err('Чат не найден', 404)
    await db.aiChatMessage.deleteMany({ where: { sessionId: id, userId: g.uid } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[ai/sessions:delete]', e)
    return err('Ошибка', 500)
  }
}
