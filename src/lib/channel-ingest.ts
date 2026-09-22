import { db } from '@/lib/db'
import { emitAppEvent } from '@/lib/events'
import { bumpCache } from '@/lib/redis'

/**
 * v5.80 — МГНОВЕННЫЙ ИНЖЕСТ ПОСТОВ ИЗ КАНАЛА ВЛАДЕЛЬЦА.
 *
 * Когда бот добавлен админом в привязанный канал (флоу «Мой канал» →
 * «Добавить бота»), Telegram шлёт каждый новый пост канала вебхуком
 * (update.channel_post). Раньше пост появлялся в миниаппе только после
 * очередного обхода веб-превью t.me/s парсером (минуты задержки) — теперь
 * пост попадает в БД и ленту СЕКУНДЫ спустя публикацию.
 *
 * Медиа: Bot API даёт вечный file_id → в БД пишем `tgfile:<file_id>`,
 * клиент получает /api/media?fid=... (см. proxiedMediaUrl + /api/media).
 *
 * Текст: entities → markdown-lite (**bold**, __italic__, `code`, ||spoiler||,
 * [текст](url)) — тот же диалект, что у парсера t.me/s, рендер общий.
 *
 * Альбомы (media_group_id): Telegram присылает каждое фото ОТДЕЛЬНЫМ
 * апдейтом. Первый элемент создаёт пост, остальные ДОКЛЕИВАЮТСЯ в его
 * gallery (поиск лидера группы среди последних постов канала).
 */

export type TgChatRef = { id?: number; title?: string; username?: string; type?: string }

export type TgMessageEntity = {
  type?: string
  offset?: number
  length?: number
  url?: string
  user?: { username?: string }
  language?: string
}

/** Подмножество Telegram Message, нужное для инжеста (channel_post/edited) */
export type TgChannelMessage = {
  message_id?: number
  date?: number
  edit_date?: number
  text?: string
  caption?: string
  media_group_id?: string
  entities?: TgMessageEntity[]
  caption_entities?: TgMessageEntity[]
  photo?: Array<{ file_id?: string; width?: number; height?: number }>
  video?: { file_id?: string; duration?: number; width?: number; height?: number; thumbnail?: { file_id?: string } }
  animation?: { file_id?: string; duration?: number; width?: number; height?: number; thumbnail?: { file_id?: string } }
  video_note?: { file_id?: string; duration?: number; thumbnail?: { file_id?: string } }
  sticker?: { file_id?: string; is_animated?: boolean; is_video?: boolean; emoji?: string }
  voice?: { file_id?: string; duration?: number }
  audio?: { file_id?: string; duration?: number; title?: string; performer?: string }
  document?: { file_id?: string; file_name?: string; thumbnail?: { file_id?: string } }
  poll?: { question?: string; options?: Array<{ text?: string }> }
}

const MAX_TEXT = 8000
const MAX_GALLERY = 10

/* ---------------------- entities → markdown-lite ---------------------- */

/**
 * Конвертация Telegram entities в markdown-lite приложения.
 * Спойлер/цитата/код — теми же маркерами, что и в постах парсера
 * (см. Post.text: **bold**, __italic__, `code`, ||spoiler||, [т](url)).
 * Подчёркивание/зачёркивание markdown-lite не имеет — остаётся plain.
 */
export function entitiesToMarkdown(base: string, entities: TgMessageEntity[] | undefined): string {
  if (!entities || entities.length === 0) return base
  // UTF-16 суррогаты: offset/length в Telegram считаются в code units — JS-строка совпадает
  type Tok = { start: number; end: number; pre: string; post: string; url?: string }
  const toks: Tok[] = []
  for (const e of entities) {
    if (typeof e.offset !== 'number' || typeof e.length !== 'number') continue
    const start = Math.max(0, Math.min(base.length, e.offset))
    const end = Math.max(start, Math.min(base.length, e.offset + e.length))
    if (end <= start) continue
    switch (e.type) {
      case 'bold':
      case 'italic':
      case 'code':
      case 'spoiler':
      case 'pre':
      case 'text_link':
      case 'underline':
      case 'strikethrough':
        break
      default:
        continue // mention/hashtag/url и пр. — остаются как есть
    }
    let pre = ''
    let post = ''
    let url: string | undefined
    switch (e.type) {
      case 'bold':
        pre = '**'
        post = '**'
        break
      case 'italic':
        pre = '__'
        post = '__'
        break
      case 'code':
      case 'pre':
        pre = '`'
        post = '`'
        break
      case 'spoiler':
        pre = '||'
        post = '||'
        break
      case 'underline':
        pre = '__'
        post = '__' // markdown-lite underline нет — рендерим курсивом
        break
      case 'strikethrough':
        pre = '~~'
        post = '~~' // рендер markdown-lite разметку ~~ знает опционально; безопасно
        break
      case 'text_link':
        pre = '['
        post = `](${e.url ?? ''})`
        url = e.url
        break
    }
    toks.push({ start, end, pre, post, url })
  }
  if (toks.length === 0) return base
  // Перекрывающиеся токены: оставляем непересекающиеся (жадно по длине)
  toks.sort((a, b) => a.start - b.start || b.end - a.end)
  const picked: Tok[] = []
  let cursor = 0
  for (const t of toks) {
    if (t.start >= cursor) {
      picked.push(t)
      cursor = t.end
    }
  }
  let out = ''
  let pos = 0
  for (const t of picked) {
    out += base.slice(pos, t.start) + t.pre + base.slice(t.start, t.end) + t.post
    pos = t.end
  }
  out += base.slice(pos)
  return out.slice(0, MAX_TEXT)
}

