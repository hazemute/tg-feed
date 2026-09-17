/** Очистка тестовых данных (curl-пользователи, тестовый канал) */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  const ch = await db.channel.deleteMany({ where: { username: 'test_channel_ok' } })
  const u = await db.user.deleteMany({ where: { id: { startsWith: 'demo_curltest' } } })
  console.log({ deletedChannels: ch.count, deletedUsers: u.count })
  await db.$disconnect()
}

main()
