import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'
import { logAdmin } from '@/lib/admin-log'
import {
  parseChannels,
  parsePrizes,
  parseWinners,
  publishGiveawayPost,
  finalizeGiveaway,
  checkDueGiveaways,
  giveawayPostHtml,
  prizeAutoLabel,
  totalWinners,
  DEFAULT_GIVEAWAY_CHANNEL,
  type Prize,
} from '@/lib/giveaways'
import { parseTasks, parseTasksDone } from '@/lib/giveaway-tickets'
import { stripTgEmoji } from '@/lib/tg-emoji'

export const dynamic = 'force-dynamic'

/**
 * Панель: РОЗЫГРЫШИ (v5.40).
 *
 * GET  → все розыгрыши (новые сверху) + счётчики заявок + канал публикации.
 * POST { action:'create', ... }     → создать черновик.
 * POST { action:'update', id, ... } → правка черновика.
 * POST { action:'delete', id }      → удалить черновик/отменённый.
 * POST { action:'publish', id }     → одобрить и выложить: бот публикует пост
 *                                     с кнопкой «Участвовать (N)»; если startAt
 *                                     в будущем — ставится в планировщик.
 * POST { action:'cancel', id }      → отменить активный/запланированный.
 * POST { action:'finalize', id }    → завершить прямо сейчас (итоги + призы).
 * POST { action:'sweep' }           → прогон ленивого планировщика.
 * POST { action:'channel', value }  → канал публикации ('' — дефолт @SnapTeamDev).
 * PUT  { title, text, prizes… }     → HTML-превью поста для конструктора.
 */

const prizeSchema = z.object({
  kind: z.enum(['swipes', 'rub', 'tier', 'custom']),
  amount: z.number().int().min(0).max(100_000_000),
  periodDays: z.number().int().min(0).max(3650).optional(),
  winners: z.number().int().min(1).max(1000),
  label: z.string().max(120).optional(),
})

const baseFields = {
  title: z.string().trim().min(3).max(120),
  text: z.string().max(3500).default(''),
  prizes: z.array(prizeSchema).min(1).max(20),
  channels: z.array(z.string().trim().max(64)).max(10).default([]),
  buttonStyle: z.enum(['primary', 'success', 'danger']).default('primary'),
  buttonEmoji: z.string().max(16).default('🎉'),
  buttonEmojiId: z.string().max(64).default(''),
  startAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
  endAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
}

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), ...baseFields }),
  z.object({ action: z.literal('update'), id: z.string().min(1), ...baseFields }),
  z.object({ action: z.literal('delete'), id: z.string().min(1) }),
  z.object({ action: z.literal('publish'), id: z.string().min(1) }),
  z.object({ action: z.literal('cancel'), id: z.string().min(1) }),
  z.object({ action: z.literal('finalize'), id: z.string().min(1) }),
  z.object({ action: z.literal('sweep') }),
  z.object({ action: z.literal('channel'), value: z.string().max(64).default('') }),
])

function serializePrizes(list: z.infer<typeof prizeSchema>[]): Prize[] {
  return list.map((p) => ({
    kind: p.kind,
    amount: p.amount,
    ...(p.periodDays ? { periodDays: p.periodDays } : {}),
    winners: p.winners,
    label: p.label?.trim() ? p.label.trim() : prizeAutoLabel(p),
  }))
}

