/**
 * КОМПЛЕКСНЫЙ ТЕСТ БИЛЕТНОЙ СИСТЕМЫ РОЗЫГРЫШЕЙ (v5.66).
 *
 * Проверяет весь жизненный цикл билетов и розыгрыша на локальной БД:
 *   1. awardTicket: выдача, идемпотентность (unique), согласованность баланса
 *   2. redeemPromoCode: неверный/верный/повторный код
 *   3. activity: ленивая досчёт по просмотрам (checkAndAwardAuto)
 *   4. referral: recordReferral → activateReferrals → билет пригласившему
 *   5. forward: системное задание работает даже без конфига
 *   6. task_disabled: задание не из конфига → отказ
 *   7. pickWinnersWeighted: уникальность победителей + влияние весов (статистика)
 *   8. finalizeGiveaway: призы победителям, утешительные проигравшим,
 *      участники с 0 билетов не участвуют, идемпотентность повторного вызова
 *
 * Запуск: DATABASE_URL=file:./db/custom.db bun scripts/test-giveaway-tickets.ts
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`)
  } else {
    fail++
    console.log(`  ✗ FAIL ${name}${extra ? ` — ${extra}` : ''}`)
  }
}
function section(t: string) {
  console.log(`\n=== ${t} ===`)
}

const DAY = 86_400_000

async function main() {
  /* ------------------------------ сид ------------------------------ */
  section('СИД')
  const stamp = Date.now().toString(36)
  // юзеры уникальны на каждый запуск — прогон не зависит от прошлых данных в общей БД
  const R = 10_000 + Math.floor(Math.random() * 90_000)
  const users: Array<{ id: string; tg: number }> = [1, 2, 3, 4].map((i) => ({
    id: `tg_${R}${i}00`,
    tg: Number(`${R}${i}00`),
  }))
  for (const u of users) {
    await db.user.upsert({
      where: { id: u.id },
      update: { swipes: 0, balanceKop: 0 },
      create: { id: u.id, username: `qa${u.tg}`, firstName: `QA${u.tg}`, swipes: 0, isGuest: false },
    })
  }
  ok('4 тестовых юзера готовы', true, users.map((u) => u.id).join(', '))

  const cat = await db.category.upsert({
    where: { slug: 'other' },
    update: {},
    create: { slug: 'other', title: 'Прочее', emoji: '✨' },
  })
  const ch = await db.channel.create({
    data: {
      tgId: `qa_gw_${stamp}`,
      username: `qa_gw_${stamp}`,
      title: 'QA Giveaway Channel',
      categoryId: cat.id,
    },
  })
  const posts = []
  for (let i = 0; i < 5; i++) {
    posts.push(
      await db.post.create({
        data: {
          channelId: ch.id,
          tgKey: `qa_gw_${stamp}_${i}`,
          text: `QA giveaway пост №${i} — тест билетной системы`,
          publishedAt: new Date(Date.now() - (6 - i) * 3600_000),
        },
      }),
    )
  }
  ok('канал + 5 постов созданы', posts.length === 5)

  // Розыгрыш №1: активный, задания activity(3 просмотра, 2 билета) + promo(1) + referral(1 друг, 2 билета)
  // forward в конфиг НЕ включён — заодно проверим системное поведение
  const gw1 = await db.giveaway.create({
    data: {
      title: 'QA Розыгрыш №1',
      status: 'active',
      startAt: new Date(Date.now() - 3600_000),
      endAt: new Date(Date.now() + DAY),
      tasks: JSON.stringify([
        { kind: 'activity', enabled: true, tickets: 2, swipeGoal: 3 },
        { kind: 'promo', enabled: true, tickets: 1 },
        { kind: 'referral', enabled: true, tickets: 2, referralGoal: 1 },
      ]),
      promoCode: 'QAGW2026',
      prizes: JSON.stringify([
        { kind: 'swipes', label: 'Первое место', winners: 1, amount: 1000 },
        { kind: 'swipes', label: 'Второе место', winners: 1, amount: 500 },
      ]),
      losersRewardSwipes: 50,
    },
  })
  ok('розыгрыш №1 активен', gw1.status === 'active')

  /* --------------------------- awardTicket --------------------------- */
  section('1. AWARD TICKET: база и идемпотентность')
  const ctxU1 = { id: users[0]!.id, tgId: users[0]!.tg, username: `qa${users[0]!.tg}`, firstName: `QA${users[0]!.tg}` }

  const a1 = await awardTicket({ giveawayId: gw1.id, userId: ctxU1.id, task: 'promo', ...ctxU1 })
  ok('первый билет выдан', a1.ok === true && a1.awarded === true && a1.ticketsCount === 1, `count=${a1.ticketsCount}`)

  const a2 = await awardTicket({ giveawayId: gw1.id, userId: ctxU1.id, task: 'promo', ...ctxU1 })
  ok('повтор — уже выдавался (already)', a2.ok === true && a2.awarded === false && a2.reason === 'already')

  const entry1 = await db.giveawayEntry.findUnique({
    where: { giveawayId_userId: { giveawayId: gw1.id, userId: ctxU1.id } },
    include: { tickets: true },
  })
  const sumTickets = entry1?.tickets.reduce((s, t) => s + t.tickets, 0) ?? 0
  ok('согласованность: ticketsCount == Σ(билеты)', entry1?.ticketsCount === sumTickets, `${entry1?.ticketsCount} == ${sumTickets}`)
  ok('в журнале ровно 1 запись promo', entry1?.tickets.filter((t) => t.task === 'promo').length === 1)

  const a3 = await awardTicket({ giveawayId: gw1.id, userId: ctxU1.id, task: 'boost' })
  ok('задание не из конфига → task_disabled', a3.ok === false && a3.reason === 'task_disabled')

  const a4 = await awardTicket({ giveawayId: 'nonexistent', userId: ctxU1.id, task: 'promo' })
  ok('несуществующий розыгрыш → no_giveaway', a4.ok === false && a4.reason === 'no_giveaway')

  /* --------------------------- промокод --------------------------- */
  section('2. ПРОМОКОД РОЗЫГРЫША')
  const ctxU2 = { id: users[1]!.id, tgId: users[1]!.tg, username: `qa${users[1]!.tg}`, firstName: `QA${users[1]!.tg}` }

  const p1 = await redeemPromoCode(ctxU2, 'NEVERNYI')
  ok('неверный код отклонён', p1.ok === false, p1.message)

  const p2 = await redeemPromoCode(ctxU2, 'qagw2026') // lowercase — нормализация
  ok('верный код (lowercase) принят', p2.ok === true && (p2.message ?? '').includes('+1'), p2.message)

  const p3 = await redeemPromoCode(ctxU2, 'QAGW2026')
  ok('повторный код — «уже был»', p3.ok === true && !(p3.message ?? '').includes('+'), p3.message)

  /* --------------------------- активность --------------------------- */
  section('3. АКТИВНОСТЬ: ленивая досчёт по просмотрам')
  const before = await activityProgress(gw1.id, gw1.startAt, ctxU2.id)
  ok('прогресс = 0 просмотров', before === 0)

  // 2 просмотра из 3 — не хватает
  await db.postView.create({ data: { userId: ctxU2.id, postId: posts[0]!.id } })
  await db.postView.create({ data: { userId: ctxU2.id, postId: posts[1]!.id } })
  await checkAndAwardAuto(ctxU2)
  let e2 = await db.giveawayEntry.findUnique({
    where: { giveawayId_userId: { giveawayId: gw1.id, userId: ctxU2.id } },
    include: { tickets: true },
  })
  ok('2/3 просмотров — билета activity нет', !(e2?.tickets ?? []).some((t) => t.task === 'activity'), `count=${e2?.ticketsCount}`)

  // третий просмотр — цель достигнута
  await db.postView.create({ data: { userId: ctxU2.id, postId: posts[2]!.id } })
  await checkAndAwardAuto(ctxU2)
  e2 = await db.giveawayEntry.findUnique({
    where: { giveawayId_userId: { giveawayId: gw1.id, userId: ctxU2.id } },
    include: { tickets: true },
  })
  const act = e2?.tickets.find((t) => t.task === 'activity')
  ok('3/3 — билет activity выдан (2 билета)', !!act && act.tickets === 2, `tickets=${act?.tickets}`)
  ok('баланс U2 = 1(promo) + 2(activity) = 3', e2?.ticketsCount === 3, `count=${e2?.ticketsCount}`)

  await checkAndAwardAuto(ctxU2) // повтор
  const e2b = await db.giveawayEntry.findUnique({
    where: { giveawayId_userId: { giveawayId: gw1.id, userId: ctxU2.id } },
    include: { tickets: true },
  })
  ok('повторный checkAndAwardAuto не задвоил', (e2b?.tickets ?? []).filter((t) => t.task === 'activity').length === 1)

  /* --------------------------- рефералы --------------------------- */
  section('4. РЕФЕРАЛЫ: приглашение → активация → билет')
  const r1 = await recordReferral(users[1]!.tg, users[2]!.tg)
  ok('приглашение записано', r1.ok === true && r1.already === false)
  const r2 = await recordReferral(users[1]!.tg, users[2]!.tg)
  ok('дедуп повторного приглашения', r2.ok === true && r2.already === true)
  const r3 = await recordReferral(users[2]!.tg, users[2]!.tg)
  ok('самоприглашение запрещено', r3.ok === false)

  // друг ещё НЕ открыл миниапп — билета нет (только ленивая досчёт, без активации)
  await checkAndAwardAuto(ctxU2)
  let eU2 = await db.giveawayEntry.findUnique({
    where: { giveawayId_userId: { giveawayId: gw1.id, userId: ctxU2.id } },
    include: { tickets: true },
  })
  ok('друг не активен — билета referral нет', !(eU2?.tickets ?? []).some((t) => t.task === 'referral'))

  // друг открыл миниапп (auth активирует приглашение)
  await activateReferrals(users[2]!.id, users[2]!.tg) // идемпотентно
  // симулируем активацию: invitedUserId + activatedAt (в проде это делает /api/auth)
  await db.giveawayReferral.updateMany({
    where: { referrerUserId: ctxU2.id, invitedTgId: String(users[2]!.tg) },
    data: { activatedAt: new Date(), invitedUserId: users[2]!.id },
  })
  await activateReferrals(users[2]!.id, users[2]!.tg)
  eU2 = await db.giveawayEntry.findUnique({
    where: { giveawayId_userId: { giveawayId: gw1.id, userId: ctxU2.id } },
    include: { tickets: true },
  })
  const ref = eU2?.tickets.find((t) => t.task === 'referral')
  ok('друг активен → билет referral (2 билета)', !!ref && ref.tickets === 2, `tickets=${ref?.tickets}`)
  ok('баланс U2 = 3 + 2 = 5', eU2?.ticketsCount === 5, `count=${eU2?.ticketsCount}`)

  /* --------------------------- forward (системное) --------------------------- */
  section('5. FORWARD: системное задание')
  const ctxU3 = { id: users[2]!.id, tgId: users[2]!.tg }
  const f1 = await awardTicket({ giveawayId: gw1.id, userId: ctxU3.id, task: 'forward', ...ctxU3 })
  ok('forward выдаётся, даже если его нет в конфиге', f1.ok === true && f1.awarded === true, `count=${f1.ticketsCount}`)

  /* --------------------------- взвешенный рандом --------------------------- */
  section('6. PICK WINNERS WEIGHTED')
  {
    const pool = [
      { userId: 'A', tickets: 9 },
      { userId: 'B', tickets: 1 },
    ]
    let aWins = 0
    for (let i = 0; i < 1000; i++) {
      const w = pickWinnersWeighted(pool, 1)
      if (w[0]?.userId === 'A') aWins++
    }
    ok('вес влияет: A(9 билетов) побеждает ~90%', aWins > 820 && aWins < 980, `${aWins}/1000`)

    const three = [
      { userId: 'A', tickets: 1 },
      { userId: 'B', tickets: 2 },
      { userId: 'C', tickets: 3 },
    ]
    const w3 = pickWinnersWeighted(three, 5)
    ok('мест меньше пула: все уникальны, максимум 3', w3.length === 3 && new Set(w3.map((w) => w.userId)).size === 3)

    const zero = [{ userId: 'Z', tickets: 0 }]
    ok('пул с 0 билетов → нет победителей', pickWinnersWeighted(zero, 1).length === 0)

    const dup = pickWinnersWeighted([{ userId: 'S', tickets: 5 }], 10)
    ok('пул из одного — ровно один победитель', dup.length === 1 && dup[0]!.userId === 'S')
  }

  /* --------------------------- финализация --------------------------- */
  section('7. ФИНАЛИЗАЦИЯ: призы, утешительные, идемпотентность')

  // U4 — «кликнул и ушёл»: заявка есть, билетов 0 → в розыгрыше не участвует
  await db.giveawayEntry.create({ data: { giveawayId: gw1.id, userId: users[3]!.id, tgId: String(users[3]!.tg) } })

  // U2 — заведомо лидер (5 билетов), U1 — 1, U3 — 1 → места: 1-е и 2-е
  const fin1 = await finalizeGiveaway(gw1.id)
  ok('финализация прошла', fin1.ok === true && fin1.winners === 2, `winners=${fin1.winners}`)

  const gAfter = await db.giveaway.findUnique({ where: { id: gw1.id } })
  const winners = JSON.parse(gAfter?.winners ?? '[]') as Array<{ userId: string; prizeIndex: number; tickets?: number }>
  ok('победителей ровно 2', winners.length === 2)
  // РЕГРЕССИЯ v5.66: раньше splice-перестановка дублировала одного победителя и
  // теряла другого (один и тот же объект в массиве дважды)
  ok('все победители УНИКАЛЬНЫ (регрессия дубликата)', new Set(winners.map((w) => w.userId)).size === winners.length)
  ok('победители только из пула с билетами', winners.every((w) => [ctxU1.id, ctxU2.id, users[2]!.id].includes(w.userId)))
  ok('участник с 0 билетов НЕ победил', !winners.some((w) => w.userId === users[3]!.id))
  ok('призовые места 0 и 1 на РАЗНЫХ победителях', winners.some((w) => w.prizeIndex === 0) && winners.some((w) => w.prizeIndex === 1))

  // Каждому победителю начислен ровно ЕГО приз (по prizeIndex), всего 1000+500
  const prizeLogs = await db.balanceLog.findMany({ where: { userId: { in: users.map((u) => u.id) }, kind: 'admin', note: { contains: 'Приз розыгрыша' } } })
  const totalPrizeSwp = prizeLogs.filter((l) => l.currency === 'swp').reduce((s, l) => s + l.amount, 0)
  ok('сумма призов = 1500 свайпов (1000+500, без дублей)', prizeLogs.filter((l) => l.currency === 'swp').length === 2 && totalPrizeSwp === 1500, `итого=${totalPrizeSwp}`)
  for (const w of winners) {
    const expect = w.prizeIndex === 0 ? 1000 : 500
    const has = prizeLogs.some((l) => l.userId === w.userId && l.amount === expect)
    ok(`победителю ${w.userId} начислен приз по его месту (${expect})`, has)
  }

  // идемпотентность: повторная финализация не меняет ничего
  const logsBeforeRepeat = await db.balanceLog.count({ where: { userId: { in: users.map((u) => u.id) }, kind: 'admin', note: { contains: 'Приз розыгрыша' } } })
  const fin2 = await finalizeGiveaway(gw1.id)
  const logsAfterRepeat = await db.balanceLog.count({ where: { userId: { in: users.map((u) => u.id) }, kind: 'admin', note: { contains: 'Приз розыгрыша' } } })
  ok('повтор finalize — без двойных начислений', fin2.ok === true && logsBeforeRepeat === logsAfterRepeat, `${logsBeforeRepeat} == ${logsAfterRepeat}`)
  const gAfter2 = await db.giveaway.findUnique({ where: { id: gw1.id } })
  ok('список победителей стабилен', gAfter2?.winners === gAfter?.winners)

  /* ------------------- утешительные (розыгрыш №2) ------------------- */
  section('8. УТЕШИТЕЛЬНЫЕ СВАЙПЫ ПРОИГРАВШИМ')
  const gw2 = await db.giveaway.create({
    data: {
      title: 'QA Розыгрыш №2 (утешительные)',
      status: 'active',
      startAt: new Date(Date.now() - 3600_000),
      endAt: new Date(Date.now() + DAY),
      tasks: JSON.stringify([{ kind: 'activity', enabled: true, tickets: 1, swipeGoal: 1 }]),
      prizes: JSON.stringify([{ kind: 'rub', label: 'Главный приз', winners: 1, amount: 30000 }]),
      losersRewardSwipes: 75,
    },
  })
  // U1 и U2 по 3 билета, U3 — 0 (не участвует). Победит ровно 1 → второй получит 75 свайпов.
  for (const u of [users[0]!, users[1]!]) {
    await db.giveawayEntry.create({ data: { giveawayId: gw2.id, userId: u.id, tgId: String(u.tg), ticketsCount: 3 } })
    await db.giveawayTicket.create({ data: { giveawayId: gw2.id, entryId: (await db.giveawayEntry.findUniqueOrThrow({ where: { giveawayId_userId: { giveawayId: gw2.id, userId: u.id } } })).id, userId: u.id, task: 'manual', tickets: 3, note: 'QA сид' } })
  }
  await db.giveawayEntry.create({ data: { giveawayId: gw2.id, userId: users[2]!.id, tgId: String(users[2]!.tg), ticketsCount: 0 } })

  await db.giveaway.update({ where: { id: gw2.id }, data: { endAt: new Date(Date.now() - 1000), status: 'active' } })
  const fin3 = await finalizeGiveaway(gw2.id)
  ok('финализация №2 прошла (1 победитель)', fin3.ok === true && fin3.winners === 1, `winners=${fin3.winners}`)

  const winnerId = (JSON.parse((await db.giveaway.findUniqueOrThrow({ where: { id: gw2.id } })).winners ?? '[]') as Array<{ userId: string }>)[0]!.userId
  const loserId = winnerId === users[0]!.id ? users[1]!.id : users[0]!.id
  const loserLogs = await db.balanceLog.findMany({ where: { userId: loserId, kind: 'admin', currency: 'swp', amount: 75, note: { contains: 'Утешительный' } } })
  ok('проигравший получил 75 утешительных свайпов (журнал)', loserLogs.length === 1)

  const zeroLogs = await db.balanceLog.findMany({ where: { userId: users[2]!.id, kind: 'admin', currency: 'swp', note: { contains: 'QA Розыгрыш №2' } } })
  ok('участник с 0 билетов НЕ получил утешительных', zeroLogs.length === 0)

  const winnerRubLogs = await db.balanceLog.findMany({ where: { userId: winnerId, kind: 'admin', currency: 'rub', amount: 30000 } })
  ok('победитель получил 300 ₽ призом (журнал)', winnerRubLogs.length === 1)

  // идемпотентность №2
  await finalizeGiveaway(gw2.id)
  const loserLogs2 = await db.balanceLog.count({ where: { userId: loserId, kind: 'admin', currency: 'swp', amount: 75 } })
  const winnerRubLogs2 = await db.balanceLog.count({ where: { userId: winnerId, kind: 'admin', currency: 'rub', amount: 30000 } })
  ok('повтор finalize №2 — ничего не задвоилось', loserLogs2 === 1 && winnerRubLogs2 === 1)

  /* --------------------------- итог --------------------------- */
  console.log(`\n=============================================`)
  console.log(`ИТОГ: ${pass} ok, ${fail} fail`)
  console.log(`=============================================`)
  if (fail > 0) process.exit(1)
}

import { awardTicket, redeemPromoCode, checkAndAwardAuto, activityProgress, recordReferral, activateReferrals, pickWinnersWeighted, referralProgress } from '../src/lib/giveaway-tickets'
import { finalizeGiveaway } from '../src/lib/giveaways'

main()
  .catch((e) => {
    console.error('FATAL', e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
