import { PrismaClient } from '.prisma/client'
const db = new PrismaClient()
const p = await db.post.findUnique({ where: { tgKey: 'qa_test:999001' }, select: { text: true } })
console.log(JSON.stringify({len: p.text.length, tail: p.text.slice(-60)}))
await db.$disconnect()
