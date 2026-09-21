import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { invalidatePersonalSignals } from '@/lib/feed'
import { clearUserPages } from '@/lib/page-cache'

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
      // select вместо полной строки (egress)
      db.user.findUnique({ where: { id: userId }, select: { id: true } }),
      channelId
        ? db.channel.findUnique({
            where: { id: channelId },
            select: { id: true, membersCount: true, subscribersCount: true },
          })
        : username
          ? db.channel.findUnique({
              where: { username: username.toLowerCase() },
              select: { id: true, membersCount: true, subscribersCount: true },
            })
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
      // Task 5-c: мьютнутый канал исключается из рекомендаций — применяем сразу
      invalidatePersonalSignals(userId)
      // L0-кэш страниц тоже сбрасываем — он отдаётся до свежих фильтров видимости
      clearUserPages(userId)
      return NextResponse.json({ ok: true, muted: true })
    }
    if (action === 'unmute') {
      await db.channelMute.deleteMany({ where: { userId, channelId: channel.id } })
      invalidatePersonalSignals(userId)
      clearUserPages(userId)
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
      // v5.48: декремент ТОЛЬКО если реально удалили строку — при гонке
      // (двойной тап, параллельные запросы) deleteMany у второго запроса
      // вернёт 0, и счётчик больше не проваливается ниже нуля
      const del = await db.subscription.deleteMany({ where: { id: existing.id } })
      const updated =
        del.count > 0
          ? await db.channel.update({
              where: { id: channel.id },
              data: { subscribersCount: { decrement: 1 } },
            })
          : null
      return NextResponse.json({
        subscribed: false,
        // Реальный счётчик Telegram не меняется от локальной отписки
        subscribersCount: channel.membersCount ?? Math.max(0, updated?.subscribersCount ?? channel.subscribersCount),
      })
    }

    // Идемпотентно даже при гонке (двойной тап / параллельные запросы):
    // create + ловим unique-конфликт; increment ТОЛЬКО если строка создана
    // (раньше upsert-гонка дважды +1 — счётчик раздувался)
    let created = false
    try {
      await db.subscription.create({
        data: { userId, channelId: channel.id, notify: true },
      })
      created = true
    } catch (e) {
      // P2002 — подписка уже создана параллельным запросом: не ошибка
      if ((e as { code?: string }).code !== 'P2002') throw e
    }
    // Клик по [+] учитывается в дашборде админа (CTR) — фактический тап,
    // поэтому клик считаем всегда, а подписку — только при создании
    const updated = await db.channel.update({
      where: { id: channel.id },
      data: {
        clicksCount: { increment: 1 },
        ...(created ? { subscribersCount: { increment: 1 } } : {}),
      },
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
      ? await db.channel.findUnique({ where: { id: channelId }, select: { id: true } })
      : await db.channel.findUnique({ where: { username: username.toLowerCase() }, select: { id: true } })
    if (!channel) return err('channel not found', 404)

    const sub = await db.subscription.findFirst({ where: { userId, channelId: channel.id } })
    return NextResponse.json({ subscribed: !!sub, notify: sub ? sub.notify : true })
  } catch (e) {
    console.error('[subscribe:get]', e)
    return err('failed', 500)
  }
}
