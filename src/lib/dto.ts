import type { Channel, Post, Prisma } from '@prisma/client'
import type { ChannelDTO, MediaItemDTO, MediaKind, PostDTO } from '@/lib/types'
import { channelAvatarUrl, proxiedMediaUrl } from '@/lib/media'
import { animatedEmojiKinds } from '@/lib/emoji-registry'
import { cleanPostText } from '@/lib/text-clean'
import { effectiveTier, tierAtLeast } from '@/lib/tiers'

type ChannelWithCategory = Channel & {
  category?: { slug: string; title: string } | null
  /** Включается выборочно (claimedBy с tier/tierUntil) — для бейджа «Premium-автор» (Snap Pro) */
  claimedBy?: { tier?: string | null; tierUntil?: Date | null } | null
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

/*
 * EGRESS-ЭКОНОМИКА (11-a): минимальные select-списки для списков постов/каналов.
 * Ровно те поля, которые читают toPostDTO/toChannelDTO. Крупные колонки БД —
 * ttsAudio (base64 mp3, до ~3.5МБ на пост), translations (JSON-кэш переводов),
 * aiSummary, styleProfile, avatarVideoUrl и прочие служебные — НЕ выбираются:
 * UI их в списках не читает, а Supabase отдавал их байт-в-байт на каждый
 * /api/bookmarks (100 постов!), /api/feed/fresh (поллится каждые ~20с),
 * /api/search, /api/trending и т.д. Форма DTO на выходе НЕ меняется.
 */
export const CHANNEL_LIST_SELECT = {
  id: true,
  title: true,
  username: true,
  description: true,
  avatarColor: true,
  photoFileId: true,
  avatarUrl: true,
  membersCount: true,
  subscribersCount: true,
  isPremium: true,
  verified: true,
  status: true,
  teaserMode: true,
  teaserLimit: true,
  ctaLabel: true,
  ctaUrl: true,
  claimedBy: { select: { tier: true, tierUntil: true } },
  category: { select: { slug: true, title: true } },
} satisfies Prisma.ChannelSelect

export const POST_LIST_SELECT = {
  id: true,
  channelId: true,
  text: true,
  mediaUrl: true,
  mediaType: true,
  mediaMeta: true,
  gallery: true,
  link: true,
  viewsCount: true,
  viewsTg: true,
  reactionsTg: true,
  likesCount: true,
  commentsCount: true,
  publishedAt: true,
  channel: { select: CHANNEL_LIST_SELECT },
} satisfies Prisma.PostSelect

/** Строка поста, обрезанная POST_LIST_SELECT (+ опциональный _count) */
export type PrunedPostRow = Prisma.PostGetPayload<{ select: typeof POST_LIST_SELECT }> & {
  _count?: { bookmarkedBy: number }
}
/** Строка канала, обрезанная CHANNEL_LIST_SELECT (+ опциональный _count) */
export type PrunedChannelRow = Prisma.ChannelGetPayload<{ select: typeof CHANNEL_LIST_SELECT }> & {
  _count?: { posts: number }
}

/**
 * toPostDTO для «обрезанных» строк: рантайм-гарантия полей — сам
 * POST_LIST_SELECT, поэтому сужение типа безопасно (тот же приём, что в
 * сыром SQL /api/feed — postFromRow).
 */
export function postDTOFromRow(
  p: PrunedPostRow,
  flags: { liked: boolean; bookmarked: boolean; subscribed: boolean },
  bookmarksCount = 0,
): PostDTO {
  return toPostDTO(p as unknown as Parameters<typeof toPostDTO>[0], flags, bookmarksCount)
}

/** toChannelDTO для «обрезанных» строк (см. postDTOFromRow) */
export function channelDTOFromRow(
  c: PrunedChannelRow,
  subscribed: boolean,
  postsCount?: number,
): ChannelDTO {
  return toChannelDTO(c as unknown as Parameters<typeof toChannelDTO>[0], subscribed, postsCount)
}

function normalizeKind(raw: string): MediaKind {
  return (KNOWN_KINDS as string[]).includes(raw) ? (raw as MediaKind) : 'image'
}

export function toChannelDTO(
  c: ChannelWithCategory,
  subscribed: boolean,
  postsCount?: number,
): ChannelDTO {
  // Snap Pro (v5.17): владелец с активным тиром Pro → бейдж Premium-автора
  // и его CTA-кнопка в раскрытом посте
  const proOwner = tierAtLeast(effectiveTier(c.claimedBy ?? null), 'pro')
  return {
    id: c.id,
    title: c.title,
    username: c.username,
    // Переносы строк в описании схлопываем: в превью и списках текст должен
    // течь в 2 строки (line-clamp), а не «в столб»
    description: c.description?.replace(/\s+/g, ' ').trim() ?? null,
    avatarColor: c.avatarColor,
    // Аватарка: единый хелпер (v5.56) — мёртвые supabase-ссылки → Bot API-фолбэк,
    // прямые ссылки Telegram CDN (telesco.pe) → /api/media
    avatarUrl: channelAvatarUrl(c.avatarUrl, c.photoFileId, c.id),
    // Реальное число подписчиков из Telegram (getChatMemberCount);
    // для каналов, где Bot API недоступен, — оценка из каталога
    subscribersCount: c.membersCount ?? c.subscribersCount,
    isPremium: c.isPremium,
    verified: c.verified,
    status: c.status,
    categorySlug: c.category?.slug ?? null,
    categoryTitle: c.category?.title ?? null,
    postsCount,
    subscribed,
    teaserMode: c.teaserMode,
    teaserLimit: c.teaserLimit,
    proOwner,
    ctaLabel: proOwner ? (c.ctaLabel ?? null) : null, // CTA виден только у Pro-авторов
    ctaUrl: proOwner ? (c.ctaUrl ?? null) : null,
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
    // cleanPostText — ПОЛНАЯ зачистка НА ВЫДАЧЕ: покрывает легаси-посты БД
    // (дубли строк, хэштег-простыни, utm-хвосты, канальные призывы, невидимые
    // символы), не трогая данные. Дешёво: линейные + построчные проходы,
    // страницы кэшируются выше по стеку.
    text: upgradeAnimatedEmoji(cleanPostText(p.text)),
    mediaUrl: proxiedMediaUrl(p.mediaUrl) ?? p.mediaUrl,
    mediaType: kind,
    media: media as MediaItemDTO | null,
    gallery,
    link: p.link,
    viewsCount,
    viewsTg: p.viewsTg,
    likesCount,
    bookmarksCount,
    commentsCount: p.commentsCount,
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
 * выдаче: реестр анимированных ID (CustomEmoji kind video|lottie) кэшируется
 * в памяти, и маркеры переписываются при сериализации (video → ![ev:],
 * Lottie → ![el:]). Стоимость — один проход replace по текстам с маркерами.
 */
function upgradeAnimatedEmoji(text: string): string {
  if (!text.includes('![e:')) return text
  const kinds = animatedEmojiKinds()
  if (kinds.size === 0) return text
  return text.replace(/!\[e:(\d+)\]\(/g, (full, id: string) => {
    const k = kinds.get(id)
    if (k === 'video') return `![ev:${id}](`
    if (k === 'lottie') return `![el:${id}](`
    return full
  })
}
