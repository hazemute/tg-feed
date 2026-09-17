/**
 * Tg Swipe seed: только служебные сущности — категории.
 * КАНАЛЫ, ПОСТЫ И РЕКЛАМА БОЛЬШЕ НЕ СИДЯТСЯ: всё реальное наполняет
 * автосбор из админ-панели (Инструменты → «Собрать каналы автоматически»)
 * и парсер t.me/s. Никакой синтетики.
 *
 * Запуск: bun prisma/seed.ts
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

const categories = [
  { slug: 'crypto', title: 'Крипта', emoji: '', order: 1 },
  { slug: 'news', title: 'Новости', emoji: '', order: 2 },
  { slug: 'it', title: 'IT и AI', emoji: '', order: 3 },
  { slug: 'humor', title: 'Юмор', emoji: '', order: 4 },
  { slug: 'business', title: 'Бизнес', emoji: '', order: 5 },
  { slug: 'travel', title: 'Путешествия', emoji: '', order: 6 },
  { slug: 'food', title: 'Еда', emoji: '', order: 7 },
  { slug: 'sport', title: 'Спорт', emoji: '', order: 8 },
  { slug: 'other', title: 'Без категории', emoji: '', order: 9 },
]

async function main() {
  console.log('Seeding Tg Swipe: категории (каналы — только реальными, через автосбор)…')
  for (const c of categories) {
    await db.category.upsert({
      where: { slug: c.slug },
      update: { title: c.title, order: c.order },
      create: c,
    })
  }
  const total = await db.category.count()
  console.log(`Done: ${total} категорий. Каналы наполняет автосбор из админ-панели.`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
