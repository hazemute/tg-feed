import type { Channel, Post } from '@prisma/client'
import type { ChannelDTO, MediaItemDTO, MediaKind, PostDTO } from '@/lib/types'

type ChannelWithCategory = Channel & {
  category?: { slug: string; title: string } | null
}

const KNOWN_KINDS: MediaKind[] = [
  'image',
  'video',
  'gif',
  'sticker',
  'voice',
  'audio',
  'file',
  'poll',
  'link',
  'none',
]

function normalizeKind(raw: string): MediaKind {
  return (KNOWN_KINDS as string[]).includes(raw) ? (raw as MediaKind) : 'image'
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
    teaserMode: c.teaserMode,
    teaserLimit: c.teaserLimit,
  }
}

type PostWithChannel = Post & { channel: ChannelWithCategory }

/** Дополнительные атрибуты основного медиа из Post.mediaMeta (JSON) */
function parseMeta(json: string | null): Record<string, unknown> | null {
  if (!json) return null
  try {
    const obj = JSON.parse(json)
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null
  } catch {
    return null
  }
}

/** Дополнительные медиа из Post.gallery: legacy (строки) или MediaItem[] */
function parseGallery(json: string | null): MediaItemDTO[] {
  if (!json) return []
  try {
    const arr = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const items: MediaItemDTO[] = []
    for (const x of arr) {
      if (typeof x === 'string' && x) items.push({ kind: 'image', url: x })
      else if (x && typeof x === 'object' && typeof (x as MediaItemDTO).kind === 'string') {
        const it = x as MediaItemDTO
        items.push({ ...it, kind: normalizeKind(it.kind) })
      }
    }
    return items
  } catch {
    return []
  }
}

export function toPostDTO(
  p: PostWithChannel,
  flags: { liked: boolean; bookmarked: boolean; subscribed: boolean },
  bookmarksCount = 0,
): PostDTO {
  const kind = normalizeKind(p.mediaType)
  const extras = parseMeta(p.mediaMeta)
  const media =
    p.mediaUrl || (kind !== 'none' && kind !== 'image')
      ? {
          kind,
          ...(p.mediaUrl ? { url: p.mediaUrl } : {}),
          ...(extras ?? {}),
        }
      : null
  const gallery = parseGallery(p.gallery)
  // Просмотры для показа: приоритет у оригинального канала (t.me/s),
  // локальные просмотра миниаппа — фолбэк и добавка
  const viewsCount = Math.max(p.viewsTg ?? 0, p.viewsCount)

  return {
    id: p.id,
    text: p.text,
    mediaUrl: p.mediaUrl,
    mediaType: kind,
    media: media as MediaItemDTO | null,
    gallery,
    link: p.link,
    viewsCount,
    viewsTg: p.viewsTg,
    likesCount: p.likesCount,
    bookmarksCount,
    publishedAt: p.publishedAt.toISOString(),
    liked: flags.liked,
    bookmarked: flags.bookmarked,
    channel: toChannelDTO(p.channel, flags.subscribed),
  }
}
