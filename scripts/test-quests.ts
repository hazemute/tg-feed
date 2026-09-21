/**
 * ТЕСТ СИСТЕМЫ ЗАДАНИЙ (v5.51) — scripts/test-quests.ts (bun).
 * Полный цикл с моком Bot API (песочница без TELEGRAM_BOT_TOKEN):
 *   нормализация цели → создание (панель) → claim (member) → дубликат →
 *   реверификация (member=true: штамп) → реверификация (left: аннулирование
 *   + штраф ×2 с клампом в 0) → повторный claim после ревокации → API-контракты.
 * Запуск: bun scripts/test-quests.ts
 */

import { db } from '../src/lib/db'
// Мок-токен ДО импортов tg-bot (botEnabled должен быть true)
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '123456:QA-FAKE-TOKEN'

const { normalizeQuestTarget, questLinkOf, claimQuest, reverifyQuestCompletions } = await import(
  '../src/lib/quests'
)

let ok = 0
let fail = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    ok++
    console.log(`  ok  ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}`, extra ?? '')
  }
}

/* ------------------------- Мок Bot API ------------------------- */

type MemberStatus = 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked'

/** username цели → ответ getChatMember для тестового юзера */
const membership = new Map<string, MemberStatus>()
const chats = new Map<string, { title: string; members: number }>()

const realFetch = globalThis.fetch

