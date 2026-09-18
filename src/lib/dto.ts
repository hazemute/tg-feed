import type { Channel, Post } from '@prisma/client'
import type { ChannelDTO, MediaItemDTO, MediaKind, PostDTO } from '@/lib/types'
import { proxiedMediaUrl } from '@/lib/media'
import { animatedEmojiIds } from '@/lib/emoji-registry'

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
    // Аватарка: постоянная ссылка из Storage (парсер, og:image) → прокси Bot API
    // (file_id → getFile) → null (инициалы). Storage-ссылка отдаётся напрямую —
    // браузер кэширует её без нашего сервера, самый быстрый путь.
    avatarUrl:
      c.avatarUrl ?? (c.photoFileId ? `/api/avatar/c_${c.id}` : null),
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
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
    // URL-поля внутри меты (постер видео, картинка линк-превью) — тоже через прокси
    const m = obj as Record<string, unknown>
    if (typeof m.url === 'string') m.url = proxiedMediaUrl(m.url)
    if (typeof m.poster === 'string') m.poster = proxiedMediaUrl(m.poster)
    return m
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
      if (typeof x === 'string' && x) items.push({ kind: 'image', url: proxiedMediaUrl(x) ?? undefined })
      else if (x && typeof x === 'object' && typeof (x as MediaItemDTO).kind === 'string') {
        const it = x as MediaItemDTO
        items.push({
          ...it,
          kind: normalizeKind(it.kind),
          url: proxiedMediaUrl(it.url) ?? undefined,
          poster: proxiedMediaUrl(it.poster) ?? undefined,
        })
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
          ...(p.mediaUrl ? { url: proxiedMediaUrl(p.mediaUrl) ?? p.mediaUrl } : {}),
          ...(extras ?? {}),
        }
      : null
  const gallery = parseGallery(p.gallery)
  // Просмотры для показа: приоритет у оригинального канала (t.me/s),
  // локальные просмотра миниаппа — фолбэк и добавка
  const viewsCount = Math.max(p.viewsTg ?? 0, p.viewsCount)
  // Лайки для показа: сумма ВСЕХ реакций исходного поста (t.me/s) + локальные
  // лайки миниаппа — сердечко остаётся интерактивным поверх реального числа
  const likesCount = p.reactionsTg + p.likesCount

  return {
    id: p.id,
    text: upgradeAnimatedEmoji(p.text),
    mediaUrl: proxiedMediaUrl(p.mediaUrl) ?? p.mediaUrl,
    mediaType: kind,
    media: media as MediaItemDTO | null,
    gallery,
    link: p.link,
    viewsCount,
    viewsTg: p.viewsTg,
    likesCount,
    bookmarksCount,
    publishedAt: p.publishedAt.toISOString(),
    liked: flags.liked,
    bookmarked: flags.bookmarked,
    channel: toChannelDTO(p.channel, flags.subscribed),
  }
}

/*
 * Премиум-эмодзи: ретроактивный апгрейд статичных маркеров в анимированные.
 *
 * В БД хранится канонический текст с ![e:ID](thumb). Раньше апгрейд в ![ev:ID]
 * делал только парсер при ПОСТОЧНОЙ перезаписи — старые посты оставались
 * статичными навсегда (в ленте их 3.1k). Теперь анимированность решается на
 * выдаче: реестр анимированных ID (CustomEmoji, kind='video') кэшируется в
 * памяти, и маркеры переписываются при сериализации. Стоимость — один проход
 * replace по текстам с маркерами (lookup по Set).
 */
function upgradeAnimatedEmoji(text: string): string {
  if (!text.includes('![e:')) return text
  const anim = animatedEmojiIds()
  if (anim.size === 0) return text
  return text.replace(/!\[e:(\d+)\]\(/g, (full, id: string) => (anim.has(id) ? `![ev:${id}](` : full))
}
