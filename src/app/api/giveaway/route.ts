import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import {
  activeGiveaways,
  checkAndAwardAuto,
  checkBoostTask,
  hasTicket,
  parseTasks,
  parseTasksDone,
  activityProgress,
  referralProgress,
  referralLinkFor,
  redeemPromoCode,
  taskTitle,
} from '@/lib/giveaway-tickets'
import { parsePrizes } from '@/lib/giveaways'
import { userSourcesSummary } from '@/lib/source-profile'
import { FORWARD_SOURCES_GOAL } from '@/lib/giveaway-tickets'
import { getBotUsername } from '@/lib/tg-bot'

export const dynamic = 'force-dynamic'

/**
 * РОЗЫГРЫШИ В МИНИАППЕ (v5.46).
 *
 * GET  /api/giveaway
 *   → активный розыгрыш (последний по endAt) + статус текущего пользователя:
 *     билеты, выполненные задания, живой прогресс (activity/referral),
 *     реферальная ссылка, профиль источников (v5.50 «В один клик» —
 *     пересылка постов из 5 любимых каналов) и юзернейм бота для кнопки
 *     пересылки. {giveaway:null} — активного нет (sources всё равно приходят).
 *
 * POST /api/giveaway { action }
 *   • {action:'promo', giveawayId, code} — ввести секретный промокод;
 *   • {action:'boost', giveawayId}       — проверить буст канала (getUserChatBoosts);
 *   • {action:'check', giveawayId}       — ленивая досчёт активности/рефералов.
 *
 * Всё только для привязанных к Telegram (гость → 401 {auth:true}).
 */

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('promo'),
    giveawayId: z.string().min(1).max(64),
    code: z.string().min(3).max(64),
  }),
  z.object({
    action: z.literal('boost'),
    giveawayId: z.string().min(1).max(64),
  }),
  z.object({
    action: z.literal('check'),
    giveawayId: z.string().min(1).max(64),
  }),
])

export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'giveaway-get' })
  if (!g.ok) return g.res
  if (g.guest) return NextResponse.json({ error: 'login required', auth: true }, { status: 401 })
  const uid = g.uid

  try {
    // Досчитываем «дозревшие» задания (активность/рефералы) — выдача идемпотентна
    await checkAndAwardAuto({ id: uid, tgId: Number(uid.slice(3)) || undefined })

    const gws = await activeGiveaways()
    const current = [...gws].sort((a, b) => b.endAt.getTime() - a.endAt.getTime())[0]
    if (!current) {
      // Розыгрыша нет, но профиль источников живёт всегда — фронт показывает
      // карточку «Перешли посты из 5 любимых каналов» без секции билетов
      const [sources, botUsername] = await Promise.all([
        userSourcesSummary(uid).catch(() => ({ count: 0, goal: FORWARD_SOURCES_GOAL, channels: [] })),
        getBotUsername().catch(() => null),
      ])
      return NextResponse.json({ giveaway: null, sources, botUsername })
    }

    const tasks = parseTasks(current.tasks)

    // v5.50: задание «источники» — системное (awardTicket не требует его в
    // конфиге), поэтому в UI показываем всегда, даже если организатор не
    // добавлял его в настройки розыгрыша
    const hasForwardInConfig = tasks.some((t) => t.kind === 'forward')
    if (!hasForwardInConfig) {
      tasks.push({ kind: 'forward', enabled: true, tickets: 1 })
    }
    const entry = await db.giveawayEntry.findUnique({
      where: { giveawayId_userId: { giveawayId: current.id, userId: uid } },
      select: { ticketsCount: true, tasksDone: true, createdAt: true },
    })

    // Живой прогресс по заданиям
    const progress: Record<string, number> = {}
    for (const t of tasks) {
      if (!t.enabled) continue
      if (t.kind === 'activity') {
        progress.activity = await activityProgress(current.id, current.startAt, uid)
      } else if (t.kind === 'referral') {
        progress.referral = await referralProgress(uid)
      }
    }

    // Какие билеты уже получены (для чек-марок)
    const done = parseTasksDone(entry?.tasksDone)
    const doneKinds = new Set(done.map((d) => d.task))

    const tgId = Number(uid.slice(3))
    const referralLink = Number.isInteger(tgId) && tgId > 0 ? await referralLinkFor(tgId) : null

    // v5.50: профиль источников «В один клик» + юзернейм бота для deep-link
    const [sources, botUsername] = await Promise.all([
      userSourcesSummary(uid).catch(() => ({ count: 0, goal: FORWARD_SOURCES_GOAL, channels: [] })),
      getBotUsername().catch(() => null),
    ])

    const meta = await db.giveaway.findUnique({
      where: { id: current.id },
      select: { prizes: true },
    })

    return NextResponse.json({
      giveaway: {
        id: current.id,
        title: current.title,
        endAt: current.endAt.toISOString(),
        prizes: parsePrizes(meta?.prizes ?? '[]'),
        tasks: tasks
          .filter((t) => t.enabled)
          .map((t) => ({
            kind: t.kind,
            tickets: t.tickets,
            title: taskTitle(t),
            swipeGoal: t.swipeGoal ?? null,
            referralGoal: t.referralGoal ?? null,
            boostChannel: t.boostChannel ?? null,
            done: doneKinds.has(t.kind),
          })),
      },
      entry: entry
        ? {
            ticketsCount: entry.ticketsCount,
            tasksDone: done,
            joinedAt: entry.createdAt.toISOString(),
          }
        : null,
      progress,
      referralLink,
      // v5.50: механика «В один клик» — профиль источников юзера
      sources,
      botUsername,
    })
  } catch (e) {
    console.error('[giveaway GET]', e)
    return err('giveaway failed', 500)
  }
}

export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 20, windowMs: 60_000, bucket: 'giveaway-post' })
  if (!g.ok) return g.res
  if (g.guest) return NextResponse.json({ error: 'login required', auth: true }, { status: 401 })
  const uid = g.uid
  const tgId = Number(uid.slice(3))
  const ctx = {
    id: uid,
    ...(Number.isInteger(tgId) && tgId > 0 ? { tgId } : {}),
  }

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('bad payload')
    const d = parsed.data

    if (d.action === 'promo') {
      const r = await redeemPromoCode(ctx, d.code)
      return NextResponse.json(r, { status: r.ok ? 200 : 400 })
    }

    if (d.action === 'boost') {
      if (!Number.isInteger(tgId) || tgId <= 0) return err('bad user', 400)
      const r = await checkBoostTask(d.giveawayId, { ...ctx, tgId })
      return NextResponse.json(r, { status: r.ok ? 200 : 400 })
    }

    // check — ленивая досчёт заданий (кнопка «Обновить» в карточке)
    const has = {
      activity: await hasTicket(d.giveawayId, uid, 'activity'),
      referral: await hasTicket(d.giveawayId, uid, 'referral'),
    }
    if (!has.activity || !has.referral) {
      await checkAndAwardAuto(ctx)
    }
    const entry = await db.giveawayEntry.findUnique({
      where: { giveawayId_userId: { giveawayId: d.giveawayId, userId: uid } },
      select: { ticketsCount: true },
    })
    return NextResponse.json({ ok: true, ticketsCount: entry?.ticketsCount ?? 0 })
  } catch (e) {
    console.error('[giveaway POST]', e)
    return err('giveaway failed', 500)
  }
}