/* -------------------------- маппинг медиа -------------------------- */

type Mapped = {
  mediaUrl: string | null
  mediaType: string
  mediaMeta: Record<string, unknown> | null
  galleryItem: { kind: string; url: string; poster?: string } | null
}

function mapMedia(msg: TgChannelMessage): Mapped {
  const tgfile = (fid?: string) => (fid ? `tgfile:${fid}` : null)

  if (msg.photo && msg.photo.length > 0) {
    // Берём наибольший размер (последний в массиве Telegram)
    const sizes = msg.photo.filter((p) => typeof p.file_id === 'string' && p.file_id)
    const best = sizes[sizes.length - 1]
    const url = tgfile(best?.file_id)
    if (url) {
      return {
        mediaUrl: url,
        mediaType: 'image',
        mediaMeta: best?.width ? { width: best.width, height: best.height } : null,
        galleryItem: { kind: 'image', url },
      }
    }
  }
  if (msg.animation?.file_id) {
    const a = msg.animation
    return {
      mediaUrl: tgfile(a.file_id),
      mediaType: 'gif',
      mediaMeta: {
        ...(a.duration ? { duration: a.duration } : {}),
        ...(a.width ? { width: a.width, height: a.height } : {}),
        ...(a.thumbnail?.file_id ? { poster: tgfile(a.thumbnail.file_id) } : {}),
      },
      galleryItem: null,
    }
  }
  if (msg.video?.file_id) {
    const v = msg.video
    return {
      mediaUrl: tgfile(v.file_id),
      mediaType: 'video',
      mediaMeta: {
        ...(v.duration ? { duration: v.duration } : {}),
        ...(v.width ? { width: v.width, height: v.height } : {}),
        ...(v.thumbnail?.file_id ? { poster: tgfile(v.thumbnail.file_id) } : {}),
      },
      galleryItem: null,
    }
  }
  if (msg.video_note?.file_id) {
    const v = msg.video_note
    return {
      mediaUrl: tgfile(v.file_id),
      mediaType: 'circle',
      mediaMeta: {
        ...(v.duration ? { duration: v.duration } : {}),
        ...(v.thumbnail?.file_id ? { poster: tgfile(v.thumbnail.file_id) } : {}),
      },
      galleryItem: null,
    }
  }
  if (msg.sticker?.file_id) {
    const s = msg.sticker
    // Видеостикеры (.webm) в <img> не играют — покажем эмодзи стикера текстом
    if (s.is_video || s.is_animated) {
      return { mediaUrl: null, mediaType: 'none', mediaMeta: null, galleryItem: null }
    }
    return {
      mediaUrl: tgfile(s.file_id),
      mediaType: 'sticker',
      mediaMeta: s.emoji ? { emoji: s.emoji } : null,
      galleryItem: null,
    }
  }
  if (msg.voice?.file_id) {
    return {
      mediaUrl: tgfile(msg.voice.file_id),
      mediaType: 'voice',
      mediaMeta: msg.voice.duration ? { duration: msg.voice.duration } : null,
      galleryItem: null,
    }
  }
  if (msg.audio?.file_id) {
    return {
      mediaUrl: tgfile(msg.audio.file_id),
      mediaType: 'audio',
      mediaMeta: {
        ...(msg.audio.duration ? { duration: msg.audio.duration } : {}),
        ...(msg.audio.title ? { title: msg.audio.title.slice(0, 120) } : {}),
        ...(msg.audio.performer ? { performer: msg.audio.performer.slice(0, 120) } : {}),
      },
      galleryItem: null,
    }
  }
  if (msg.document?.file_id) {
    const d = msg.document
    return {
      mediaUrl: tgfile(d.file_id),
      mediaType: 'file',
      mediaMeta: {
        ...(d.file_name ? { name: d.file_name.slice(0, 200) } : {}),
        ...(d.thumbnail?.file_id ? { poster: tgfile(d.thumbnail.file_id) } : {}),
      },
      galleryItem: null,
    }
  }
  if (msg.poll?.question) {
    return {
      mediaUrl: null,
      mediaType: 'poll',
      mediaMeta: {
        question: msg.poll.question.slice(0, 300),
        options: (msg.poll.options ?? [])
          .map((o) => (o.text ?? '').slice(0, 120))
          .filter(Boolean)
          .slice(0, 10),
      },
      galleryItem: null,
    }
  }
  return { mediaUrl: null, mediaType: 'none', mediaMeta: null, galleryItem: null }
}

