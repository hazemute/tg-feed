// QA прода: прод-сессия → /api/feed page0 → состав каналов (bot vs parsed)
import crypto from 'crypto'
import fs from 'fs'

const envRaw = fs.readFileSync('/home/z/my-project/.env', 'utf8')
const getEnv = (k) => {
  const m = envRaw.match(new RegExp(`^\\s*${k}\\s*=\\s*"?([^"\\n\\r]+)"?`, 'm'))
  return m ? m[1].trim() : ''
}
const BOT = process.env.QA_BOT_TOKEN || getEnv('TELEGRAM_BOT_TOKEN')
if (!BOT) { console.log('NO_BOT_TOKEN'); process.exit(1) }

const authDate = Math.floor(Date.now() / 1000)
const user = JSON.stringify({ id: 777000, first_name: 'QA', username: 'qa_probe', language_code: 'ru' })
const params = new URLSearchParams({
  auth_date: String(authDate),
  query_id: 'AAF' + crypto.randomBytes(8).toString('hex'),
  user,
})
const dcs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n')
const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT).digest()
const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex')
params.set('hash', hash)
const initData = params.toString()

const ORIGIN = 'https://tg-swipe.vercel.app'
const authRes = await fetch(`${ORIGIN}/api/auth`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ initData }),
})
const authJson = await authRes.json().catch(() => ({}))
if (!authJson?.token) { console.log('AUTH_FAIL', authRes.status, JSON.stringify(authJson).slice(0, 200)); process.exit(1) }
const tok = authJson.token

const feedRes = await fetch(`${ORIGIN}/api/feed?page=0`, { headers: { authorization: `Bearer ${tok}` } })
const feed = await feedRes.json().catch(() => null)
if (!feed) { console.log('FEED_FAIL', feedRes.status); process.exit(1) }
const posts = feed.posts ?? feed.items ?? []
console.log('FEED_STATUS', feedRes.status, 'posts:', posts.length, 'hasMore:', feed.hasMore ?? feed.hasMorePosts ?? '?')
const chans = []
for (const p of posts) {
  const c = p.channel ?? {}
  const label = `@${c.username ?? c.slug ?? '?'} | ${c.title ?? '?'}`
  if (!chans.some((x) => x.u === label)) chans.push({ u: label, n: 0 })
  const e = chans.find((x) => x.u === label); e.n++
}
console.log('--- CHANNELS ON PAGE 0 ---')
for (const c of chans) console.log(`${String(c.n).padStart(2)}x  ${c.u}`)
console.log('distinct channels:', chans.length)

// страница 1 — добор
const feed2Res = await fetch(`${ORIGIN}/api/feed?page=1`, { headers: { authorization: `Bearer ${tok}` } })
const feed2 = await feed2Res.json().catch(() => null)
const posts2 = feed2?.posts ?? feed2?.items ?? []
const ch2 = new Set()
for (const p of posts2) { const c = p.channel ?? {}; ch2.add(`@${c.username ?? '?'}`) }
console.log('page1 posts:', posts2.length, 'distinct:', ch2.size)

// health feed-статистика
const h = await (await fetch(`${ORIGIN}/api/health`)).json().catch(() => null)
console.log('HEALTH version:', h?.version, 'feed:', JSON.stringify(h?.feed))
