/**
 * TG-Feed: проверка данных до/после сидинга (Task 14-b).
 * Запуск: bunx tsx scripts/seed-more-check.ts  (или bun scripts/seed-more-check.ts)
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  const totalChannels = await db.channel.count()
  const totalPosts = await db.post.count()
  const withMedia = await db.post.count({ where: { mediaUrl: { not: null } } })

  const cats = await db.category.findMany({
    orderBy: { order: 'asc' },
    select: { slug: true, title: true, channels: { select: { username: true, isPremium: true } } },
  })

  console.log(`=== Итого: каналов ${totalChannels}, постов ${totalPosts} (с медиа ${withMedia}) ===`)
  for (const c of cats) {
    console.log(`[${c.slug}] ${c.title}: каналов ${c.channels.length}`)
    for (const ch of c.channels) console.log(`   - ${ch.username}${ch.isPremium ? ' (premium)' : ''}`)
  }

  // Последний пост по времени — чтобы убедиться, что разброс publishedAt корректен
  const latest = await db.post.findFirst({ orderBy: { publishedAt: 'desc' }, select: { tgKey: true, publishedAt: true } })
  const oldest = await db.post.findFirst({ orderBy: { publishedAt: 'asc' }, select: { tgKey: true, publishedAt: true } })
  console.log('Latest post:', latest?.tgKey, latest?.publishedAt?.toISOString())
  console.log('Oldest post:', oldest?.tgKey, oldest?.publishedAt?.toISOString())
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
