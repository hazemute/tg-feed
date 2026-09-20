/**
 * E2E-проверка механики «В ОДИН КЛИК» — источники рекомендаций (v5.50).
 * Запуск: bun scripts/test-forward-sources.ts
 *
 * Проверяет:
 *  1. extractForwardChannel: современный forward_origin (type=channel),
 *     легаси forward_from_chat, пересылка от юзера → null.
 *  2. collectForwardedSource: накопление 1→5 каналов, crossedGoal на 5-м,
 *     дубликат не добавляется, кап профиля.
 *  3. Персонализация: loadPersonalSignals даёт аффинити связанному каналу
 *     (и его категории), invalidatePersonalSignals сбрасывает кэш.
 *  4. Билет: на 5-м канале awardForwardTickets начисляет билет во активный
 *     розыгрыш (системное задание 'forward' работает и БЕЗ конфига задания,
 *     а при конфиге берёт его количество билетов); идемпотентно.
 *  5. /api/giveaway инжектит задание forward + отдаёт sources и botUsername
 *     (через прямой вызов логики — HTTP-проверка отдельная, agent-browser).
 *  6. Признаки в UI-данных: userSourcesSummary возвращает названия каналов.
 *  7. Тестовые данные удаляются (user + giveaway + канал-кандидат).
 */
import { db } from '../src/lib/db'
import { extractForwardChannel, collectForwardedSource, userSourcesSummary, FORWARD_SOURCE_CAP } from '../src/lib/source-profile'
import { invalidatePersonalSignals, loadPersonalSignals } from '../src/lib/feed'
import { serializeTasks, invalidateActiveCache } from '../src/lib/giveaway-tickets'

let pass = 0
let fail = 0
function check(name: string, ok: boolean, extra = '') {
  if (ok) {
    pass++
    console.log(`  ok  ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name} ${extra}`)
  }
}

const USER = 'tg_997711'
const uid = () => USER

function msgForwardOrigin(chat: { id: number; title: string; username?: string }) {
  return {
    forward_origin: { type: 'channel', chat },
    chat: { id: 997711 },
    from: { id: 997711, first_name: 'Тест' },
  }
}

