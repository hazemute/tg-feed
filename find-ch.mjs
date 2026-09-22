import { PrismaClient } from '.prisma/client'
const db = new PrismaClient()
const chs = await db.channel.findMany({ select: { id: true, username: true, title: true }, take: 30 })
console.log(JSON.stringify(chs, null, 0))
await db.$disconnect()
