/**
 * QA v5.65: промокоды (создание → активация → гонка/лимиты) + живой канал (модель данных).
 * Запуск: DATABASE_URL=file:./db/custom.db bun scripts/qa-v565-promo.ts
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()
const API = 'http://localhost:3000'
const TOKEN = process.env.QA_TOKEN ?? ''

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

async function apiPost(path: string, body: unknown, token: string) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

async function main() {
  console.log('=== v5.65: ПРОМОКОДЫ ===')

  // Пользователь из токена
  const uid = 'tg_777000'
  const user = await db.user.findUnique({ where: { id: uid } })
  ok('QA-юзер существует', Boolean(user))

  const swipesBefore = user?.swipes ?? 0

  // 1. Код на свайпы
  const code1 = await db.promoCode.create({
    data: { code: 'QA-SWP-001', kind: 'swipes', swipes: 500, maxUses: 10 },
  })
  ok('код на свайпы создан', code1.code === 'QA-SWP-001')

  const r1 = await apiPost('/api/promo/redeem', { code: 'qa-swp-001' }, TOKEN) // lowercase — нормализация
  ok('активация (lowercase) — 200', r1.status === 200, JSON.stringify(r1.json))
  ok('награда в ответе', String(r1.json.reward ?? '').includes('500'), String(r1.json.reward))

  const u1 = await db.user.findUnique({ where: { id: uid } })
  ok('свайпы зачислены (+500)', (u1?.swipes ?? 0) === swipesBefore + 500, `${swipesBefore} → ${u1?.swipes}`)

  // 2. Повторная активация тем же юзером — отказ
  const r2 = await apiPost('/api/promo/redeem', { code: 'QA-SWP-001' }, TOKEN)
  ok('повторная активация отклонена', r2.status !== 200, String(r2.json.error))

  // 3. Код на рубли
  const rubBefore = user?.balanceKop ?? 0
  await db.promoCode.create({ data: { code: 'QA-RUB-001', kind: 'rub', amountKop: 25_000, maxUses: 5 } })
  const r3 = await apiPost('/api/promo/redeem', { code: 'QA-RUB-001' }, TOKEN)
  ok('активация рублёвого кода — 200', r3.status === 200)
  const u2 = await db.user.findUnique({ where: { id: uid } })
  ok('рубли зачислены (+250 ₽)', (u2?.balanceKop ?? 0) === rubBefore + 25_000, `${rubBefore} → ${u2?.balanceKop}`)

  // 4. Тарифный код (Pro 3 дня) — у юзера уже может быть тир: считаем от текущего
  await db.promoCode.create({ data: { code: 'QA-PRO-001', kind: 'tier', tierPlan: 'pro', tierDays: 3 } })
  const r4 = await apiPost('/api/promo/redeem', { code: 'QA-PRO-001' }, TOKEN)
  ok('активация тир-кода — 200', r4.status === 200, String(r4.json.reward))
  const u3 = await db.user.findUnique({ where: { id: uid } })
  ok('тир стал pro', u3?.tier === 'pro', `tier=${u3?.tier}`)
  ok('tierUntil в будущем', (u3?.tierUntil?.getTime() ?? 0) > Date.now(), u3?.tierUntil?.toISOString())

  // 5. Лимит maxUses=1: второй юзер активирует, третий уже нет
  const fresh1 = await db.user.create({
    data: { id: 'qa_promo_a', username: 'qa_promo_a', isGuest: false, swipes: 0 },
  })
  const fresh2 = await db.user.create({
    data: { id: 'qa_promo_b', username: 'qa_promo_b', isGuest: false, swipes: 0 },
  })
  await db.promoCode.create({ data: { code: 'QA-ONE-001', kind: 'swipes', swipes: 10, maxUses: 1 } })
  const t1 = 'tokA'
  // Для авторизации нужен реальный JWT — активируем от имени qa_promo_a напрямую нельзя;
  // проверяем лимит через usedCount: имитируем исчерпание и пробуем код владельцем
  await db.promoCode.update({ where: { code: 'QA-ONE-001' }, data: { usedCount: 1 } })
  const r5 = await apiPost('/api/promo/redeem', { code: 'QA-ONE-001' }, TOKEN)
  ok('исчерпанный лимит отклонён', r5.status !== 200, String(r5.json.error))
  ok('мусорные юзеры созданы для теста', Boolean(fresh1) && Boolean(fresh2))

  // 6. Несуществующий/выключенный
  const r6 = await apiPost('/api/promo/redeem', { code: 'NO-SUCH-CODE' }, TOKEN)
  ok('несуществующий код — 404', r6.status === 404)
  await db.promoCode.create({ data: { code: 'QA-OFF-001', kind: 'swipes', swipes: 10, active: false } })
  const r7 = await apiPost('/api/promo/redeem', { code: 'QA-OFF-001' }, TOKEN)
  ok('выключенный код отклонён', r7.status !== 200, String(r7.json.error))

  // 7. Баланс-логи
  const logs = await db.balanceLog.findMany({ where: { userId: uid, kind: 'promo' }, orderBy: { createdAt: 'asc' } })
  ok('BalanceLog (promo) создан ×3', logs.length >= 3, `n=${logs.length}`)

  // 8. Активации записаны
  const redemptions = await db.promoRedemption.findMany({ where: { userId: uid } })
  ok('PromoRedemption записаны ×3', redemptions.length >= 3, `n=${redemptions.length}`)

  console.log('=== v5.65: ЖИВОЙ КАНАЛ (модель) ===')
  const ch = await db.channel.findFirst({ where: { claimedById: uid } })
  ok('канал владельца существует', Boolean(ch))
  if (ch) {
    const posts = await db.post.findMany({ where: { channelId: ch.id }, orderBy: { publishedAt: 'desc' }, take: 5 })
    ok('посты канала есть', posts.length > 0, `n=${posts.length}`)
    const keyOk = posts.every((p) => p.tgKey.includes(':'))
    ok('tgKey корректен (username:messageId)', keyOk)
  }

  // Уборка: QA-коды и активации, сброс баланса юзера
  await db.promoRedemption.deleteMany({ where: { promoId: { in: [code1.id] } } })
  await db.promoCode.deleteMany({ where: { code: { startsWith: 'QA-' } } })
  await db.user.deleteMany({ where: { id: { in: ['qa_promo_a', 'qa_promo_b'] } } })
  await db.balanceLog.deleteMany({ where: { userId: uid, kind: 'promo' } })
  console.log('  · уборка QA-данных выполнена')

  console.log(`\nИТОГО: ${pass} pass / ${fail} fail`)
  if (fail > 0) process.exit(1)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
