import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const posts = await db.post.findMany({ where: { OR: [{ mediaUrl: { not: null } }, { gallery: { not: null } }] }, orderBy: { publishedAt: 'desc' }, take: 6, select: { id: true, mediaUrl: true, mediaType: true, gallery: true, mediaMeta: true } })
  for (const p of posts) {
    console.log('---', p.mediaType, '| mediaUrl:', p.mediaUrl?.slice(0, 100) ?? null)
    if (p.gallery) console.log('    gallery:', p.gallery.slice(0, 150))
  }
  const noMedia = await db.post.count({ where: { mediaUrl: null, gallery: null } })
  const total = await db.post.count()
  console.log('posts:', total, 'no media:', noMedia)
  const chans = await db.channel.findMany({ where: { photoFileId: { not: null } }, select: { username: true, photoFileId: true, membersCount: true } })
  console.log('channels with photoFileId:', chans.length, 'of', await db.channel.count())
  console.log(chans.slice(0, 5).map(c => `${c.username} mc=${c.membersCount} fid=${c.photoFileId.slice(0, 20)}`))
}
main().finally(() => db.$disconnect())
