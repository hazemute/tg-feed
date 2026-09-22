/**
 * QA: индекс ленты v10 после грубого фикса — доля и позиции ботовых каналов.
 */
import { computeRankedIndex } from '../src/lib/feed'
import { db } from '../src/lib/db'

async function main() {
  const index = await computeRankedIndex({ channel: { status: 'active' } })
  const ch = new Map(
    (await db.channel.findMany({ select: { id: true, username: true, claimedById: true } })).map((c) => [c.id, c]),
  )
  const bot = index.entries.filter((e) => ch.get(e.c)?.claimedById)
  console.log(`Индекс: ${index.entries.length} постов из ${new Set(index.entries.map((e) => e.c)).size} каналов`)
  console.log(`Ботовых постов в индексе: ${bot.length} (${Math.round((bot.length / index.entries.length) * 100)}%)`)
  for (const e of bot) {
    const pos = index.entries.findIndex((x) => x.i === e.i) + 1
    console.log(`  бот @${ch.get(e.c)?.username}: позиция ${pos}/${index.entries.length}, вес ${e.w.toFixed(1)}`)
  }
  // Топ-10 голов ленты
  console.log('\nТоп-10 индекса:')
  for (const e of index.entries.slice(0, 10)) {
    console.log(`  #${index.entries.indexOf(e) + 1} @${ch.get(e.c)?.username} w=${e.w.toFixed(1)} bot=${e.b}`)
  }
  // где начинаются ботовые (первый в хвосте)
  const firstBotPos = index.entries.findIndex((e) => e.b) + 1
  console.log(`\nПервый ботовый пост на позиции: ${firstBotPos || '— (нет)'} из ${index.entries.length}`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