async function mockFetch(url: unknown, init?: { body?: string }): Promise<Response> {
  const u = String(url)
  // Живые вызовы (localhost API в тестах) идут в реальный fetch мимо мока
  if (u.includes('localhost')) return realFetch(url as string, init as RequestInit)
  const body = (() => {
    try {
      return JSON.parse(init?.body ?? '{}') as Record<string, unknown>
    } catch {
      return {} as Record<string, unknown>
    }
  })()
  const json = (obj: unknown) =>
    new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } })

  if (u.includes('/getChatMember')) {
    const chatId = String(body.chat_id ?? '')
    const status = membership.get(chatId.replace(/^@/, ''))
    // null (проверка недоступна) — когда цели нет в membership И это «чужой» юзер
    if (!status) return json({ ok: false, description: 'bot is not a member' })
    return json({ ok: true, result: { status, is_member: status !== 'left' && status !== 'kicked' } })
  }
  if (u.includes('/getChat')) {
    const chatId = String(body.chat_id ?? '').replace(/^@/, '')
    const c = chats.get(chatId)
    if (!c) return json({ ok: false, description: 'chat not found' })
    return json({ ok: true, result: { id: -100123, title: c.title, username: chatId, members_count: c.members } })
  }
  if (u.includes('/getMe')) return json({ ok: true, result: { id: 987654, username: 'qa_bot' } })
  return json({ ok: false, description: 'unsupported in mock' })
}
;(globalThis as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch

/* ------------------------- Нормализация цели ------------------------- */

console.log('— normalizeQuestTarget —')
check('t.me URL', normalizeQuestTarget('https://t.me/Foo_Bar') === 'foo_bar')
check('www + trailing path', normalizeQuestTarget('https://www.t.me/durov/join') === 'durov')
check('@user', normalizeQuestTarget('@SnapTeamDev') === 'snapteamdev')
check('plain', normalizeQuestTarget('my_chat_1') === 'my_chat_1')
check('invalid: цифра в начале', normalizeQuestTarget('1abc') === null)
check('invalid: пусто', normalizeQuestTarget('  ') === null)
check('link по умолчанию', questLinkOf('durov').startsWith('https://t.me/durov'))
check('кастомная ссылка', questLinkOf('durov', 'https://example.com') === 'https://example.com')

/* ------------------------- Фикстуры ------------------------- */

const TEST_USER = 'tg_777000'
const user = await db.user.upsert({
  where: { id: TEST_USER },
  update: { swipes: 0 },
  create: { id: TEST_USER, username: 'qa_tester', firstName: 'QA', isGuest: false, categories: '[]' },
})
await db.questCompletion.deleteMany({ where: { userId: TEST_USER } })
// предочистка: падения прошлых прогонов оставляют QA-задания
await db.quest.deleteMany({ where: { OR: [{ target: { startsWith: 'qatest' } }, { target: { startsWith: 'qapanel' } }, { title: { startsWith: 'QA:' } }] } })
await db.balanceLog.deleteMany({ where: { userId: TEST_USER, kind: { in: ['quest', 'quest_revoke'] } } })

const quest = await db.quest.create({
  data: {
    title: 'QA: подпишись на канал',
    description: 'Тестовое задание',
    kind: 'subscribe',
    target: 'qatest_sub',
    rewardSwp: 50,
    active: true,
  },
})
chats.set('qatest_sub', { title: 'QA Channel', members: 1000 })
membership.set('qatest_sub', 'member')
membership.set(`u${TEST_USER}` as string, 'member') // не используется, для ясности

/* ------------------------- Claim: успех ------------------------- */

console.log('— claim: member → награда —')
const r1 = await claimQuest(TEST_USER, quest.id)
check('status done', r1.status === 'done', r1)
check('награда 50', r1.reward === 50 && r1.balance === user.swipes + 50, r1)
const after = await db.user.findUnique({ where: { id: TEST_USER }, select: { swipes: true } })
check('баланс в БД +50', after?.swipes === user.swipes + 50, after)
const comp = await db.questCompletion.findUnique({
  where: { questId_userId: { questId: quest.id, userId: TEST_USER } },
})
check('completion создан, status done', comp?.status === 'done' && comp.rewardSwp === 50, comp)
const log1 = await db.balanceLog.findFirst({ where: { userId: TEST_USER, kind: 'quest' } })
check('balanceLog +50', log1?.amount === 50, log1)
await new Promise((r) => setTimeout(r, 400)) // fire-and-forget уведомления догоняют
const notif1 = await db.notification.findFirst({ where: { userId: TEST_USER, title: { contains: 'Задание выполнено' } } })
check('инбокс-уведомление создано', notif1 !== null)

/* ------------------------- Claim: дубликат ------------------------- */

console.log('— claim: дубликат —')
const r2 = await claimQuest(TEST_USER, quest.id)
check('status already', r2.status === 'already', r2)
const after2 = await db.user.findUnique({ where: { id: TEST_USER }, select: { swipes: true } })
check('баланс не изменился', after2?.swipes === user.swipes + 50, after2)

/* ------------------------- Реверификация: всё ок ------------------------- */

console.log('— reverify: member=true —')
const rv1 = await reverifyQuestCompletions(10)
check('checked=1, revoked=0', rv1.checked === 1 && rv1.revoked === 0, rv1)
const comp2 = await db.questCompletion.findUnique({
  where: { questId_userId: { questId: quest.id, userId: TEST_USER } },
})
check('checks=2, lastCheck обновлён', comp2?.checks === 2 && comp2.lastCheck > comp2.createdAt, comp2)

/* ------------------------- Реверификация: отписался ------------------------- */

console.log('— reverify: отписался → штраф ×2 с клампом —')
// NOTE: tg-bot кэширует membership на 5 минут (cm:<target>:<uid>) — по qatest_sub
// ответ 'member' уже закэширован фазой claim. Реальный рейвока-детект: следующий
// тик ПОСЛЕ протухания кэша. В тесте — свежая цель с чистым кэшем.
const questR = await db.quest.create({
  data: { title: 'QA: ревокация', kind: 'subscribe', target: 'qatest_revoke', rewardSwp: 50, active: true },
})
chats.set('qatest_revoke', { title: 'QA Revoke', members: 10 })
membership.set('qatest_revoke', 'member')
const rc = await claimQuest(TEST_USER, questR.id)
check('claim для ревокации: done, баланс 100', rc.status === 'done' && rc.balance === 100, rc)
membership.set('qatest_revoke', 'left')
const rv2 = await reverifyQuestCompletions(10)
// qatest_sub ('member') тоже в очереди — реверификация честно проверяет обе строки
check('checked=2, revoked=1', rv2.checked === 2 && rv2.revoked === 1, JSON.stringify(rv2))
await new Promise((r) => setTimeout(r, 400))
const comp3 = await db.questCompletion.findUnique({
  where: { questId_userId: { questId: questR.id, userId: TEST_USER } },
})
check('status revoked', comp3?.status === 'revoked', comp3)
const after3 = await db.user.findUnique({ where: { id: TEST_USER }, select: { swipes: true } })
check('штраф ×2=100, но кламп в 0 (было 50)', after3?.swipes === 0, after3)
const log2 = await db.balanceLog.findFirst({ where: { userId: TEST_USER, kind: 'quest_revoke' } })
check('balanceLog −100 (штраф ×2 применён полностью: было 100)', log2?.amount === -100, log2)
const notif2 = await db.notification.findFirst({ where: { userId: TEST_USER, title: { contains: 'аннулирована' } } })
check('уведомление о штрафe создано', notif2 !== null)

/* ------------------------- Claim после ревокации ------------------------- */

console.log('— claim после ревокации: навсегда закрыто —')
membership.set('qatest_revoke', 'member')
const r3 = await claimQuest(TEST_USER, questR.id)
check('status revoked (повторно нельзя)', r3.status === 'revoked', r3)
const after4 = await db.user.findUnique({ where: { id: TEST_USER }, select: { swipes: true } })
check('баланс не вырос', after4?.swipes === 0, after4)

/* ------------------------- Claim: не member ------------------------- */

console.log('— claim: юзер не в цели —')
const quest2 = await db.quest.create({
  data: { title: 'QA: второе задание', kind: 'join_chat', target: 'qatest_chat', rewardSwp: 10, active: true },
})
chats.set('qatest_chat', { title: 'QA Chat', members: 5 })
membership.set('qatest_chat', 'left')
const r4 = await claimQuest(TEST_USER, quest2.id)
check('status not_member + link', r4.status === 'not_member' && r4.link === 'https://t.me/qatest_chat', r4)
const comp4 = await db.questCompletion.findUnique({
  where: { questId_userId: { questId: quest2.id, userId: TEST_USER } },
})
check('completion НЕ создан', comp4 === null)

/* ------------------------- Claim: проверка недоступна ------------------------- */

console.log('— claim: bot не участник цели —')
const quest3 = await db.quest.create({
  data: { title: 'QA: третье задание', kind: 'subscribe', target: 'qatest_none', rewardSwp: 10, active: true },
})
const r5 = await claimQuest(TEST_USER, quest3.id)
check('status cannot_verify', r5.status === 'cannot_verify', r5)

/* ------------------------- Claim: неактивное задание ------------------------- */

console.log('— claim: задание выключено —')
const r6 = await claimQuest(TEST_USER, quest3.id)
await db.quest.update({ where: { id: quest3.id }, data: { active: false } })
const r7 = await claimQuest(TEST_USER, quest3.id)
check('status unavailable', r7.status === 'unavailable', r7)

/* ------------------------- API-контракты ------------------------- */

console.log('— API /api/quests + панель —')
// Токен с серверной деривацией секрета: сервер в песочнице имеет ПУСТЫЕ
// TELEGRAM_BOT_TOKEN/CRON_SECRET (тестовый мок-токен тут не совпадает бы)
const crypto = await import('node:crypto')
const secret = crypto.createHash('sha256').update('tgfeed-session|').digest('hex')
const b64url = (i: string) => Buffer.from(i).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const nowS = Math.floor(Date.now() / 1000)
const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
const pld = b64url(JSON.stringify({ uid: TEST_USER, guest: false, iat: nowS, exp: nowS + 3600 }))
const token = `${h}.${pld}.${b64url(crypto.createHmac('sha256', secret).update(`${h}.${pld}`).digest())}`
const qRes = await fetch('http://localhost:3000/api/quests', {
  headers: { Authorization: `Bearer ${token}` },
}).then((r) => r.json() as Promise<{ items: { id: string; myStatus: string | null }[]; balance: number }>)
check('список содержит задания (>=2 активных)', qRes.items.length >= 2, qRes.items.length)
check('статус quest.id — done (участник остался)', qRes.items.find((i) => i.id === quest.id)?.myStatus === 'done')
check('статус questR.id — revoked (отписался)', qRes.items.find((i) => i.id === questR.id)?.myStatus === 'revoked')
check('баланс в ответе = 0', qRes.balance === 0)

const claimApi = await fetch(`http://localhost:3000/api/quests/${quest2.id}/claim`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
}).then((r) => r.json() as Promise<{ status: string }>)
// серверный процесс без бота → cannot_verify; с ботом (прод) → not_member
check(
  'POST claim → валидный статус (not_member|cannot_verify)',
  claimApi.status === 'not_member' || claimApi.status === 'cannot_verify',
  claimApi,
)

