import type { Channel, Post } from '@prisma/client'
import type { ChannelDTO, PostDTO } from '@/lib/types'

type ChannelWithCategory = Channel & {
  category?: { slug: string; title: string } | null
}

export function toChannelDTO(
  c: ChannelWithCategory,
  subscribed: boolean,
  postsCount?: number,
): ChannelDTO {
  return {
    id: c.id,
    title: c.title,
    username: c.username,
    // Переносы строк в описании схлопываем: в превью и списках текст должен
    // течь в 2 строки (line-clamp), а не «в столб»
    description: c.description?.replace(/\s+/g, ' ').trim() ?? null,
    avatarColor: c.avatarColor,
    // Реальная аватарка канала из Bot API (file_id → прокси); null → инициалы
    avatarUrl: c.photoFileId ? `/api/avatar/c_${c.id}` : null,
    // Реальное число подписчиков из Telegram (getChatMemberCount);
    // для каналов, где Bot API недоступен, — оценка из каталога
    subscribersCount: c.membersCount ?? c.subscribersCount,
    isPremium: c.isPremium,
    status: c.status,
    categorySlug: c.category?.slug ?? null,
    categoryTitle: c.category?.title ?? null,
    postsCount,
    subscribed,
  }
}

type PostWithChannel = Post & { channel: ChannelWithCategory }

export function toPostDTO(
  p: PostWithChannel,
  flags: { liked: boolean; bookmarked: boolean; subscribed: boolean },
  bookmarksCount = 0,
): PostDTO {
  let gallery: string[] = []
  if (p.gallery) {
    try {
      const parsed = JSON.parse(p.gallery)
      if (Array.isArray(parsed)) gallery = parsed.filter((x) => typeof x === 'string')
    } catch {
      gallery = []
    }
  }

  return {
    id: p.id,
    text: p.text,
    mediaUrl: p.mediaUrl,
    mediaType: p.mediaType === 'video' ? 'video' : 'image',
    gallery,
    link: p.link,
    viewsCount: p.viewsCount,
    likesCount: p.likesCount,
    bookmarksCount,
    publishedAt: p.publishedAt.toISOString(),
    liked: flags.liked,
    bookmarked: flags.bookmarked,
    channel: toChannelDTO(p.channel, flags.subscribed),
  }
}