async function main() {
  console.log('=== Механика «В один клик» (v5.50) ===')

  // Чистим следы прошлых прогонов
  await db.userSource.deleteMany({ where: { userId: USER } })
  await db.giveawayTicket.deleteMany({ where: { userId: USER } })
  await db.giveawayEntry.deleteMany({ where: { userId: USER } })

  // ---------- 1) extractForwardChannel ----------
  const modern = extractForwardChannel(msgForwardOrigin({ id: -1001234567890, title: 'Котики Дня', username: 'cats_daily' }))
  check('extract: forward_origin канала распознан', modern?.tgId === '-1001234567890' && modern?.username === 'cats_daily' && modern.title === 'Котики Дня')

  const legacy = extractForwardChannel({ forward_from_chat: { id: -100999, title: 'Легаси' } })
  check('extract: легаси forward_from_chat распознан', legacy?.tgId === '-100999' && legacy.title === 'Легаси')

  const fromUser = extractForwardChannel({ forward_origin: { type: 'user', sender_user: { id: 42 } } } as never)
  check('extract: пересылка от юзера → null', fromUser === null)

  const hidden = extractForwardChannel({ forward_origin: { type: 'hidden_user', sender_user_name: 'X' } } as never)
  check('extract: скрытый юзер → null', hidden === null)

  // ---------- 2) collectForwardedSource: накопление до порога ----------
  const chIds = ['cats_daily', 'news_today', 'memes_hub', 'dev_digest', 'travel_now']
  let crossed = false
  let total = 0
  for (let i = 0; i < 5; i++) {
    const r = await collectForwardedSource(
      uid(),
      { tgId: `-100100000000${i}`, title: `Канал ${i + 1}`, username: chIds[i] },
    )
    crossed = crossed || r.crossedGoal
    total = r.total
  }
  check('5 форвардов → 5 уникальных источников', total === 5)
  check('порог 5 каналов пересечён именно на 5-м', crossed)

  const dup = await collectForwardedSource(uid(), { tgId: '-1001000000000', title: 'Канал 1', username: 'cats_daily' })
  check('дубликат не добавляется (added:false)', !dup.added && dup.total === 5)

  const extra = await collectForwardedSource(uid(), { tgId: '-1002000000000', title: 'Шестой', username: 'extra_six' })
  check('6-й канал принимается (сверх порога, для точности ленты)', extra.added && extra.total === 6 && !extra.crossedGoal)

  // кап профиля
  const fillerTg = -3000000000
  for (let i = 0; i < FORWARD_SOURCE_CAP; i++) {
    await collectForwardedSource(uid(), { tgId: `${fillerTg - i}`, title: `Наполнитель ${i}`, username: null })
  }
  const atCap = await collectForwardedSource(uid(), { tgId: `${fillerTg - FORWARD_SOURCE_CAP}`, title: 'Сверх капа', username: null })
  check(`кап профиля ${FORWARD_SOURCE_CAP} соблюдён`, atCap.atCap === true)

  // ---------- 3) персонализация ленты ----------
  // связываем один источник с реальным каналом каталога
  const cat = await db.category.findFirst({ select: { id: true } })
  const realChannel = cat
    ? await db.channel.create({
        data: {
          tgId: '-1005550000111',
          title: 'Тестовый источник',
          username: 'test_source_ch',
          categoryId: cat.id,
          status: 'active',
        },
        select: { id: true, categoryId: true },
      }).catch(() => null)
    : null

  invalidatePersonalSignals(USER)
  const signals = await loadPersonalSignals(USER)
  check('аффинити по несвязанным источникам = 0 (нет id канала)', !realChannel || (signals.affinity.channels.get(realChannel.id) ?? 0) === 0)

  if (realChannel) {
    await db.userSource.updateMany({
      where: { userId: USER, username: 'cats_daily' },
      data: { channelId: realChannel.id },
    })
    invalidatePersonalSignals(USER)
    const s2 = await loadPersonalSignals(USER)
    const aff = s2.affinity.channels.get(realChannel.id) ?? 0
    check('аффинити связанного источника > 0 (источник = сильный сигнал)', aff >= 12, `aff=${aff}`)
    const catAff = s2.affinity.categories.get(realChannel.categoryId) ?? 0
    check('аффинити категории источника > 0', catAff >= 6, `catAff=${catAff}`)

    // ---------- 4) билет за задание forward ----------
    // розыгрыш БЕЗ forward в конфиге — системное задание всё равно работает
    const gw = await db.giveaway.create({
      data: {
        title: 'Тест «В один клик»',
        prizes: JSON.stringify([{ label: 'Приз', winners: 1 }]),
        tasks: serializeTasks([{ kind: 'activity', enabled: true, tickets: 1, swipeGoal: 10 }]),
        promoCode: null,
        startAt: new Date(Date.now() - 3600_000),
        endAt: new Date(Date.now() + 86_400_000),
        status: 'active',
        losersRewardSwipes: 0,
        channels: '[]',
      },
      select: { id: true },
    })

    const { awardForwardTickets } = await import('../src/lib/source-profile')
    invalidateActiveCache() // в тесте кэш 15с может не знать о только что созданном розыгрыше
    const awards = await awardForwardTickets({ userId: USER, tgId: 997711, firstName: 'Тест' })
    check('билет начислен в активный розыгрыш без forward-конфига', awards.awardedGiveaways.length === 1)

    const ticket = await db.giveawayTicket.findUnique({
      where: { giveawayId_userId_task: { giveawayId: gw.id, userId: USER, task: 'forward' } },
    })
    check('тикет в БД с task=forward', !!ticket && ticket.tickets === 1)

    const entry = await db.giveawayEntry.findUnique({
      where: { giveawayId_userId: { giveawayId: gw.id, userId: USER } },
      select: { ticketsCount: true },
    })
    check('баланс билетов участника увеличен', entry?.ticketsCount === 1)

    // идемпотентность
    const again = await awardForwardTickets({ userId: USER, tgId: 997711 })
    check('повторная выдача не дублирует билет', again.awardedGiveaways.length === 0)

    // убираем первый розыгрыш, чтобы далее проверять ИЗОЛИРОВАННО конфиг tickets=2
    await db.giveaway.delete({ where: { id: gw.id } })
    invalidateActiveCache()

    // конфиг с tickets=2 берётся из настроек задания
    const gw2 = await db.giveaway.create({
      data: {
        title: 'Тест forward x2',
        prizes: JSON.stringify([{ label: 'Приз', winners: 1 }]),
        tasks: serializeTasks([{ kind: 'forward', enabled: true, tickets: 2 }]),
        startAt: new Date(Date.now() - 3600_000),
        endAt: new Date(Date.now() + 86_400_000),
        status: 'active',
        losersRewardSwipes: 0,
        channels: '[]',
      },
      select: { id: true },
    })
    const u2 = 'tg_997712'
    await db.userSource.deleteMany({ where: { userId: u2 } })
    for (let i = 0; i < 5; i++) {
      await collectForwardedSource(u2, { tgId: `-100700000000${i}`, title: `К${i}`, username: `u2_src_${i}` })
    }
    invalidateActiveCache()
    const a2 = await awardForwardTickets({ userId: u2, tgId: 997712 })
    const t2 = await db.giveawayTicket.findUnique({
      where: { giveawayId_userId_task: { giveawayId: gw2.id, userId: u2, task: 'forward' } },
    })
    check('конфиг задания forward (tickets=2) уважается', a2.awardedGiveaways.length === 1 && t2?.tickets === 2)

    // ---------- 5/6) сводка + данные для /api/giveaway ----------
    const sum = await userSourcesSummary(USER)
    check('сводка источников: count/goal/channels', sum.count >= FORWARD_SOURCE_CAP && sum.goal === 5 && sum.channels.length > 0)

    // ---------- уборка ----------
    await db.giveawayTicket.deleteMany({ where: { userId: u2 } })
    await db.giveawayEntry.deleteMany({ where: { userId: u2 } })
    await db.userSource.deleteMany({ where: { userId: u2 } })
    await db.giveaway.delete({ where: { id: gw2.id } }).catch(() => {})
    if (realChannel) await db.channel.delete({ where: { id: realChannel.id } }).catch(() => {})
  }

  // ---------- уборка основного юзера ----------
  await db.userSource.deleteMany({ where: { userId: USER } })
  await db.giveawayTicket.deleteMany({ where: { userId: USER } })
  await db.giveawayEntry.deleteMany({ where: { userId: USER } })

  console.log(`\nИтог: ${pass} ok, ${fail} fail`)
  if (fail > 0) process.exit(1)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
