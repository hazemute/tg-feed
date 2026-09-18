/** Разовый осмотр БД: каналы, счётчики (удаляется после задачи) */
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const cats = await db.category.findMany({ select: { id: true, slug: true } })
  const chs = await db.channel.findMany({ select: { username: true, title: true, categoryId: true, membersCount: true, photoFileId: true, description: true } })
  let badTitle = 0, noPhoto = 0, noMembers = 0, noDesc = 0
  for (const c of chs) {
    const slug = cats.find((x) => x.id === c.categoryId)?.slug ?? '?'
    if (c.title.toLowerCase() === c.username.toLowerCase()) { badTitle++; if (badTitle <= 6) console.log('BAD TITLE:', c.username) }
    if (!c.photoFileId) noPhoto++
    if (c.membersCount == null) noMembers++
    if (!c.description) noDesc++
  }
  const byCat: Record<string, number> = {}
  for (const c of chs) { const s = cats.find((x) => x.id === c.categoryId)?.slug ?? '?'; byCat[s] = (byCat[s] ?? 0) + 1 }
  console.log(`total=${chs.length} badTitle=${badTitle} noPhoto=${noPhoto} noMembers=${noMembers} noDesc=${noDesc}`)
  console.log('byCat:', JSON.stringify(byCat))
  await db.$disconnect()
}
main()