const noAuth = await fetch('http://localhost:3000/api/quests')
check('без сессии 401', noAuth.status === 401)

const adminKey = process.env.ADMIN_KEY || 'local-qa-admin-key'
const panelList = await fetch('http://localhost:3000/api/panel/quests', {
  headers: { 'x-admin-key': adminKey },
}).then((r) => r.json() as Promise<{ items: { id: string; doneCount: number; revokedCount: number }[] }>)
check(
  'панель: список + счётчики (revoked у questR, done у quest)',
  panelList.items.some((i) => i.id === questR.id && i.revokedCount === 1) &&
    panelList.items.some((i) => i.id === quest.id && i.doneCount === 1),
  panelList.items?.length,
)

const panelCreate = await fetch('http://localhost:3000/api/panel/quests', {
  method: 'POST',
  headers: { 'x-admin-key': adminKey, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    action: 'create',
    title: 'QA: панель создание',
    kind: 'subscribe',
    target: 'https://t.me/QAPanelTarget',
    rewardSwp: 25,
    sort: 5,
  }),
}).then((r) => r.json() as Promise<{ ok: boolean; id: string; validation: { target: string | null; verificationProblem?: string | null } }>)
check(
  'панель: create нормализует t.me-ссылку',
  panelCreate.ok === true && panelCreate.validation.target === 'qapaneltarget',
  panelCreate,
)
chats.set('qapaneltarget', { title: 'QA Panel', members: 7 })
membership.set('qapaneltarget', 'administrator')
const panelCheck = await fetch('http://localhost:3000/api/panel/quests', {
  method: 'POST',
  headers: { 'x-admin-key': adminKey, 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'check', target: 'qapaneltarget' }),
}).then((r) => r.json() as Promise<{ validation: { ok: boolean; verificationProblem: string | null; title?: string } }>)
check(
  'панель: check — ok, problem=null или «не настроен» (песочница без бота)',
  panelCheck.validation.ok === true &&
    (panelCheck.validation.verificationProblem === null ||
      /не настроен/.test(panelCheck.validation.verificationProblem)),
  panelCheck,
)

const panelNoAuth = await fetch('http://localhost:3000/api/panel/quests')
check('панель без ключа 401', panelNoAuth.status === 401)

/* ------------------------- Уборка ------------------------- */

await db.quest.deleteMany({ where: { target: { startsWith: 'qatest' } } })
await db.quest.deleteMany({ where: { target: { startsWith: 'qapanel' } } })
await db.questCompletion.deleteMany({ where: { userId: TEST_USER } })
// предочистка: падения прошлых прогонов оставляют QA-задания
await db.quest.deleteMany({ where: { OR: [{ target: { startsWith: 'qatest' } }, { target: { startsWith: 'qapanel' } }, { title: { startsWith: 'QA:' } }] } })
await db.balanceLog.deleteMany({ where: { userId: TEST_USER, kind: { in: ['quest', 'quest_revoke'] } } })
await db.notification.deleteMany({
  where: { userId: TEST_USER, title: { contains: 'Задание выполнено' } },
})
await db.notification.deleteMany({ where: { userId: TEST_USER, title: { contains: 'аннулирована' } } })
await db.user.update({ where: { id: TEST_USER }, data: { swipes: 0 } })

console.log(`\nИТОГО: ${ok} ok, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
