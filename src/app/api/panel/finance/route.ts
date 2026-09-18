import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'

export const dynamic = 'force-dynamic'

type DayRow = { d: string; kop: number; n: number }
type CountRow = { d: string; n: number }

/**
 * GET /api/panel/finance — «Финансы» + вовлечённость (v5.11, приказ владельца:
 * «статистика сколько проект заработал и тд… DAU и так далее»).
 *
 * Выручка: платежи PendingPayment(status='succeeded') — ЮKassa/Stars/TON,
 * рекламная выручка — AdCampaign.spentKop (списано с рекламодателей за клики).
 * Обязательства: суммарный баланс пользователей AdvertiserAccount.balanceKop
 * (нераспределённые свайпы). Активность: DAU/WAU/MAU по PostView, новые юзеры,
 * лайки/комментарии по дням.
 */
export async function GET(request: Request) {
  const g = guardAdmin(request, { limit: 120, windowMs: 60_000, bucket: 'panel-finance' })
  if (!g.ok) return g.res

  try {
    const [totals, byProvider, byDayRaw, adsAgg, liabAgg, dauRow, wauRow, mauRow, usersDayRaw, likesDayRaw, commentsDayRaw] =
      await Promise.all([
        db.pendingPayment.aggregate({
          where: { status: 'succeeded' },
          _sum: { amountKop: true },
          _count: true,
        }),
        db.pendingPayment.groupBy({
          by: ['provider'],
          where: { status: 'succeeded' },
          _sum: { amountKop: true },
          _count: true,
        }),
        db.$queryRaw<DayRow[]>`
          SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS d,
                 SUM("amountKop")::int AS kop, COUNT(*)::int AS n
          FROM "PendingPayment"
          WHERE status = 'succeeded' AND "createdAt" >= NOW() - INTERVAL '30 days'
          GROUP BY 1 ORDER BY 1`,
        db.adCampaign.aggregate({ _sum: { spentKop: true }, _count: true }),
        db.advertiserAccount.aggregate({ _sum: { balanceKop: true }, _count: true }),
        db.$queryRaw<{ n: number }[]>`SELECT COUNT(DISTINCT "userId")::int AS n FROM "PostView" WHERE "createdAt" >= NOW() - INTERVAL '1 day'`,
        db.$queryRaw<{ n: number }[]>`SELECT COUNT(DISTINCT "userId")::int AS n FROM "PostView" WHERE "createdAt" >= NOW() - INTERVAL '7 days'`,
        db.$queryRaw<{ n: number }[]>`SELECT COUNT(DISTINCT "userId")::int AS n FROM "PostView" WHERE "createdAt" >= NOW() - INTERVAL '30 days'`,
        db.$queryRaw<CountRow[]>`
          SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS d, COUNT(*)::int AS n
          FROM "User" WHERE "createdAt" >= NOW() - INTERVAL '14 days' GROUP BY 1 ORDER BY 1`,
        db.$queryRaw<CountRow[]>`
          SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS d, COUNT(*)::int AS n
          FROM "Like" WHERE "createdAt" >= NOW() - INTERVAL '14 days' GROUP BY 1 ORDER BY 1`,
        db.$queryRaw<CountRow[]>`
          SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS d, COUNT(*)::int AS n
          FROM "Comment" WHERE "createdAt" >= NOW() - INTERVAL '14 days' GROUP BY 1 ORDER BY 1`,
      ])

    return NextResponse.json({
      revenue: {
        totalKop: totals._sum.amountKop ?? 0,
        paymentsCount: totals._count,
        byProvider: byProvider.map((p) => ({
          provider: p.provider,
          kop: p._sum.amountKop ?? 0,
          count: p._count,
        })),
        byDay: byDayRaw.map((r) => ({ day: r.d, kop: Number(r.kop), count: Number(r.n) })),
      },
      ads: {
        spentKop: adsAgg._sum.spentKop ?? 0,
        campaigns: adsAgg._count,
      },
      liabilities: {
        balanceKop: liabAgg._sum.balanceKop ?? 0,
        accounts: liabAgg._count,
      },
      engagement: {
        dau: Number(dauRow[0]?.n ?? 0),
        wau: Number(wauRow[0]?.n ?? 0),
        mau: Number(mauRow[0]?.n ?? 0),
        newUsersByDay: usersDayRaw.map((r) => ({ day: r.d, count: Number(r.n) })),
        likesByDay: likesDayRaw.map((r) => ({ day: r.d, count: Number(r.n) })),
        commentsByDay: commentsDayRaw.map((r) => ({ day: r.d, count: Number(r.n) })),
      },
    })
  } catch (e) {
    console.error('[panel/finance]', e)
    return err('finance failed', 500)
  }
}