export async function GET(request: Request) {
  const g = guardAdmin(request, { limit: 60, windowMs: 60_000 })
  if (!g.ok) return g.res
  try {
    // ?entries=<giveawayId> — участники розыгрыша с билетами (v5.46)
    const url = new URL(request.url)
    const entriesOf = (url.searchParams.get('entries') ?? '').trim()
    if (/^[a-z0-9]{10,40}$/i.test(entriesOf)) {
      const gw = await db.giveaway.findUnique({
        where: { id: entriesOf },
        select: { id: true, title: true, status: true, winners: true, losersRewardSwipes: true },
      })
      if (!gw) return err('Розыгрыш не найден', 404)
      const rows = await db.giveawayEntry.findMany({
        where: { giveawayId: entriesOf },
        orderBy: [{ ticketsCount: 'desc' }, { createdAt: 'asc' }],
        take: 5000,
      })
      const userIds = [...new Set(rows.map((r) => r.userId))]
      const users = await db.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, username: true, firstName: true, lastName: true },
      })
      const userById = new Map(users.map((u) => [u.id, u]))
      const winnerIds = new Set(parseWinners(gw.winners).map((w) => w.userId))
      return NextResponse.json({
        giveaway: { id: gw.id, title: gw.title, status: gw.status, losersRewardSwipes: gw.losersRewardSwipes },
        entries: rows.map((r) => ({
          userId: r.userId,
          name:
            r.firstName ||
            userById.get(r.userId)?.firstName ||
            (r.username ? `@${r.username}` : 'участник'),
          username: r.username ?? userById.get(r.userId)?.username ?? null,
          tgId: r.tgId,
          ticketsCount: r.ticketsCount,
          tasksDone: parseTasksDone(r.tasksDone),
          winner: winnerIds.has(r.userId),
          createdAt: r.createdAt.toISOString(),
        })),
      })
    }

    const rows = await db.giveaway.findMany({ orderBy: { createdAt: 'desc' }, take: 100 })
    const counts = await db.giveawayEntry.groupBy({ by: ['giveawayId'], _count: { _all: true } })
    const ticketSums = await db.giveawayEntry.groupBy({
      by: ['giveawayId'],
      _sum: { ticketsCount: true },
    })
    const countMap = new Map(counts.map((c) => [c.giveawayId, c._count._all]))
    const ticketMap = new Map(ticketSums.map((t) => [t.giveawayId, t._sum.ticketsCount ?? 0]))
    const chanRow = await db.botSetting.findUnique({ where: { key: 'giveaway_channel' } })
    const items = rows.map((r) => ({
      id: r.id,
      title: r.title,
      text: r.text,
      prizes: parsePrizes(r.prizes),
      channels: parseChannels(r.channels),
      tasks: parseTasks(r.tasks),
      promoCode: r.promoCode,
      losersRewardSwipes: r.losersRewardSwipes,
      hasPhoto: Boolean(r.photoFileId),
      buttonStyle: r.buttonStyle,
      buttonEmoji: r.buttonEmoji,
      buttonEmojiId: r.buttonEmojiId,
      startAt: r.startAt.toISOString(),
      endAt: r.endAt.toISOString(),
      status: r.status,
      chatId: r.chatId,
      messageId: r.messageId,
      winners: parseWinners(r.winners),
      entriesCount: countMap.get(r.id) ?? 0,
      ticketsSum: ticketMap.get(r.id) ?? 0,
      createdAt: r.createdAt.toISOString(),
    }))
    return NextResponse.json({
      items,
      publishChannel: chanRow?.value?.trim() || DEFAULT_GIVEAWAY_CHANNEL,
    })
  } catch (e) {
    console.error('[panel/giveaways GET]', e)
    return err('Не удалось загрузить розыгрыши', 500)
  }
}

