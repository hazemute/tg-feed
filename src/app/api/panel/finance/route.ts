import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { err, IS_SQLITE } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'

export const dynamic = 'force-dynamic'

type DayRow = { d: string; kop: number; n: number }
type CountRow = { d: string; n: number }

/**
 * v6.3.1: сырые запросы «Финансов» теперь работают и на Postgres (прод), и на
 * SQLite (песочница) — раньше to_char/date_trunc/INTERVAL падали локально и
 * вкладка «Финансы» показывала «Не удалось загрузить финансы» в dev-сборках.
 * Даты-границы передаём параметрами (одинаково для обеих СУБД), выражение дня
 * и CAST — по провайдеру.
 */
const dayExpr = IS_SQLITE
  ? // Prisma в SQLite хранит DateTime как INTEGER (мс) → unixepoch
    Prisma.sql`strftime('%Y-%m-%d', "createdAt" / 1000, 'unixepoch')`
  : Prisma.sql`to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD')`

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000)

/**
 * GET /api/panel/finance — «Финансы» + вовлечённость (v5.11, приказ владельца:
 * «статистика сколько проект заработал и тд… DAU и так далее»).
 *
 * Выручка: платежи PendingPayment(status='succeeded') — Platega/Stars/TON,
 * рекламная выручка — AdCampaign.spentKop (списано с рекламодателей за клики).
 * Обязательства: суммарный баланс пользователей AdvertiserAccount.balanceKop
 * (нераспределённые свайпы). Активность: DAU/WAU/MAU по PostView, новые юзеры,
 * лайки/комментарии по дням.
 */
export async function GET(request: Request) {
  const g = guardAdmin(request, { limit: 120, windowMs: 60_000, bucket: 'panel-finance' })
  if (!g.ok) return g.res

  try {
    const [totals, byProvider, byDayRaw, adsAgg, liabAgg, walletAgg, dauRow, wauRow, mauRow, usersDayRaw, likesDayRaw, commentsDayRaw] =
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
          SELECT ${dayExpr} AS d,
                 CAST(SUM("amountKop") AS INTEGER) AS kop, CAST(COUNT(*) AS INTEGER) AS n
          FROM "PendingPayment"
          WHERE status = 'succeeded' AND "createdAt" >= ${daysAgo(30)}
          GROUP BY ${dayExpr} ORDER BY 1`,
        db.adCampaign.aggregate({ _sum: { spentKop: true }, _count: true }),
        db.advertiserAccount.aggregate({ _sum: { balanceKop: true }, _count: true }),
        // v5.54: реальный долг перед юзерами — кошельки User (рубли + свайпы в рублёвом эквиваленте),
        // а не легаси AdvertiserAccount, выведенный из оборота в v5.39
        db.user.aggregate({ _sum: { balanceKop: true, swipes: true }, _count: true }),
        db.$queryRaw<{ n: number }[]>`SELECT CAST(COUNT(DISTINCT "userId") AS INTEGER) AS n FROM "PostView" WHERE "createdAt" >= ${daysAgo(1)}`,
        db.$queryRaw<{ n: number }[]>`SELECT CAST(COUNT(DISTINCT "userId") AS INTEGER) AS n FROM "PostView" WHERE "createdAt" >= ${daysAgo(7)}`,
        db.$queryRaw<{ n: number }[]>`SELECT CAST(COUNT(DISTINCT "userId") AS INTEGER) AS n FROM "PostView" WHERE "createdAt" >= ${daysAgo(30)}`,
        db.$queryRaw<CountRow[]>`
          SELECT ${dayExpr} AS d, CAST(COUNT(*) AS INTEGER) AS n
          FROM "User" WHERE "createdAt" >= ${daysAgo(14)} GROUP BY ${dayExpr} ORDER BY 1`,
        db.$queryRaw<CountRow[]>`
          SELECT ${dayExpr} AS d, CAST(COUNT(*) AS INTEGER) AS n
          FROM "Like" WHERE "createdAt" >= ${daysAgo(14)} GROUP BY ${dayExpr} ORDER BY 1`,
        db.$queryRaw<CountRow[]>`
          SELECT ${dayExpr} AS d, CAST(COUNT(*) AS INTEGER) AS n
          FROM "Comment" WHERE "createdAt" >= ${daysAgo(14)} GROUP BY ${dayExpr} ORDER BY 1`,
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
        // v5.54: настоящие обязательства — User-кошельки (рубли + свайпы по курсу 500/₽)
        userBalanceKop: walletAgg._sum.balanceKop ?? 0,
        userSwipes: walletAgg._sum.swipes ?? 0,
        users: walletAgg._count,
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
