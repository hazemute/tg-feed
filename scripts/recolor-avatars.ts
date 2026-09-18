/**
 * TG-Feed — приведение палитры аватаров к макетам (Task 14-UI).
 * В макетах пользователя аватары каналов: чёрный / синий / тёмно-серый (минимализм).
 * Запуск: bun scripts/recolor-avatars.ts
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

// Палитра из макетов: чёрный, синий, тёмно-серый (текст инициалов всегда белый)
const PALETTE = ['#1c1c1e', '#0a84ff', '#3a3a3c', '#1c1c1e', '#0a84ff', '#1c1c1e']

async function main() {
  const channels = await db.channel.findMany({
    select: { id: true, username: true },
    orderBy: { subscribersCount: 'desc' },
  })
  let i = 0
  for (const ch of channels) {
    const color = PALETTE[i % PALETTE.length]
    i++
    await db.channel.update({ where: { id: ch.id }, data: { avatarColor: color } })
    console.log(`${ch.username} -> ${color}`)
  }
  console.log(`Обновлено каналов: ${i}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