/* ------------------------------ инжест ------------------------------ */

export type IngestResult = {
  ok: boolean
  reason?: string
  created?: boolean
  updated?: boolean
  galleryAttached?: boolean
  channelId?: string
  postId?: string
}

/**
 * Инжест одного channel_post / edited_channel_post. Безопасно вызывать
 * из вебхука: все ошибки гасятся внутри, результат — только для логов.
 */
export async function ingestChannelPost(
  chat: TgChatRef,
  msg: TgChannelMessage,
  opts?: { edited?: boolean },
): Promise<IngestResult> {
  try {
    const uname = (chat.username ?? '').replace(/^@/, '').toLowerCase()
    if (!uname || typeof msg.message_id !== 'number') {
      return { ok: false, reason: 'нет username/message_id (приватный канал?)' }
    }

    const channel = await db.channel.findUnique({
      where: { username: uname },
      select: { id: true, title: true, status: true, claimedById: true },
    })
    // Инжест только для ПРИВЯЗАННЫХ каналов (свой контент): чужие каналы
    // по-прежнему собирает парсер t.me/s со своими правилами
    if (!channel) return { ok: false, reason: 'канала нет в базе' }
    if (!channel.claimedById) return { ok: false, reason: 'канал не привязан' }

    const tgKey = `${uname}:${msg.message_id}`
    const rawText = (msg.text ?? msg.caption ?? '').slice(0, MAX_TEXT)
    const text = entitiesToMarkdown(rawText, msg.text ? msg.entities : msg.caption_entities)
    const media = mapMedia(msg)
    const publishedAt = new Date(
      (opts?.edited && msg.edit_date ? msg.edit_date : msg.date ?? Math.floor(Date.now() / 1000)) * 1000,
    )

    const existing = await db.post.findUnique({ where: { tgKey }, select: { id: true, gallery: true, mediaMeta: true } })

    /* АЛЬБОМ: пост с этим message_id ещё не создан, но группа уже начата —
       доклеиваем фото в gallery поста-лидера (первое фото группы пришло
       секундами раньше с тем же media_group_id). */
    if (!existing && msg.media_group_id && media.galleryItem) {
      const recent = await db.post.findMany({
        where: { channelId: channel.id },
        orderBy: { publishedAt: 'desc' },
        take: 12,
        select: { id: true, gallery: true, mediaMeta: true, publishedAt: true },
      })
      const leader = recent.find((p) => {
        try {
          const m = (p.mediaMeta ? JSON.parse(p.mediaMeta) : null) as { albumGroup?: string } | null
          return m?.albumGroup === msg.media_group_id
        } catch {
          return false
        }
      })
      if (leader) {
        let items: unknown[] = []
        try {
          items = leader.gallery ? (JSON.parse(leader.gallery) as unknown[]) : []
        } catch {
          items = []
        }
        if (items.length < MAX_GALLERY) {
          items.push(media.galleryItem)
          await db.post
            .update({ where: { id: leader.id }, data: { gallery: JSON.stringify(items) } })
            .catch(() => {})
          return { ok: true, galleryAttached: true, channelId: channel.id, postId: leader.id }
        }
        return { ok: true, galleryAttached: false, channelId: channel.id, postId: leader.id }
      }
    }

    if (existing) {
      // Редактирование поста в канале: обновляем текст/медиа/дату правки
      await db.post.update({
        where: { id: existing.id },
        data: {
          ...(text ? { text } : {}),
          ...(media.mediaUrl ? { mediaUrl: media.mediaUrl, mediaType: media.mediaType } : {}),
          ...(media.mediaMeta ? { mediaMeta: JSON.stringify(media.mediaMeta) } : {}),
          publishedAt,
        },
      })
      return { ok: true, updated: true, channelId: channel.id, postId: existing.id }
    }

    // НЕ редактирование и НЕ альбомное продолжение — новый пост
    const metaJson = media.mediaMeta
      ? JSON.stringify({ ...media.mediaMeta, ...(msg.media_group_id ? { albumGroup: msg.media_group_id } : {}) })
      : msg.media_group_id
        ? JSON.stringify({ albumGroup: msg.media_group_id })
        : null

    const created = await db.post.create({
      data: {
        tgKey,
        channelId: channel.id,
        text,
        mediaUrl: media.mediaUrl,
        mediaType: media.mediaType,
        mediaMeta: metaJson,
        link: `https://t.me/${uname}/${msg.message_id}`,
        publishedAt,
      },
      select: { id: true },
    })

    // Мгновенная видимость: инвалидация индексов ленты + SSE-пилюля «N новых»
    void bumpCache(['feed', 'tr', 'ct', 'ch', 'sr']).catch(() => {})
    emitAppEvent('posts:new', { total: 1, usernames: [uname] })

    return { ok: true, created: true, channelId: channel.id, postId: created.id }
  } catch (e) {
    console.error('[channel-ingest]', e instanceof Error ? e.message.slice(0, 200) : e)
    return { ok: false, reason: 'exception' }
  }
}
