/**
 * Назначает готовые видео-файлы двум постам (AI Волна и спорт-канал).
 * Запуск: bunx tsx scripts/set_videos.ts
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  // 1. Пост AI Волны про видео-генерацию
  const aiPost = await db.post.findFirst({
    where: { text: { contains: 'Нейросети научились генерировать видео' } },
  })
  if (aiPost) {
    await db.post.update({
      where: { id: aiPost.id },
      data: { mediaUrl: '/media/video_ai.mp4', mediaType: 'video', gallery: '[]' },
    })
    console.log('AI post -> video:', aiPost.id)
  } else {
    console.log('AI post not found')
  }

  // 2. Свежий пост спорт-канала с медиа
  const sportChannel = await db.channel.findFirst({ where: { category: { slug: 'sport' } } })
  if (sportChannel) {
    const sportPost = await db.post.findFirst({
      where: { channelId: sportChannel.id, mediaUrl: { not: null } },
      orderBy: { publishedAt: 'desc' },
    })
    if (sportPost) {
      await db.post.update({
        where: { id: sportPost.id },
        data: { mediaUrl: '/media/video_sport.mp4', mediaType: 'video', gallery: '[]' },
      })
      console.log('Sport post -> video:', sportPost.id)
    } else {
      console.log('Sport media post not found')
    }
  } else {
    console.log('Sport channel not found')
  }
}

main().finally(() => db.$disconnect())
