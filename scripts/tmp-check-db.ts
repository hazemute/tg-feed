import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const ch = await db.channel.findFirst({ where: { username: { in: ['rian_ru', '@rian_ru'] } } })
  const ch2 = await db.channel.findFirst({ where: { title: { contains: 'РИА' } } })
  const c = ch ?? ch2
  if (!c) { console.log('channel not found'); return }
  console.log(JSON.stringify({ username: c.username, title: c.title, avatarUrl: c.avatarUrl?.slice(0, 120), avatarColor: c.avatarColor, subscribersCount: c.subscribersCount, status: c.status, source: (c as any).source, isDemo: (c as any).isDemo }, null, 2))
  const posts = await db.post.findMany({ where: { channelId: c.id }, orderBy: { publishedAt: 'desc' }, take: 3, select: { id: true, text: true, gallery: true, mediaType: true, mediaMeta: true, viewsTg: true } })
  for (const p of posts) console.log('POST:', p.id, '\n  text:', p.text?.slice(0, 300), '\n  gallery:', JSON.stringify(p.gallery)?.slice(0, 200), '\n  mediaType:', p.mediaType, 'viewsTg:', p.viewsTg)
  // demo users
  const demoUsers = await (db as any).user.count({ where: { isDemo: true } })
  const totalUsers = await db.user.count()
  console.log('users total:', totalUsers, 'demo:', demoUsers)
}
main().finally(() => db.$disconnect())
