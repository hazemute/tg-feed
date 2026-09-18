import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'

export const dynamic = 'force-dynamic'

// userId из тела/query игнорируется — пользователь берётся из Bearer-сессии.
const bodySchema = z.object({
  channelId: z.string().min(1).max(64).optional(),
  username: z.string().min(1).max(64).optional(),
  action: z.enum(['subscribe', 'unsubscribe', 'notify', 'mute', 'unmute']).optional(),
})

/** POST /api/subscribe — подписка в один тап и колокольчик уведомлений.
 * Тело: { channelId? | username?, action? }
 *  - без action                → прежнее поведение: переключатель подписки
 *  - action='subscribe'        → подписаться (идемпотентно)
 *  - action='unsubscribe'      → отписаться (идемпотентно)
 *  - action='notify'           → переключить режим уведомлений активной подписки (toggle)
 *  - action='mute'             → «Не интересно»: канал УБИРАЕТСЯ из персональной ленты (ChannelMute)
 *  - action='unmute'           → вернуть канал в ленту
 */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'subscribe' })
  if (!g.ok) return g.res
  const userId = g.uid

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) {
      // Различаем ошибку action (неизвестное действие) от отсутствия адресата
      const field = parsed.error.issues[0]?.path[0]
      return err(field === 'action' ? 'unknown action' : 'channelId or username required')
    }
    const { channelId, username } = parsed.data
    const action = parsed.data.action ?? ''
    if (!channelId && !username) return err('channelId or username required')

    const [user, channel] = await Promise.all([
      db.user.findUnique({ where: { id: userId } }),
      channelId
        ? db.channel.findUnique({ where: { id: channelId } })
        : username
          ? db.channel.findUnique({ where: { username: username.toLowerCase() } })
          : Promise.resolve(null),
    ])
    if (!user) return err('user not found', 404)
    if (!channel) return err('channel not found', 404)

    const existing = await db.subscription.findFirst({ where: { userId, channelId: channel.id } })

    // Колокольчик: переключить режим уведомлений у активной подписки
    if (action === 'notify') {
      if (!existing) return err('not subscribed', 404)
      const updated = await db.subscription.update({
        where: { id: existing.id },
        data: { notify: !existing.notify },
      })
      return NextResponse.json({ ok: true, subscribed: true, notify: updated.notify })
    }

    // «Не интересно» (v5.10): EyeOff у поста — скрыть ВЕСЬ канал из ленты.
    // Жалоба владельца: раньше кнопка прятала только один пост (локально),
    // и канал продолжал лезть. Отдельная таблица ChannelMute — не путается
    // с подписками (мьютнутый канал НЕ считается подпиской).
    if (action === 'mute') {
      await db.channelMute.upsert({
        where: { userId_channelId: { userId, channelId: channel.id } },
        create: { userId, channelId: channel.id },
        update: {},
      })
      return NextResponse.json({ ok: true, muted: true })
    }
    if (action === 'unmute') {
      await db.channelMute.deleteMany({ where: { userId, channelId: channel.id } })
      return NextResponse.json({ ok: true, muted: false })
    }

    // Явные действия — идемпотентны (повторный вызов не меняет состояние)
    if (action === 'subscribe' && existing) {
      return NextResponse.json({
        subscribed: true,
        subscribersCount: channel.membersCount ?? channel.subscribersCount,
        notify: existing.notify,
      })
    }
    if (action === 'unsubscribe' && !existing) {
      return NextResponse.json({ subscribed: false, subscribersCount: channel.membersCount ?? channel.subscribersCount })
    }

    if (existing) {
      await db.subscription.deleteMany({ where: { id: existing.id } })
      const updated = await db.channel.update({
        where: { id: channel.id },
        data: { subscribersCount: { decrement: 1 } },
      })
      return NextResponse.json({
        subscribed: false,
        // Реальный счётчик Telegram не меняется от локальной отписки
        subscribersCount: channel.membersCount ?? Math.max(0, updated.subscribersCount),
      })
    }

    // Идемпотентно даже при гонке (двойной тап / параллельные запросы):
    // upsert не падает на unique-конфликте, в отличие от create
    await db.subscription.upsert({
      where: { userId_channelId: { userId, channelId: channel.id } },
      create: { userId, channelId: channel.id, notify: true },
      update: {},
    })
    // Клик по [+] учитывается в дашборде админа (CTR)
    const updated = await db.channel.update({
      where: { id: channel.id },
      data: { subscribersCount: { increment: 1 }, clicksCount: { increment: 1 } },
    })
    return NextResponse.json({
      subscribed: true,
      // Реальный счётчик Telegram не меняется от локальной подписки
      subscribersCount: channel.membersCount ?? updated.subscribersCount,
      notify: true,
    })
  } catch (e) {
    console.error('[subscribe]', e)
    return err('subscribe failed', 500)
  }
}

/** GET /api/subscribe?channelId=...|username=... — состояние подписки и колокольчика */
export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'subscribe' })
  if (!g.ok) return g.res
  const userId = g.uid

  try {
    const { searchParams } = new URL(request.url)
    const channelId = (searchParams.get('channelId') ?? '').slice(0, 64)
    const username = (searchParams.get('username') ?? '').slice(0, 64)
    if (!channelId && !username) return err('channelId or username required')

    const channel = channelId
      ? await db.channel.findUnique({ where: { id: channelId } })
      : await db.channel.findUnique({ where: { username: username.toLowerCase() } })
    if (!channel) return err('channel not found', 404)

    const sub = await db.subscription.findFirst({ where: { userId, channelId: channel.id } })
    return NextResponse.json({ subscribed: !!sub, notify: sub ? sub.notify : true })
  } catch (e) {
    console.error('[subscribe:get]', e)
    return err('failed', 500)
  }
}
