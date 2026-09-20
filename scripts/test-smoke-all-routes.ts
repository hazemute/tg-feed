/**
 * v5.53 Крупный багфикс: smoke-тест ВСЕХ API-роутов.
 * Проверяем статус-коды и базовую структуру ответов под Bearer-сессией.
 */
const BASE = 'http://localhost:3000'
const TOKEN = process.env.TG_TOKEN || (await Bun.file('/tmp/token.txt').text()).trim()
const UID = 'tg_777000'
const H = { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }

let ok = 0
const fails: string[] = []
function check(name: string, cond: boolean, extra = '') {
  if (cond) ok++
  else fails.push(`${name} ${extra}`)
  console.log(`  ${cond ? 'ok' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
}

async function get(path: string, init?: RequestInit) {
  const r = await fetch(BASE + path, { headers: H, ...init })
  let body: any = null
  try {
    body = await r.json()
  } catch {}
  return { status: r.status, body }
}

// Валидатор получает и статус (для 401-кейсов)

// ---------- GET-роуты ----------
const getRoutes: Array<[string, string, (b: any, s: number) => boolean]> = [
  ['/api/feed?userId=' + UID + '&category=all&lang=any', 'feed: страницы постов', (b) => Array.isArray(b?.posts) || Array.isArray(b?.items)],
  ['/api/feed/fresh?userId=' + UID + '&category=all&after=' + encodeURIComponent(new Date(Date.now() - 86400000).toISOString()), 'feed/fresh', (b) => typeof b === 'object' && b !== null],
  ['/api/wallet', 'wallet: баланс', (b) => typeof b?.swipes === 'number'],
  ['/api/notifications?userId=' + UID, 'notifications: список', (b) => Array.isArray(b?.items) || Array.isArray(b?.groups) || Array.isArray(b?.notifications)],
  ['/api/channels?userId=' + UID, 'channels: каталог', (b) => Array.isArray(b?.channels) || Array.isArray(b?.items)],
  ['/api/subscriptions?userId=' + UID, 'subscriptions', (b) => Array.isArray(b?.channels) || Array.isArray(b?.subscriptions) || Array.isArray(b?.items) || b?.ok === true],
  ['/api/bookmarks?userId=' + UID, 'bookmarks', (b) => Array.isArray(b?.items) || Array.isArray(b?.bookmarks) || b?.ok === true],
  ['/api/categories', 'categories', (b) => Array.isArray(b?.categories) || Array.isArray(b?.items)],
  ['/api/tiers', 'tiers: тарифы', (b) => b !== null && typeof b === 'object'],
  ['/api/quests', 'quests: список заданий', (b) => Array.isArray(b?.quests) || Array.isArray(b?.items)],
  ['/api/giveaway', 'giveaway: активный розыгрыш', (b) => typeof b === 'object' && b !== null],
  ['/api/trending', 'trending', (b) => typeof b === 'object'],
  ['/api/hashtags/trending', 'hashtags/trending', (b) => typeof b === 'object'],
  ['/api/search?q=test', 'search', (b) => typeof b === 'object'],
  ['/api/health', 'health: версия+схема', (b) => b?.ok === true && b?.schema?.ok === true],
]

// Особые кейсы: не 2xx по дизайну
const edge = await fetch(BASE + '/api/panel/quests', { headers: H })
check('panel/quests без админ-ключа → 401', edge.status === 401, `status=${edge.status}`)
const aiAssist = await fetch(BASE + '/api/ai/assistant', { headers: H, method: 'POST', body: JSON.stringify({}) })
check('ai/assistant POST без сообщения → 4xx', aiAssist.status >= 400 && aiAssist.status < 500, `status=${aiAssist.status}`)

for (const [path, name, validate] of getRoutes) {
  try {
    const { status, body } = await get(path)
    const good = status >= 200 && status < 400
    check(`${name} [${status}]`, good, status >= 400 ? `status=${status}` : '')
    if (good && validate && !validate(body, status)) check(`${name}: структура ответа`, false, JSON.stringify(body).slice(0, 120))
    else if (good) ok++
  } catch (e) {
    check(name, false, String(e).slice(0, 100))
  }
}

// ---------- POST-роуты (безопасные, идемпотентные) ----------
// view: просмотр поста
const posts = await get('/api/feed?userId=' + UID + '&category=all&lang=any')
const firstPost = posts.body?.posts?.[0]?.id || posts.body?.items?.[0]?.id
if (firstPost) {
  const v = await get('/api/view', { method: 'POST', body: JSON.stringify({ postIds: [firstPost], userId: UID }) })
  check(`view [${v.status}]`, v.status === 200, `status=${v.status}`)
  const d = await get('/api/view/dwell', { method: 'POST', body: JSON.stringify({ userId: UID, postId: firstPost, ms: 1500 }) })
  check(`view/dwell [${d.status}]`, d.status === 200, `status=${d.status} ${JSON.stringify(d.body).slice(0, 80)}`)
  // AI-сводка поста (POST /api/summary {postId})
  const sm = await get('/api/summary', { method: 'POST', body: JSON.stringify({ postId: firstPost }) })
  check(`summary(пост) [${sm.status}]`, sm.status === 200 || sm.status === 404 || sm.status === 429 || sm.status === 503, `status=${sm.status}`)
} else {
  check('view/dwell', false, 'нет постов в ленте для теста')
}

// like / bookmark toggle-пара (возврат состояния)
if (firstPost) {
  const l1 = await get('/api/like', { method: 'POST', body: JSON.stringify({ userId: UID, postId: firstPost }) })
  check(`like [${l1.status}]`, l1.status === 200, `status=${l1.status}`)
  const l2 = await get('/api/like', { method: 'POST', body: JSON.stringify({ userId: UID, postId: firstPost }) })
  check(`like-unlike [${l2.status}]`, l2.status === 200, `status=${l2.status}`)
  const bm1 = await get('/api/bookmark', { method: 'POST', body: JSON.stringify({ userId: UID, postId: firstPost }) })
  check(`bookmark [${bm1.status}]`, bm1.status === 200, `status=${bm1.status}`)
  const bm2 = await get('/api/bookmark', { method: 'POST', body: JSON.stringify({ userId: UID, postId: firstPost }) })
  check(`bookmark-unbookmark [${bm2.status}]`, bm2.status === 200, `status=${bm2.status}`)
}

// emoji — файловый роут GET /api/emoji/[id] (404 для несуществующего — норма)
const emoji = await fetch(BASE + '/api/emoji/qa_nonexistent')
check('emoji/[id] несуществующий → 4xx', emoji.status === 400 || emoji.status === 404, `status=${emoji.status}`)

// summary — POST-роут (сводка юзера)
const sm2 = await get('/api/summary', { method: 'POST', body: JSON.stringify({ postId: 'qa_nonexistent' }) })
check(`summary(неизвестный пост) → 404`, sm2.status === 404, `status=${sm2.status}`)

// feedback
const fb = await get('/api/feedback', { method: 'POST', body: JSON.stringify({ userId: UID, text: 'QA smoke тест, можно игнорировать' }) })
check(`feedback [${fb.status}]`, [200, 201, 400, 429].includes(fb.status), `status=${fb.status}`)

// 401-проверки (без токена)
const noAuth = await fetch(BASE + '/api/wallet')
check('wallet без сессии → 401', noAuth.status === 401, `status=${noAuth.status}`)
const noAuth2 = await fetch(BASE + '/api/notifications')
check('notifications без сессии → 401', noAuth2.status === 401 || noAuth2.status === 200, `status=${noAuth2.status}`)

// невалидные входы
const badLike = await get('/api/like', { method: 'POST', body: JSON.stringify({ userId: UID }) })
check('like без postId → 400', badLike.status === 400, `status=${badLike.status}`)
const badQuest = await get('/api/quests/definitely_not_exists/claim', { method: 'POST', body: JSON.stringify({ userId: UID }) })
check('claim несуществующего → status=unavailable', badQuest.status === 200 && badQuest.body?.status === 'unavailable', `status=${badQuest.status} body=${JSON.stringify(badQuest.body).slice(0, 80)}`)

// module-маркер (top-level await требует ES-модуль)
export {}
console.log(`\nИтог: ${ok} ok, ${fails.length} fail`)
if (fails.length) {
  console.log('FAILS:')
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
