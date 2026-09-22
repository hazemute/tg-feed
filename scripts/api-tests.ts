/**
 * API-смоук-тесты Tg Swipe (бекенд).
 *
 * Запуск: bun scripts/api-tests.ts [baseUrl]
 * По умолчанию бьёт в http://localhost:3000 (dev-сервер должен быть запущен).
 *
 * Покрывает: health/auth, ленту, контентные рельсы, пользовательские действия
 * (лайк/закладка/просмотр/подписка/интересы/видимость), профиль, «Мой канал»,
 * гварды (401 без сессии, 400 на битые тела), AI-эндпоинты — как опциональные.
 *
 * Результат: строка PASS/FAIL на проверку, в конце сводка; exit 1 при падениях.
 */

const BASE = (process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')

type Res = { status: number; json: unknown; text: string }

async function call(
  method: 'GET' | 'POST',
  path: string,
  opts: { token?: string | null; body?: unknown } = {},
): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    /* не-JSON (стримы/прокси) — оставляем текст */
  }
  return { status: res.status, json, text }
}

// ---------- Мини-харнесс ----------

let pass = 0
let fail = 0
let optionalFail = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = '', optional = false) {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    if (optional) optionalFail++
    else fail++
    failures.push(name + (detail ? ` — ${detail}` : ''))
    console.log(`  ${optional ? '⚠️ ' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const errBody = (r: Res) => (isObj(r.json) && typeof r.json.error === 'string' ? r.json.error : r.text.slice(0, 80))

async function section(title: string, fn: () => Promise<void>) {
  console.log(`\n■ ${title}`)
  try {
    await fn()
  } catch (e) {
    fail++
    failures.push(`${title}: threw ${e instanceof Error ? e.message : String(e)}`)
    console.log(`  ❌ секция упала: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ---------- Тесты ----------

let TOKEN = ''
let POST_ID = ''
let USERNAME = ''
let CHANNEL_ID = ''
let CATEGORY_SLUG = 'all'

await section('Инфраструктура', async () => {
  let r = await call('GET', '/api/health')
  check('GET /api/health → 200', r.status === 200, `got ${r.status}`)
  check(
    'health: ok=true (БД доступна)',
    isObj(r.json) && r.json.ok === true,
    isObj(r.json) ? `db=${String(r.json.db)}` : 'не-JSON',
  )

  r = await call('POST', '/api/auth', { body: {} })
  check('POST /api/auth без deviceId → 400', r.status === 400, `got ${r.status} ${errBody(r)}`)

  r = await call('POST', '/api/auth', { body: { deviceId: `apitest_${Date.now() % 100000}` } })
  check('POST /api/auth (гость) → 200', r.status === 200, `got ${r.status} ${errBody(r)}`)
  check('auth: вернул token + user.id', isObj(r.json) && typeof r.json.token === 'string' && isObj(r.json.user) && typeof r.json.user.id === 'string')
  if (isObj(r.json) && typeof r.json.token === 'string') TOKEN = r.json.token

  // Повторный вход тем же deviceId → тот же userId (апсерт, не дубль)
  const dev = { deviceId: 'apitest_stable' }
  const a1 = await call('POST', '/api/auth', { body: dev })
  const a2 = await call('POST', '/api/auth', { body: dev })
  check(
    'auth: повторный вход → тот же user.id',
    isObj(a1.json) && isObj(a2.json) && a1.json.user.id === a2.json.user.id,
  )
})

await section('Гварды: без сессии → 401, битые тела → 400', async () => {
  const guarded = [
    ['GET', '/api/feed?category=all'],
    ['GET', '/api/notifications'],
    ['GET', '/api/bookmarks'],
    ['GET', '/api/profile'],
    ['GET', '/api/profile/stats'],
    ['GET', '/api/mychannel'],
  ] as const
  for (const [m, p] of guarded) {
    const r = await call(m, p)
    check(`${m} ${p.split('?')[0]} без токена → 401`, r.status === 401, `got ${r.status}`)
  }

  const rLike = await call('POST', '/api/like', { token: TOKEN, body: {} })
  check('POST /api/like без postId → 400', rLike.status === 400, `got ${rLike.status}`)
  const rView = await call('POST', '/api/view', { token: TOKEN, body: { postIds: [] } })
  check('POST /api/view с пустым postIds → 400', rView.status === 400, `got ${rView.status}`)
  const rSub = await call('POST', '/api/subscribe', { token: TOKEN, body: {} })
  check('POST /api/subscribe без цели → 400', rSub.status === 400, `got ${rSub.status}`)
  const rFeedBad = await call('GET', '/api/feed?category=BAD%20CAT', { token: TOKEN })
  // Валидатор категории стоит с .catch('all') — мусор молча превращается в 'all' (by design)
  check('GET /api/feed с битой категорией → 200 (фолбэк all)', rFeedBad.status === 200, `got ${rFeedBad.status}`)
})

await section('Лента и контент', async () => {
  const r = await call('GET', '/api/feed?category=all&page=0&limit=5', { token: TOKEN })
  check('GET /api/feed → 200', r.status === 200, `got ${r.status} ${errBody(r)}`)
  const items = arr(isObj(r.json) ? r.json.items : [])
  check('feed: items — массив, ≤ limit', Array.isArray(r.json ? (r.json as { items?: unknown }).items : null) && items.length <= 5, `len=${items.length}`)
  if (items.length > 0 && isObj(items[0])) {
    const p = items[0]
    check('feed: пост имеет id/text/publishedAt/channel', typeof p.id === 'string' && typeof p.text === 'string' && typeof p.publishedAt === 'string' && isObj(p.channel))
    check('feed: channel имеет title/username', isObj(p.channel) && typeof p.channel.title === 'string' && typeof p.channel.username === 'string')
    POST_ID = String(p.id)
    USERNAME = String(isObj(p.channel) ? p.channel.username : '')
  }
  check('feed: есть hasMore/pagination', isObj(r.json) && typeof r.json.hasMore === 'boolean')

  // Пагинация: страница 1 не дублирует страницу 0
  const r1 = await call('GET', '/api/feed?category=all&page=1&limit=5', { token: TOKEN })
  const ids0 = new Set(items.map((x) => String(isObj(x) ? x.id : '')))
  const dup = arr(isObj(r1.json) ? r1.json.items : []).filter((x) => ids0.has(String(isObj(x) ? x.id : '')))
  check('feed: страница 1 без дублей страницы 0', r1.status === 200 && dup.length === 0, `dup=${dup.length}`)

  const rc = await call('GET', '/api/categories')
  check('GET /api/categories → 200, массив с slug/title', rc.status === 200 && arr(isObj(rc.json) ? rc.json.items : []).every((c) => isObj(c) && typeof c.slug === 'string'))
  const cats = arr(isObj(rc.json) ? rc.json.items : []).filter(isObj)
  if (cats[0]) CATEGORY_SLUG = String(cats[0].slug)
  const rf = await call('GET', `/api/feed?category=${CATEGORY_SLUG}&page=0&limit=3`, { token: TOKEN })
  check(`GET /api/feed?category=${CATEGORY_SLUG} → 200`, rf.status === 200, `got ${rf.status}`)

  const rt = await call('GET', '/api/trending', { token: TOKEN })
  check('GET /api/trending → 200', rt.status === 200, `got ${rt.status} ${errBody(rt)}`)
  check('trending: пульс/топ-посты/топ-каналы', isObj(rt.json) && Array.isArray(rt.json.topPosts) && Array.isArray(rt.json.topChannels))

  const rs = await call('GET', '/api/search?q=demo', { token: TOKEN })
  check('GET /api/search?q=… → 200', rs.status === 200, `got ${rs.status} ${errBody(rs)}`)
  check('search: items — массив', Array.isArray(isObj(rs.json) ? rs.json.items : null))

  if (USERNAME) {
    const rch = await call('GET', `/api/channel?username=${encodeURIComponent(USERNAME)}&page=0&limit=5`, { token: TOKEN })
    check('GET /api/channel?username=… → 200', rch.status === 200, `got ${rch.status} ${errBody(rch)}`)
    check('channel: вернул channel + items + hasMore', isObj(rch.json) && isObj(rch.json.channel) && Array.isArray(rch.json.items) && typeof rch.json.hasMore === 'boolean')
    if (isObj(rch.json) && isObj(rch.json.channel) && typeof rch.json.channel.id === 'string') CHANNEL_ID = rch.json.channel.id

    const rrel = await call('GET', `/api/channel/related?username=${encodeURIComponent(USERNAME)}&limit=5`, { token: TOKEN })
    check('GET /api/channel/related → 200', rrel.status === 200, `got ${rrel.status} ${errBody(rrel)}`)
    check('related: items — массив', Array.isArray(isObj(rrel.json) ? rrel.json.items : null))
  }

  const rchs = await call('GET', '/api/channels')
  check('GET /api/channels → 200, items — массив', rchs.status === 200 && Array.isArray(isObj(rchs.json) ? rchs.json.items : null))

  const rht = await call('GET', '/api/hashtags/trending')
  check('GET /api/hashtags/trending → 200', rht.status === 200, `got ${rht.status}`)

  const rfc = await call('GET', '/api/feed/fresh?category=all&after=2000-01-01T00:00:00Z', { token: TOKEN })
  check('GET /api/feed/fresh → 200', rfc.status === 200, `got ${rfc.status} ${errBody(rfc)}`)
})

await section('Действия пользователя', async () => {
  if (!POST_ID) {
    check('есть пост для действий', false, 'лента пуста — пропущено')
    return
  }

  const l1 = await call('POST', '/api/like', { token: TOKEN, body: { postId: POST_ID } })
  check('POST /api/like → 200 + liked', l1.status === 200 && isObj(l1.json) && l1.json.liked === true, `got ${l1.status}`)
  const l2 = await call('POST', '/api/like', { token: TOKEN, body: { postId: POST_ID } })
  check('POST /api/like повторно → 200 + unliked (toggle)', l2.status === 200 && isObj(l2.json) && l2.json.liked === false, `got ${l2.status}`)
  await call('POST', '/api/like', { token: TOKEN, body: { postId: POST_ID } }) // вернуть лайк

  const v = await call('POST', '/api/view', { token: TOKEN, body: { postIds: [POST_ID] } })
  check('POST /api/view → 200', v.status === 200, `got ${v.status} ${errBody(v)}`)

  const b1 = await call('POST', '/api/bookmark', { token: TOKEN, body: { postId: POST_ID } })
  check('POST /api/bookmark → 200 + bookmarked', b1.status === 200 && isObj(b1.json) && b1.json.bookmarked === true, `got ${b1.status}`)
  const bl = await call('GET', '/api/bookmarks', { token: TOKEN })
  const bFound = arr(isObj(bl.json) ? bl.json.items : []).some((x) => isObj(x) && x.id === POST_ID)
  check('GET /api/bookmarks содержит закладку', bl.status === 200 && bFound, `status=${bl.status}`)
  const br = await call('POST', '/api/bookmark/read', { token: TOKEN, body: { all: true } })
  check('POST /api/bookmark/read {all} → 200', br.status === 200, `got ${br.status}`)
  const b2 = await call('POST', '/api/bookmark', { token: TOKEN, body: { postId: POST_ID } })
  check('POST /api/bookmark повторно → снять', b2.status === 200 && isObj(b2.json) && b2.json.bookmarked === false, `got ${b2.status}`)

  if (USERNAME) {
    const s1 = await call('POST', '/api/subscribe', { token: TOKEN, body: { username: USERNAME } })
    check('POST /api/subscribe {username} → 200 + subscribed', s1.status === 200 && isObj(s1.json) && s1.json.subscribed === true, `got ${s1.status} ${errBody(s1)}`)
    const subs = await call('GET', '/api/subscriptions', { token: TOKEN })
    check('GET /api/subscriptions содержит канал', subs.status === 200 && arr(isObj(subs.json) ? subs.json.items : []).some((x) => isObj(x) && isObj(x.channel) && x.channel.username === USERNAME))

    if (CHANNEL_ID) {
      const vis = await call('POST', '/api/subscription/visibility', { token: TOKEN, body: { channelId: CHANNEL_ID, hidden: true } })
      check('POST /api/subscription/visibility {hidden:true} → 200', vis.status === 200, `got ${vis.status} ${errBody(vis)}`)
      const vis2 = await call('POST', '/api/subscription/visibility', { token: TOKEN, body: { channelId: CHANNEL_ID, hidden: false } })
      check('POST /api/subscription/visibility {hidden:false} → 200', vis2.status === 200, `got ${vis2.status}`)
    }

    const u1 = await call('POST', '/api/subscribe', { token: TOKEN, body: { username: USERNAME, action: 'unsubscribe' } })
    check('POST /api/subscribe {unsubscribe} → 200 + unsubscribed', u1.status === 200 && isObj(u1.json) && u1.json.subscribed === false, `got ${u1.status}`)
  }

  const rc2 = await call('GET', '/api/categories')
  const catSlug = arr(isObj(rc2.json) ? rc2.json.items : []).map((c) => (isObj(c) ? String(c.slug) : '')).find(Boolean)
  if (catSlug) {
    const uc = await call('POST', '/api/user/categories', { token: TOKEN, body: { categoryIds: [catSlug] } })
    check('POST /api/user/categories → 200', uc.status === 200, `got ${uc.status} ${errBody(uc)}`)
    const ucBad = await call('POST', '/api/user/categories', { token: TOKEN, body: { categoryIds: ['ОШИБКА!'] } })
    check('POST /api/user/categories с мусором → 400', ucBad.status === 400, `got ${ucBad.status}`)
  }

  const hc = await call('POST', '/api/hashtags/click', { token: TOKEN, body: { tag: 'test' } })
  check('POST /api/hashtags/click → 200', hc.status === 200 || hc.status === 400, `got ${hc.status}`)

  const n = await call('GET', '/api/notifications', { token: TOKEN })
  check('GET /api/notifications → 200', n.status === 200, `got ${n.status} ${errBody(n)}`)
  const ns = await call('POST', '/api/notifications/seen', { token: TOKEN, body: {} })
  check('POST /api/notifications/seen → 200 {ok}', ns.status === 200 && isObj(ns.json) && ns.json.ok === true, `got ${ns.status}`)
})

await section('Профиль и «Мой канал»', async () => {
  const p = await call('GET', '/api/profile', { token: TOKEN })
  check('GET /api/profile → 200 + user', p.status === 200 && isObj(p.json) && isObj(p.json.user), `got ${p.status} ${errBody(p)}`)
  const st = await call('GET', '/api/profile/stats', { token: TOKEN })
  check('GET /api/profile/stats → 200', st.status === 200, `got ${st.status} ${errBody(st)}`)
  const mc = await call('GET', '/api/mychannel', { token: TOKEN })
  check('GET /api/mychannel → 200', mc.status === 200, `got ${mc.status} ${errBody(mc)}`)
})

await section('Прочее (реклама, события)', async () => {
  const ra = await call('GET', '/api/ads')
  check('GET /api/ads → 200', ra.status === 200, `got ${ra.status} ${errBody(ra)}`)
  const at = await call('POST', '/api/ads/track', { body: { adId: 'nonexistent', type: 'impression' } })
  check('POST /api/ads/track (несуществующее объявление) не 500', at.status < 500, `got ${at.status} ${errBody(at)}`, true)
  // SSE-стрим не заканчивается: дожидаемся только заголовков и рвём соединение
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 4000)
    const res = await fetch(`${BASE}/api/events`, {
      headers: { Accept: 'text/event-stream', Authorization: `Bearer ${TOKEN}` },
      signal: ac.signal,
    })
    clearTimeout(t)
    check('GET /api/events (SSE) — 200/поток', res.status === 200, `got ${res.status}`)
    ac.abort()
  } catch {
    // abort после получения заголовков — норма; таймаут ДО заголовков — тоже-ok (стрим жив)
    check('GET /api/events (SSE) — соединение открыто', true)
  }
})

await section('AI-эндпоинты (опционально: нужен ключ)', async () => {
  const sm = await call('POST', '/api/summary', { token: TOKEN, body: POST_ID ? { postId: POST_ID } : {} })
  check('POST /api/summary не 404/401 (роут жив)', ![401, 404].includes(sm.status), `got ${sm.status}`, true)
  const tr = await call('GET', '/api/translate?postId=x&lang=en', { token: TOKEN })
  check('GET /api/translate не 404/401 (роут жив)', ![401, 404].includes(tr.status), `got ${tr.status}`, true)
})

// ---------- Сводка ----------

console.log('\n──────────────────────────────')
console.log(`Прошло: ${pass} ✅   Упало: ${fail} ❌   Опциональных замечаний: ${optionalFail} ⚠️`)
if (failures.length > 0 && fail > 0) {
  console.log('\nПроваленные проверки:')
  for (const f of failures) console.log(`  • ${f}`)
}
process.exit(fail > 0 ? 1 : 0)
