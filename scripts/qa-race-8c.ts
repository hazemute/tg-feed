/**
 * QA (task 8-c): подготовка активного QA-розыгрыша для curl-гонки + либ-гонки.
 *  1) активирует розыгрыш (status active, задания promo+manual, промокод RACE8C)
 *  2) 20 ПАРАЛЛЕЛЬНЫХ joinGiveaway одним юзером  → ровно 1 GiveawayEntry
 *  3) 20 ПАРАЛЛЕЛЬНЫХ awardTicket(manual) тем же юзером → ровно 1 тикет
 * Запуск: bun scripts/qa-race-8c.ts <giveawayId>
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  const giveawayId = process.argv[2]
  if (!giveawayId) throw new Error('usage: bun scripts/qa-race-8c.ts <giveawayId>')

  const tasks = JSON.stringify([
    { kind: 'promo', enabled: true, tickets: 2 },
    { kind: 'manual', enabled: true, tickets: 5 },
  ])
  await db.giveaway.update({
    where: { id: giveawayId },
    data: {
      status: 'active',
      tasks,
      promoCode: 'RACE8C',
      losersRewardSwipes: 0,
      startAt: new Date(Date.now() - 60_000),
      endAt: new Date(Date.now() + 2 * 3600_000),
    },
  })
  console.log('giveaway activated:', giveawayId)

  // QA-юзер (уникален, не пересекается с продовыми)
  const user = { id: 'tg_990877001', tgId: 990877001, username: 'qa_race8c', firstName: 'QA Race' }
  await db.user.upsert({
    where: { id: user.id },
    update: {},
    create: { id: user.id, username: user.username, firstName: user.firstName, isGuest: false },
  })

  // --- ГОНКА 1: 20 параллельных «Участвовать» ---
  const joinResults = await Promise.all(
    Array.from({ length: 20 }, () =>
      import('../src/lib/giveaways').then((m) =>
        m.joinGiveaway(giveawayId, user).catch((e) => ({ ok: false as const, reason: 'thrown', message: String(e) })),
      ),
    ),
  )
  const joinOk = joinResults.filter((r) => r.ok).length
  const joinAlready = joinResults.filter((r) => r.ok && (r as { already?: boolean }).already).length
  const entries = await db.giveawayEntry.count({ where: { giveawayId, userId: user.id } })
  console.log(`JOIN RACE: ok=${joinOk}/20, already=${joinAlready}, entries_in_db=${entries}`)
  if (entries !== 1 || joinOk !== 20) {
    throw new Error(`JOIN RACE FAILED: entries=${entries}, ok=${joinOk}`)
  }

  // --- ГОНКА 2: 20 параллельных awardTicket(manual) ---
  const { awardTicket } = await import('../src/lib/giveaway-tickets')
  const awardResults = await Promise.all(
    Array.from({ length: 20 }, () =>
      awardTicket({ giveawayId, userId: user.id, task: 'manual', tickets: 5, ...user }),
    ),
  )
  const awardedNow = awardResults.filter((r) => r.ok && r.awarded).length
  const already = awardResults.filter((r) => r.ok && !r.awarded && r.reason === 'already').length
  const tickets = await db.giveawayTicket.count({ where: { giveawayId, userId: user.id, task: 'manual' } })
  const entry = await db.giveawayEntry.findUnique({
    where: { giveawayId_userId: { giveawayId, userId: user.id } },
    select: { ticketsCount: true, tasksDone: true },
  })
  const sumTickets = await db.giveawayTicket.aggregate({ where: { giveawayId, userId: user.id }, _sum: { tickets: true } })
  console.log(
    `AWARD RACE: awarded=${awardedNow}/20, already=${already}, ticket_rows=${tickets}, ` +
      `ticketsCount=${entry?.ticketsCount}, sum_tickets=${sumTickets._sum.tickets ?? 0}`,
  )
  if (tickets !== 1 || awardedNow !== 1 || entry?.ticketsCount !== 5) {
    throw new Error(`AWARD RACE FAILED: rows=${tickets}, awarded=${awardedNow}, count=${entry?.ticketsCount}`)
  }
  const journal = JSON.parse(entry?.tasksDone ?? '[]') as Array<{ task: string }>
  console.log(`tasksDone journal entries: ${journal.length} (ожидаемо 1)`)
  console.log('OK: гонки гасятся уникальностями — 1 вход, 1 тикет, вес 5')
}

main()
  .catch((e) => {
    console.error('FATAL', e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
