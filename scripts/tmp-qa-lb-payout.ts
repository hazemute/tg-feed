/** QA: награды лидербордов — сид XP за прошлую неделю/месяц + прогон выплат. Удалить перед коммитом. */
import { PrismaClient } from '@prisma/client'
import { lbPeriodOf, lbPrevPeriodOf, runLbPayouts } from '../src/lib/lb-payouts'

const p = new PrismaClient()

async function main() {
  const users = [
    { id: 'lb_alpha', username: 'lb_alpha', firstName: 'Аня', isGuest: false, xp: 5000, level: 9, swipes: 12000 },
    { id: 'lb_bravo', username: 'lb_bravo', firstName: 'Борис', isGuest: false, xp: 3200, level: 8, swipes: 8000 },
    { id: 'lb_charlie', username: 'lb_charlie', firstName: 'Вера', isGuest: false, xp: 2100, level: 7, swipes: 40000 },
    { id: 'tg_555000111', username: 'the_admin', firstName: 'АдминТест', isGuest: false, xp: 90000, level: 30, swipes: 999000 },
    { id: 'qa_wallet_tester', username: 'qa_wallet_tester', firstName: 'QA Wallet', isGuest: false, xp: 1240, level: 6, swipes: 25000 },
  ]
  for (const u of users) await p.user.upsert({ where: { id: u.id }, update: u, create: u })

  const ids = users.map((u) => u.id)
  // Чистка прошлых QA-артефактов, чтобы прогон был воспроизводимым
  await p.leaderboardPayout.deleteMany({ where: { userId: { in: ids } } })
  await p.botSetting.deleteMany({ where: { key: { startsWith: 'lb_payout:' } } })
  await p.xpLog.deleteMany({ where: { userId: { in: ids }, note: { startsWith: 'qa-lb' } } })

  const prevWeek = lbPrevPeriodOf('week')
  const prevMonth = lbPrevPeriodOf('month')
  const curWeek = lbPeriodOf('week')
  const logs = [
    { userId: 'lb_alpha', kind: 'quest', amount: 40, note: 'qa-lb-week', createdAt: new Date(prevWeek.start.getTime() + 24 * 3_600_000) },
    { userId: 'lb_bravo', kind: 'comment', amount: 25, note: 'qa-lb-week', createdAt: new Date(prevWeek.start.getTime() + 48 * 3_600_000) },
    { userId: 'qa_wallet_tester', kind: 'checkin', amount: 10, note: 'qa-lb-week', createdAt: new Date(prevWeek.end.getTime() - 3_600_000) },
    { userId: 'tg_555000111', kind: 'admin', amount: 100, note: 'qa-lb-week', createdAt: new Date(prevWeek.start.getTime() + 36 * 3_600_000) }, // админ — НЕ платим
    { userId: 'lb_alpha', kind: 'quest', amount: 55, note: 'qa-lb-month', createdAt: new Date(prevMonth.start.getTime() + 48 * 3_600_000) },
    { userId: 'lb_charlie', kind: 'comment', amount: 35, note: 'qa-lb-month', createdAt: new Date(prevMonth.end.getTime() - 5 * 3_600_000) },
    { userId: 'lb_alpha', kind: 'comment', amount: 12, note: 'qa-lb-live', createdAt: new Date(curWeek.start.getTime() + 3_600_000) },
    { userId: 'qa_wallet_tester', kind: 'checkin', amount: 8, note: 'qa-lb-live', createdAt: new Date(curWeek.start.getTime() + 7_200_000) },
  ]
  await p.xpLog.createMany({ data: logs })
  console.log('seeded: 4 юзера прошлой недели (1 админ-исключение), 2 за месяц, 2 живых')

  const r1 = await runLbPayouts()
  console.log('RUN1 week paid:', r1.week.paid.map((x) => `#${x.place} ${x.userId} +${x.amount}`).join(', ') || 'ничего')
  console.log('RUN1 month paid:', r1.month.paid.map((x) => `#${x.place} ${x.userId} +${x.amount}`).join(', ') || 'ничего')

  const r2 = await runLbPayouts()
  console.log('RUN2 идемпотентность: week', r2.week.paid.length, '/ month', r2.month.paid.length, '(ожидается 0/0)')

  const payouts = await p.leaderboardPayout.findMany({ orderBy: [{ period: 'asc' }, { place: 'asc' }] })
  console.log('rows:', payouts.map((x) => `${x.period}/${x.periodKey} ${x.userId} #${x.place} +${x.amount}`).join(' | '))
  const adminPaid = payouts.some((x) => x.userId === 'tg_555000111')
  console.log('АДМИН УЧАСТВОВАЛ?!', adminPaid ? 'ДА — БАГ' : 'нет (ок)')
  const qa = await p.user.findUnique({ where: { id: 'qa_wallet_tester' }, select: { swipes: true } })
  console.log('qa swipes now:', qa?.swipes, '(было 25000, ожидается 30000)')
}

main().finally(() => p.$disconnect())
