import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { isTelegramMember } from '@/lib/tg-bot'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  channelId: z.string().min(1).max(64).optional(),
  username: z.string().min(1).max(64).optional(),
})

/**
 * POST /api/subscribe/verify { channelId? | username? }
 *
 * Подтверждение «подписки в один тап»: пользователь вернулся из клиента
 * Telegram после открытия канала — сверяем членство через Bot API
 * getChatMember. verified=true только при точном ответе бота (бот должен
 * состоять в канале); checkable=false — проверить нечем, это не ошибка.
 */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 30, windowMs: 60_000, bucket: 'subscribe-verify' })
  if (!g.ok) return g.res

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('channelId or username required')
    const { channelId, username } = parsed.data
    if (!channelId && !username) return err('channelId or username required')

    // Проверка возможна только у настоящих Telegram-пользователей:
    // у гостя нет числового tg id для getChatMember.
    if (g.uid.startsWith('demo_')) {
      return NextResponse.json({ verified: false, checkable: false })
    }
    const tgId = Number(g.uid.slice('tg_'.length))
    if (!Number.isInteger(tgId) || tgId <= 0) {
      return NextResponse.json({ verified: false, checkable: false })
    }

    const channel = channelId
      ? await db.channel.findUnique({ where: { id: channelId }, select: { username: true } })
      : await db.channel.findUnique({
          where: { username: username!.replace(/^@/, '').slice(0, 64) },
          select: { username: true },
        })
    if (!channel) return err('channel not found', 404)

    const member = await isTelegramMember(channel.username, tgId)
    return NextResponse.json({ verified: member === true, checkable: member !== null })
  } catch (e) {
    console.error('[subscribe/verify]', e)
    return err('verify failed', 500)
  }
}
