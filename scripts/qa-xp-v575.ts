/**
 * QA-скрипт v5.75: проверка системы XP/уровней на локальном dev-сервере.
 * Не является тестом в репозитории — одноразовая ручная проверка.
 *  1) /api/auth отдаёт xp/level
 *  2) /api/level — форма ответа
 *  3) POST комментария — +2 XP в ответе и в /api/level
 *  4) комментарий <10 символов — без XP
 *  5) флуд-дубликат скрыт (+40) — XP не получает (уникальный текст на прогон)
 *  6) прямой вызов grantXp (уровневый скачок) — свайпы + уведомление
 */
const TOKEN = (await Bun.file('/tmp/token.txt').text()).trim()
const H = { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const BASE = 'http://localhost:3000'

let fails = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ok  ${name}`)
  else {
    fails++
    console.log(`FAIL  ${name} ${extra}`)
  }
}

// 1) auth DTO содержит xp/level
const auth = await fetch(`${BASE}/api/auth`, { headers: H }).then((r) => r.json() as Promise<{ user?: { id: string; xp?: number; level?: number; isGuest: boolean } }>)
const uid = auth.user?.id
check('auth: xp/level в DTO', !!uid && typeof auth.user?.xp === 'number' && typeof auth.user?.level === 'number', JSON.stringify(auth.user ?? {}))

// Прямая запись: сброс XP в 0 для чистоты эксперимента
const { db } = await import('../src/lib/db')
await db.user.update({ where: { id: uid! }, data: { xp: 0, level: 1 } })
await db.xpLog.deleteMany({ where: { userId: uid! } })

// 2) /api/level
let lvl = await fetch(`${BASE}/api/level`, { headers: H }).then((r) => r.json() as Promise<any>)
check('level: старт 0 XP / ур.1', lvl.xp === 0 && lvl.level === 1, JSON.stringify(lvl))
check('level: пороги ур.2 = 100', lvl.levelEnd === 100, `levelEnd=${lvl.levelEnd}`)
check('level: награда за ур.2 = 140', lvl.nextRewardSwipes === 140, `reward=${lvl.nextRewardSwipes}`)

// ищем пост для комментария
const posts = await fetch(`${BASE}/api/feed?tab=all&limit=3`, { headers: H }).then((r) => r.json() as Promise<{ items?: { id: string }[] }>)
const postId = posts.items?.[0]?.id
check('feed: есть пост для комментария', !!postId, String(postId))

if (postId) {
  // 3) толковый комментарий → +2 XP
  const c1 = await fetch(`${BASE}/api/comments`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ postId, text: 'Отличный пост, спасибо за подробный разбор темы!' }),
  }).then((r) => r.json() as Promise<any>)
  check('comment: +2 XP в ответе', c1?.xp?.gained === 2, JSON.stringify(c1?.xp))
  lvl = await fetch(`${BASE}/api/level`, { headers: H }).then((r) => r.json())
  check('level: xp стал 2', lvl.xp === 2, `xp=${lvl.xp}`)
  check('level: история пополнилась (kind=comment)', lvl.history?.[0]?.kind === 'comment')

  // 4) короткий комментарий — без XP
  await fetch(`${BASE}/api/comments`, { method: 'POST', headers: H, body: JSON.stringify({ postId, text: 'ок 👍' }) })
  lvl = await fetch(`${BASE}/api/level`, { headers: H }).then((r) => r.json())
  check('comment: короткий — XP не растёт (xp=2)', lvl.xp === 2, `xp=${lvl.xp}`)

  // 5) ФЛУД: тот же текст дважды — второй скрыт (+40 flood bonus) и без XP.
  // (антиреклама v5.68 не прячет одиночный «мягкий» спам — это её штатное
  // поведение; экономика XP всё равно наказывает: скрытие по жалобам −15)
  // Уникальный суффикс на прогон: иначе прежний QA-прогон (в 6-часовом окне
  // антифлуда) уже оставил этот текст — и s1 будет скрыт как дубликат тоже
  const spamText = `Зарабатывай на крипте тут t.me/superpuper-${Date.now()} ProfitIncome crypto signals money fast`
  await fetch(`${BASE}/api/comments`, { method: 'POST', headers: H, body: JSON.stringify({ postId, text: spamText }) }).then((r) => r.json() as Promise<any>)
  const s2 = await fetch(`${BASE}/api/comments`, { method: 'POST', headers: H, body: JSON.stringify({ postId, text: spamText }) }).then((r) => r.json() as Promise<any>)
  check('flood: повтор скрыт', s2?.hidden === true, `hidden=${s2?.hidden} adScore=${s2?.adScore}`)
  // XP к НЕскрытым: c1 (+2) и s1 (+2) = 4; скрытый дубликат — 0
  const xpAfterSpam = (await fetch(`${BASE}/api/level`, { headers: H }).then((r) => r.json())).xp
  check('flood: скрытому дубликату XP не начислен (xp=4)', xpAfterSpam === 4, `xp=${xpAfterSpam}`)
}

// 6) уровневый скачок: выдаем 300 XP напрямую → ур.1→3 (порог ур.3 = 260)
const { grantXp } = await import('../src/lib/xp')
const res = await grantXp(uid!, 'admin', 300, 'QA: проверка скачка уровня')
check('grantXp: levelUp = true', !!res?.levelUp, JSON.stringify(res))
check('grantXp: уровень 3', res?.level === 3, `level=${res?.level}`)
check('grantXp: награда 140+180=320', res?.rewardSwipes === 320, `reward=${res?.rewardSwipes}`)
const u = await db.user.findUnique({ where: { id: uid! }, select: { swipes: true, xp: true, level: true } })
check('db: swipes +320', u?.swipes !== undefined && u!.swipes >= 320, JSON.stringify(u))
const notifs = await db.notification.findMany({ where: { userId: uid!, type: 'system', title: { contains: 'уровень' } }, orderBy: { createdAt: 'desc' }, take: 3 })
check('db: уведомление о уровнях создано', notifs.length >= 1, `count=${notifs.length}`)

// 7) штраф: −15 → xp = 304−15 = 289, уровень остаётся 3
const res2 = await grantXp(uid!, 'violation', -15, 'QA: штраф')
check('grantXp: штраф применён (289)', res2?.xp === 289, `xp=${res2?.xp}`)
check('grantXp: уровень не откатился (3)', res2?.level === 3)

// 8) дневной журнал: XP-комментариев сегодня на 4 XP (c1 + s1; короткий и скрытый — мимо)
lvl = await fetch(`${BASE}/api/level`, { headers: H }).then((r) => r.json())
check('level: today.comment = 4', lvl.today?.comment === 4, JSON.stringify(lvl.today))

console.log(fails === 0 ? '\nВСЕ ПРОВЕРКИ ОК' : `\nПРОВАЛОВ: ${fails}`)
process.exit(fails === 0 ? 0 : 1)
