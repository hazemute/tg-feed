const { signSession } = await import('../src/lib/session')
const { db } = await import('../src/lib/db')
await db.user.upsert({ where: { id: 'guest_testdbg' }, create: { id: 'guest_testdbg' }, update: {} })
const token = signSession('guest_testdbg', true, 600)
const r = await fetch('http://localhost:3000/api/feed?category=all&page=0', { headers: { Authorization: `Bearer ${token}` } })
const j = (await r.json()) as { posts?: unknown[]; hasMore?: boolean }
console.log('feed status:', r.status, 'posts:', j.posts?.length ?? 'n/a', 'hasMore:', j.hasMore)
await db.user.delete({ where: { id: 'guest_testdbg' } }).catch(() => {})
