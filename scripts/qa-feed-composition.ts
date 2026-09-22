/**
 * QA: состав окна ленты (1200 свежайших постов) — «ботовые» (claimedById != null)
 * vs «запаршенные с интернета» (claimedById == null).
 */
import { db } from '../src/lib/db'

async function main() {
  const [claimedCh, parsedCh, activeCh] = await Promise.all([
    db.channel.count({ where: { claimedById: { not: null }, status: 'active' } }),
    db.channel.count({ where: { claimedById: null, status: 'active' } }),
    db.channel.count({ where: { status: 'active' } }),
  ])
  console.log(`Активных каналов: ${activeCh} | с ботом (claimed): ${claimedCh} | запаршенных: ${parsedCh}`)

  const posts = await db.post.findMany({
    where: { channel: { status: 'active' } },
    orderBy: { publishedAt: 'desc' },
    take: 1200,
    select: {
      id: true, channelId: true, publishedAt: true, promotedAt: true,
      channel: { select: { username: true, title: true, claimedById: true, addedById: true, isPremium: true, category: { select: { slug: true } } } },
    },
  })
  console.log(`Окно 1200: всего постов ${posts.length}`)

  const byCh = new Map<string, { n: number; claimed: boolean; user: string; prem: boolean; cat: string }>()
  for (const p of posts) {
    const k = p.channelId
    const e = byCh.get(k) ?? { n: 0, claimed: p.channel.claimedById != null, user: p.channel.username, prem: p.channel.isPremium, cat: p.channel.category?.slug ?? '?' }
    e.n++
    byCh.set(k, e)
  }
  const rows = [...byCh.values()].sort((a, b) => b.n - a.n)
  const claimedPosts = rows.filter(r => r.claimed).reduce((s, r) => s + r.n, 0)
  const parsedPosts = rows.filter(r => !r.claimed).reduce((s, r) => s + r.n, 0)
  console.log(`Постов от каналов С БОТОМ: ${claimedPosts} (${Math.round(claimedPosts / posts.length * 100)}%) из ${rows.filter(r => r.claimed).length} кан.`)
  console.log(`Постов ЗАПАРШЕННЫХ:        ${parsedPosts} (${Math.round(parsedPosts / posts.length * 100)}%) из ${rows.filter(r => !r.claimed).length} кан.`)
  console.log('\n--- Каналы С БОТОМ в окне (username: постов) ---')
  for (const r of rows.filter(r => r.claimed)) console.log(`  @${r.user}: ${r.n} ${r.prem ? '[premium]' : ''} (${r.cat})`)
  console.log('\n--- ЗАПАРШЕННЫЕ в окне (username: постов) ---')
  for (const r of rows.filter(r => !r.claimed)) console.log(`  @${r.user}: ${r.n} ${r.prem ? '[premium]' : ''} (${r.cat})`)

  // Пул ≤12/канал + кап 5/канал как в индексе
  const pool = new Map<string, number>()
  let pooled = 0, pooledClaimed = 0
  const seen = new Set<string>()
  for (const p of posts) {
    const n = pool.get(p.channelId) ?? 0
    if (n >= 12) continue
    pool.set(p.channelId, n + 1); pooled++
    if (p.channel.claimedById != null) pooledClaimed++
    if (!seen.has(p.channelId)) seen.add(p.channelId)
  }
  console.log(`\nПосле пула ≤12/канал: ${pooled} постов, из них с ботом ${pooledClaimed} (${Math.round(pooledClaimed / pooled * 100)}%), каналов: ${seen.size}`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