export async function POST(request: Request) {
  const g = guardAdmin(request, { limit: 60, windowMs: 60_000 })
  if (!g.ok) return g.res
  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('Проверьте поля розыгрыша')
    const d = parsed.data

    if (d.action === 'create' || d.action === 'update') {
      const prizes = serializePrizes(d.prizes)
      const startAt = new Date(d.startAt)
      const endAt = new Date(d.endAt)
      if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
        return err('Проверьте даты начала и итогов')
      }
      if (endAt.getTime() <= startAt.getTime()) {
        return err('Итоги должны быть позже начала')
      }
      const total = totalWinners(prizes)
      if (total > 2000) return err('Слишком много призовых мест (максимум 2000)')
      const data = {
        title: d.title,
        text: d.text,
        prizes: JSON.stringify(prizes),
        channels: JSON.stringify(parseChannels(JSON.stringify(d.channels))),
        buttonStyle: d.buttonStyle,
        buttonEmoji: d.buttonEmoji || '🎉',
        buttonEmojiId: d.buttonEmojiId,
        startAt,
        endAt,
      }
      if (d.action === 'create') {
        const created = await db.giveaway.create({
          data: { ...data, status: 'draft' },
        })
        await logAdmin('ops', 'giveaway:create', { id: created.id, title: d.title }).catch(() => {})
        return NextResponse.json({ ok: true, id: created.id })
      }
      const target = await db.giveaway.findUnique({ where: { id: d.id }, select: { status: true } })
      if (!target) return err('Розыгрыш не найден', 404)
      if (target.status === 'active' || target.status === 'finished') {
        return err('Активный/завершённый розыгрыш редактировать нельзя')
      }
      await db.giveaway.update({ where: { id: d.id }, data })
      await logAdmin('ops', 'giveaway:update', { id: d.id, title: d.title }).catch(() => {})
      return NextResponse.json({ ok: true, id: d.id })
    }

    if (d.action === 'publish') {
      const gw = await db.giveaway.findUnique({ where: { id: d.id } })
      if (!gw) return err('Розыгрыш не найден', 404)
      if (gw.status === 'finished') return err('Розыгрыш уже завершён')
      if (gw.status === 'active') return err('Розыгрыш уже опубликован')

      const now = new Date()
      if (gw.startAt.getTime() > now.getTime()) {
        // В будущее — запланировать: ленивый планировщик опубликует сам
        await db.giveaway.updateMany({
          where: { id: gw.id, status: 'draft' },
          data: { status: 'scheduled' },
        })
        await logAdmin('ops', 'giveaway:schedule', { id: gw.id, startAt: gw.startAt.toISOString() }).catch(() => {})
        return NextResponse.json({
          ok: true,
          scheduled: true,
          message: `Запланировано — бот опубликует ${gw.startAt.toLocaleString('ru-RU')}`,
        })
      }

      const r = await publishGiveawayPost(gw)
      if (!r.ok || !r.chatId || !r.messageId) {
        return err(r.error ?? 'Telegram отклонил публикацию')
      }
      await db.giveaway.update({
        where: { id: gw.id },
        data: { status: 'active', chatId: r.chatId, messageId: r.messageId },
      })
      await logAdmin('ops', 'giveaway:publish', { id: gw.id, messageId: r.messageId }).catch(() => {})
      return NextResponse.json({ ok: true, published: true, messageId: r.messageId })
    }

    if (d.action === 'delete') {
      const gw = await db.giveaway.findUnique({ where: { id: d.id }, select: { status: true } })
      if (!gw) return err('Розыгрыш не найден', 404)
      if (gw.status === 'active') return err('Сначала отмените активный розыгрыш')
      await db.giveaway.delete({ where: { id: d.id } })
      await logAdmin('ops', 'giveaway:delete', { id: d.id }).catch(() => {})
      return NextResponse.json({ ok: true })
    }

    if (d.action === 'cancel') {
      const gw = await db.giveaway.findUnique({ where: { id: d.id }, select: { status: true } })
      if (!gw) return err('Розыгрыш не найден', 404)
      if (gw.status === 'finished') return err('Розыгрыш уже завершён')
      await db.giveaway.update({ where: { id: d.id }, data: { status: 'cancelled' } })
      await logAdmin('ops', 'giveaway:cancel', { id: d.id }).catch(() => {})
      return NextResponse.json({ ok: true })
    }

    if (d.action === 'finalize') {
      const gw = await db.giveaway.findUnique({ where: { id: d.id }, select: { status: true } })
      if (!gw) return err('Розыгрыш не найден', 404)
      if (gw.status !== 'active') return err('Финализировать можно только активный розыгрыш')
      const r = await finalizeGiveaway(d.id)
      if (!r.ok) return err(r.error ?? 'Не удалось завершить')
      await logAdmin('ops', 'giveaway:finalize', { id: d.id, winners: r.winners }).catch(() => {})
      return NextResponse.json({ ok: true, winners: r.winners })
    }

    if (d.action === 'sweep') {
      const r = await checkDueGiveaways()
      return NextResponse.json({ ok: true, ...r })
    }

    // channel
    const v = d.value.trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '')
    await db.botSetting.upsert({
      where: { key: 'giveaway_channel' },
      create: { key: 'giveaway_channel', value: v },
      update: { value: v },
    })
    await logAdmin('ops', 'giveaway:channel', { channel: v || DEFAULT_GIVEAWAY_CHANNEL }).catch(() => {})
    return NextResponse.json({ ok: true, channel: v || DEFAULT_GIVEAWAY_CHANNEL })
  } catch (e) {
    console.error('[panel/giveaways POST]', e)
    return err('Ошибка операции розыгрыша', 500)
  }
}

/** HTML-превью поста для конструктора (то, что увидит канал, только без tg-emoji) */
export async function PUT(request: Request) {
  const g = guardAdmin(request, { limit: 60, windowMs: 60_000 })
  if (!g.ok) return g.res
  try {
    const body = (await readJson(request)) as {
      title?: string
      text?: string
      prizes?: z.infer<typeof prizeSchema>[]
      channels?: string[]
      endAt?: string
    }
    const prizes = serializePrizes(body.prizes ?? [])
    const channels = parseChannels(JSON.stringify(body.channels ?? []))
    const endAt = body.endAt ? new Date(body.endAt) : new Date(Date.now() + 86_400_000)
    const html = giveawayPostHtml({
      title: (body.title ?? 'Розыгрыш').slice(0, 120),
      text: (body.text ?? '').slice(0, 3500),
      prizes: JSON.stringify(prizes),
      channels: JSON.stringify(channels),
      endAt: Number.isNaN(endAt.getTime()) ? new Date(Date.now() + 86_400_000) : endAt,
    })
    return NextResponse.json({ ok: true, html: stripTgEmoji(html) })
  } catch {
    return err('Не удалось собрать превью', 500)
  }
}
