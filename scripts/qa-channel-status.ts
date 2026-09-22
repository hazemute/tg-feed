/**
 * QA: куда делись каталог-каналы — статусы, Blacklist, aiFlag постов.
 */
import { db } from '../src/lib/db'

async function main() {
  const all = await db.channel.findMany({
    select: { id: true, username: true, title: true, status: true, claimedById: true, createdAt: true, _count: { select: { posts: true } } },
    orderBy: { createdAt: 'desc' },
  })
  const byStatus = new Map<string, number>()
  for (const c of all) byStatus.set(c.status, (byStatus.get(c.status) ?? 0) + 1)
  console.log(`Всего каналов: ${all.length}; по статусам:`, Object.fromEntries(byStatus))

  const bl = await (db as unknown as { blacklist?: { findMany: (a: unknown) => Promise<Array<Record<string, unknown>>> } }).blacklist?.findMany?.({ take: 50 }) ?? null
  if (bl) console.log(`Blacklist записей: ${bl.length}`, JSON.stringify(bl.slice(0, 10)))

  console.log('\n--- Все каналы ---')
  for (const c of all) {
    console.log(`@${c.username.padEnd(22)} status=${c.status.padEnd(10)} posts=${String(c._count.posts).padStart(4)} claimed=${c.claimedById ? 'Y' : 'n'} created=${c.createdAt.toISOString().slice(0, 10)}`)
  }

  // Посты неактивных каналов
  const inactive = all.filter(c => c.status !== 'active')
  if (inactive.length) {
    const ids = inactive.map(c => c.id)
    const pc = await db.post.count({ where: { channelId: { in: ids } } })
    const last = await db.post.findFirst({ where: { channelId: { in: ids } }, orderBy: { publishedAt: 'desc' }, select: { publishedAt: true, channel: { select: { username: true } } } })
    console.log(`\nПостов у неактивных каналов: ${pc}; последний: ${last ? `@${last.channel.username} ${last.publishedAt.toISOString()}` : '—'}`)
    const flagged = await db.post.count({ where: { channelId: { in: ids }, aiFlag: { not: null } } })
    console.log(`Из них с aiFlag: ${flagged}`)
  }
  // общий срез aiFlag по активным
  const af = await db.post.groupBy({ by: ['aiFlag'], _count: { _all: true }, where: { channel: { status: 'active' } } })
  console.log('\naiFlag по постам активных каналов:', af.map(a => `${a.aiFlag ?? 'null'}=${a._count._all}`).join(', '))
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
