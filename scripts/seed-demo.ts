/** E2E: сеем демо-мусор (гость + фейковый баланс 500₽ + следы), проверяем purgeDemoData */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  const g = await db.user.create({
    data: {
      id: 'guest_test123',
      isGuest: true,
      categories: '[]',
      likes: { create: { postId: 'nope', } as never },
    },
  }).catch(async () => {
    // без постов лайк не создаётся — просто гость
    return db.user.create({ data: { id: 'guest_test123', isGuest: true, categories: '[]' } })
  })
  await db.advertiserAccount.create({
    data: { userId: g.id, balanceKop: 50000, topupsTotalKop: 0 },
  })
  // «Реальный» баланс с пополнением — НЕ должен удалиться
  await db.user.create({ data: { id: 'tg_777001', isGuest: false, categories: '[]' } })
  await db.advertiserAccount.create({
    data: { userId: 'tg_777001', balanceKop: 30000, topupsTotalKop: 30000 },
  })
  await db.notification.create({
    data: { userId: 'guest_test123', type: 'system', title: 'тест' },
  })
  const stats = { guests: await db.user.count({ where: { id: { startsWith: 'guest_' } } }) }
  console.log('seeded', stats)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
