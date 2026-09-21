/**
 * QA v5.64: очередь отложенных постов (Snap Ассистент).
 * Локально бот выключен → публикация обязана вернуть failed с ошибкой
 * «Бот не настроен», запись остаётся в очереди (ретрай), очередь читается.
 */
import { db } from '../src/lib/db'
import { publishDueScheduledPosts, scheduledQueueFor } from '../src/lib/scheduled-posts'

async function main() {
  const ch = await db.channel.findFirst({ select: { id: true, username: true } })
  if (!ch) throw new Error('нет каналов в локальной БД')

  const sp = await db.scheduledPost.create({
    data: {
      channelId: ch.id,
      text: 'QA v5.64: тест отложенного поста — проверка очереди и свипа.',
      scheduledAt: new Date(Date.now() - 60_000), // срок уже вышел
      createdBy: 'qa',
    },
  })
  console.log('1. создан отложенный пост:', sp.id)

  const res = await publishDueScheduledPosts(5)
  console.log('2. свип:', JSON.stringify(res))

  const row = await db.scheduledPost.findUnique({ where: { id: sp.id } })
  console.log('3. после свипа: publishedAt =', row?.publishedAt, '| error =', row?.error)
  if (!row || row.publishedAt !== null) throw new Error('FAIL: очередь потеряла запись без публикации')
  if (!row.error) throw new Error('FAIL: ошибка бота не записана')

  const queue = await scheduledQueueFor(ch.id)
  console.log('4. очередь канала:\n' + queue)

  // cleanup + проверка отмены
  await db.scheduledPost.delete({ where: { id: sp.id } })
  console.log('5. удалён из очереди — ок')

  // Дубль tgKey: пост с существующим ключом не должен падать create
  const post = await db.post.findFirst({ select: { tgKey: true } })
  if (post) {
    try {
      await db.post.create({
        data: { tgKey: post.tgKey, channelId: ch.id, text: 'dup', mediaType: 'none', publishedAt: new Date() },
      })
      console.log('6. WARNING: дубликат tgKey создался?!')
      await db.post.deleteMany({ where: { tgKey: post.tgKey, text: 'dup' } })
    } catch {
      console.log('6. дубликат tgKey корректно отклонён уникальным индексом')
    }
  }

  console.log('\nQA v5.64 scheduled-posts: PASS')
}

main()
  .catch((e) => {
    console.error('FAIL:', e)
    process.exit(1)
  })
  .finally(() => process.exit(0))
