import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * GET /api/panel/bot-chats (v5.70) — чаты, где бот состоит АДМИНИСТРАТОРОМ.
 *
 * Данные копятся вебхуком (update.my_chat_member → таблица BotChat). Нужен
 * конструктору заданий: приватный инвайт-чат нельзя проверить по ссылке —
 * квест kind=join_chat привязывается к числовому chat_id отсюда.
 */
export async function GET(request: Request) {
  const g = guardAdmin(request)
  if (!g.ok) return g.res
  try {
    const [rows, total] = await Promise.all([
      db.botChat.findMany({
        where: { isAdmin: true },
        orderBy: [{ updatedAt: 'desc' }],
        select: { chatId: true, title: true, type: true, updatedAt: true },
      }),
      db.botChat.count(),
    ])
    return NextResponse.json({
      items: rows.map((c) => ({
        chatId: c.chatId,
        title: c.title || c.chatId,
        type: c.type,
        updatedAt: c.updatedAt.toISOString(),
      })),
      knownTotal: total, // всего известных чатов (в т.ч. без прав админа)
    })
  } catch (e) {
    console.error('[panel/bot-chats]', e)
    return err('failed', 500)
  }
}
