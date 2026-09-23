// QA v6.0.1: claimed-каналы не должны встречаться НИ В ОДНОЙ странице ленты
import { db } from '../src/lib/db.ts'
import { signSession } from '../src/lib/session.ts'

async function main() {
  const claimed = await db.channel.findMany({
    where: { claimedById: { not: null } },
    select: { username: true },
  })
  const claimedSet = new Set(claimed.map((c) => '@' + c.username))
  console.log('claimed channels in DB:', [...claimedSet].join(', ') || '(нет)')

  const tok = signSession('tg_777000', false)
  const seen = new Map<string, number>()
  let claimedFound = 0
  let total = 0
  for (let page = 0; page < 6; page++) {
    const res = await fetch(`http://localhost:3000/api/feed?page=${page}`, {
      headers: { authorization: `Bearer ${tok}` },
    })
    if (!res.ok) { console.log('page', page, '->', res.status); break }
    const data = (await res.json()) as { items?: Array<{ channel: { username: string } }>; hasMore: boolean }
    const items = data.items ?? []
    for (const p of items) {
      const u = '@' + p.channel.username
      seen.set(u, (seen.get(u) ?? 0) + 1)
      if (claimedSet.has(u)) claimedFound++
      total++
    }
    if (!data.hasMore) break
  }
  console.log('total posts across pages:', total, '| distinct channels:', seen.size)
  console.log('CLAIMED FOUND IN FEED:', claimedFound, claimedFound === 0 ? '✅ OK' : '❌ FAIL')
  for (const [u, n] of [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`${String(n).padStart(3)}x  ${u}`)
  }
  await db.$disconnect()
}
main()
