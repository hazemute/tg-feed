/**
 * Одноразовый бэкфилл: переклассификация ВСЕХ каналов нейросетью
 * (gemini-2.5-flash-lite через OpenRouter). Запуск:
 *   export $(grep -E '^(DATABASE_URL|OPENROUTER_API_KEY)=' .env | xargs) && bun scripts/reclassify.ts
 *
 * Пачки по 20 каналов, между пачками пауза 1.5с (экономия и плавность).
 * Кэши ленты после прогона сбрасываются через bumpCache (Redis).
 */
import { PrismaClient } from '@prisma/client'
import { classifyChannelsBatch } from '../src/lib/classify'
import { bumpCache } from '../src/lib/redis'

const db = new PrismaClient()

async function main() {
  const cats = await db.category.findMany({ select: { id: true, slug: true, title: true } })
  const bySlug = new Map(cats.map((c) => [c.slug, c.id]))
  const channels = await db.channel.findMany({
    select: {
      id: true,
      title: true,
      username: true,
      description: true,
      categoryId: true,
      posts: { orderBy: { publishedAt: 'desc' }, take: 3, select: { text: true } },
    },
    orderBy: { createdAt: 'asc' },
  })
  console.log(`Каналов к классификации: ${channels.length}; тем: ${cats.map((c) => c.slug).join(', ')}`)

  const BATCH = 20
  let changed = 0
  let unchanged = 0
  let batchNo = 0

  for (let i = 0; i < channels.length; i += BATCH) {
    const batch = channels.slice(i, i + BATCH)
    batchNo++
    const payload = batch.map((c) => ({
      id: c.id,
      title: c.title,
      username: c.username,
      description: c.description,
      sample: c.posts.map((p) => p.text).join(' ').slice(0, 300),
    }))
    const map = await classifyChannelsBatch(payload, cats.map((c) => ({ slug: c.slug, title: c.title })))
    for (const ch of batch) {
      const slug = map.get(ch.id)
      if (!slug) continue
      const targetId = bySlug.get(slug)
      if (!targetId || targetId === ch.categoryId) {
        unchanged++
        continue
      }
      await db.channel.update({ where: { id: ch.id }, data: { categoryId: targetId } })
      changed++
    }
    const done = Math.min(i + BATCH, channels.length)
    console.log(`[${batchNo}] ${done}/${channels.length} — переносов: ${changed}, на месте: ${unchanged}`)
    if (i + BATCH < channels.length) await new Promise((r) => setTimeout(r, 1500))
  }

  // Категории каналов изменились — сбрасываем версии кэш-семейств
  try {
    await bumpCache(['feed', 'tr', 'ch', 'ct', 'sr'])
    console.log('Кэш-семейства сброшены')
  } catch {
    console.log('Redis недоступен — кэши истекут по TTL')
  }

  // Итоговое распределение
  const grouped = await db.channel.groupBy({ by: ['categoryId'], _count: { _all: true } })
  const titles = new Map(cats.map((c) => [c.id, c.slug]))
  console.log(
    'Распределение:',
    grouped
      .sort((a, b) => b._count._all - a._count._all)
      .map((g) => `${titles.get(g.categoryId) ?? g.categoryId}: ${g._count._all}`)
      .join(', '),
  )
  console.log(`Готово. Перенесено ${changed} из ${channels.length}.`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
