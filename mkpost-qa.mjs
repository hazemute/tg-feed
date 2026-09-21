// ВРЕМЕННЫЙ QA-скрипт: создаёт один длинный пост в QA Канал для теста PostOverlay (удалить после теста)
import { PrismaClient } from ".prisma/client" 
const db = new PrismaClient()
const ch = await db.channel.findFirst({ where: { username: 'qa_channel' } }).catch(async () => {
  return await db.channel.findFirst({ where: { title: { contains: 'QA' } } })
})
if (!ch) { console.log('NO_CHANNEL'); process.exit(1) }
const text = '**Длинный QA-пост** для проверки полного экрана.\n\n' + 'Абзац номер ' + 'текст проверки переноса строк и «ещё»-кнопки. '.repeat(24)
const p = await db.post.upsert({
  where: { tgKey: 'qa_test:999001' },
  update: { text },
  create: { tgKey: 'qa_test:999001', channelId: ch.id, text, mediaType: 'none', publishedAt: new Date(), viewsCount: 10 }
})
console.log('OK', p.id)
await db.$disconnect()
