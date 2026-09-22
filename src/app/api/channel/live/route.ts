import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { channelAvatarUrl, proxiedMediaUrl } from '@/lib/media'
import { SITE_URL } from '@/lib/site'
import {
  botDeleteChannelMessage,
  botEditChannelMessage,
  botPinChannelMessage,
  botPublishToChannel,
  botSetChatDescription,
  botSetChatPhoto,
  botSetChatTitle,
} from '@/lib/tg-bot'

export const dynamic = 'force-dynamic'

/**
 * «Живой канал» (v5.65) — нативный интерфейс управления каналом в стиле Telegram.
 *
 * GET  ?channelId= → шапка канала + последние посты (баблы чата).
 * POST — ручные действия админа (без ИИ):
 *   send   {channelId, text, imageUrl?}   → публикация поста через бота (+в ленту)
 *   delete {channelId, postId}            → безвозвратное удаление (Telegram + БД)
 *   edit   {channelId, postId, text}      → правка текста опубликованного поста
 *   pin    {channelId, postId, unpin?}    → закрепить/открепить пост
 *   meta   {channelId, title?/description?/avatarUrl?} → настройки канала
 *
 * Права: только владелец (Channel.claimedById === uid). Все операции в Telegram
 * выполняются ботом — ошибки Bot API (нет прав админа) отдаются текстом.
 */

const livePostSelect = {
  id: true,
  tgKey: true,
  text: true,
  mediaUrl: true,
  mediaType: true,
  gallery: true,
  link: true,
  viewsTg: true,
  viewsCount: true,
  reactionsTg: true,
  likesCount: true,
  publishedAt: true,
} as const

type LivePostRow = {
  id: string
  tgKey: string
  text: string
  mediaUrl: string | null
  mediaType: string
  gallery: string | null
  link: string | null
  viewsTg: number | null
  viewsCount: number
  reactionsTg: number
  likesCount: number
  publishedAt: Date
}

function chatPostDTO(p: LivePostRow) {
  // gallery — JSON массив (legacy строки | MediaItem[])
  let gallery: Array<{ url: string }> = []
  if (p.gallery) {
    try {
      const arr = JSON.parse(p.gallery) as unknown
      if (Array.isArray(arr)) {
        gallery = arr
          .slice(0, 6)
          .map((g) => {
            const url = typeof g === 'string' ? g : ((g as { url?: string })?.url ?? '')
            return url ? { url: proxiedMediaUrl(url) ?? url } : null
          })
          .filter((v): v is { url: string } => v !== null)
      }
    } catch {
      /* повреждённый JSON — пропускаем */
    }
  }
  const messageId = Number(p.tgKey.split(':')[1])
  return {
    id: p.id,
    text: p.text,
    mediaUrl: proxiedMediaUrl(p.mediaUrl) ?? null,
    mediaType: p.mediaType,
    gallery,
    link: p.link,
    messageId: Number.isFinite(messageId) && messageId > 0 ? messageId : null,
    views: p.viewsTg ?? p.viewsCount,
    reactions: p.reactionsTg,
    likes: p.likesCount,
    publishedAt: p.publishedAt.toISOString(),
  }
}

async function ownedChannel(channelId: string, uid: string) {
  const ch = await db.channel.findUnique({
    where: { id: channelId },
    select: {
      id: true,
      username: true,
      title: true,
      description: true,
      avatarUrl: true,
      photoFileId: true,
      membersCount: true,
      subscribersCount: true,
      claimedById: true,
      ctaLabel: true,
      ctaUrl: true,
      teaserMode: true,
    },
  })
  if (!ch || ch.claimedById !== uid) return null
  return ch
}

/** /api/upload/<id> → абсолютный https (Telegram качает файл сам) */
function absoluteMediaUrl(u: string): string | null {
  if (/^https:\/\//i.test(u)) return u
  if (u.startsWith('/api/upload/')) return `${SITE_URL}${u}`
  if (u.startsWith('/api/media?u=')) {
    const inner = decodeURIComponent(u.slice('/api/media?u='.length))
    return /^https:\/\//i.test(inner) ? inner : null
  }
  return null
}

/* ------------------------------- GET ------------------------------- */

export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'channel-live' })
  if (!g.ok) return g.res

  try {
    const url = new URL(request.url)
    const channelId = url.searchParams.get('channelId') ?? ''
    if (!channelId) return err('Не указан канал')

    const ch = await ownedChannel(channelId, g.uid)
    if (!ch) return err('Канал не найден или не привязан', 404)

    const posts = await db.post.findMany({
      where: { channelId: ch.id },
      orderBy: { publishedAt: 'desc' },
      take: 60,
      select: livePostSelect,
    })

    return NextResponse.json({
      channel: {
        id: ch.id,
        username: ch.username,
        title: ch.title,
        description: ch.description,
        // v5.71: единый channelAvatarUrl — вечный photoFileId приоритетнее сырой
        // telesco-ссылки (раньше сырая выигрывала, ротировалась и «слетала»)
        avatarUrl: channelAvatarUrl(ch.avatarUrl, ch.photoFileId, ch.id),
        subscribers: ch.membersCount ?? ch.subscribersCount,
        ctaLabel: ch.ctaLabel,
        ctaUrl: ch.ctaUrl,
      },
      posts: posts.map(chatPostDTO),
    })
  } catch (e) {
    console.error('[channel-live:get]', e)
    return err('Ошибка', 500)
  }
}

/* ------------------------------- POST ------------------------------ */

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('send'),
    channelId: z.string().min(1),
    text: z.string().trim().min(1).max(4000),
    imageUrl: z.string().trim().max(600).optional(),
  }),
  z.object({
    action: z.literal('delete'),
    channelId: z.string().min(1),
    postId: z.string().min(1),
  }),
  z.object({
    action: z.literal('edit'),
    channelId: z.string().min(1),
    postId: z.string().min(1),
    text: z.string().trim().min(1).max(4000),
  }),
  z.object({
    action: z.literal('pin'),
    channelId: z.string().min(1),
    postId: z.string().min(1),
    unpin: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('meta'),
    channelId: z.string().min(1),
    title: z.string().trim().min(1).max(128).optional(),
    description: z.string().trim().max(255).optional(),
    avatarUrl: z.string().trim().max(600).optional(),
  }),
])

export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 30, windowMs: 60_000, bucket: 'channel-live-post' })
  if (!g.ok) return g.res

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('Некорректные данные')
    const d = parsed.data

    const ch = await ownedChannel(d.channelId, g.uid)
    if (!ch) return err('Канал не найден или не привязан', 404)
    const username = ch.username

    /* --- Публикация поста --- */
    if (d.action === 'send') {
      const absImage = d.imageUrl ? absoluteMediaUrl(d.imageUrl) : null
      if (d.imageUrl && !absImage) return err('Неподдерживаемая ссылка на картинку')

      const r = await botPublishToChannel(username, d.text, absImage).catch(() => ({
        ok: false as const,
        error: 'Ошибка Bot API',
      }))
      if (!r.ok || !r.link) {
        return err(
          r.error ?? 'Не удалось опубликовать — добавьте бота администратором канала с правом публикации',
        )
      }

      // Пост попадает и в ленту Tg Swipe (как посты парсера/отложенные)
      const messageId = Number(r.link.split('/').pop())
      const post =
        Number.isFinite(messageId) && messageId > 0
          ? await db.post
              .create({
                data: {
                  tgKey: `${username}:${messageId}`,
                  channelId: ch.id,
                  text: d.text,
                  ...(d.imageUrl ? { mediaUrl: d.imageUrl, mediaType: 'image' } : { mediaType: 'none' }),
                  publishedAt: new Date(),
                },
              })
              .catch(() => null) // дубликат tgKey — пост уже в ленте
          : null

      return NextResponse.json({
        ok: true,
        link: r.link,
        post: post
          ? chatPostDTO(await db.post.findUniqueOrThrow({ where: { id: post.id }, select: livePostSelect }))
          : null,
      })
    }

    /* --- Удаление поста (Telegram + БД, безвозвратно) --- */
    if (d.action === 'delete') {
      const post = await db.post.findFirst({
        where: { id: d.postId, channelId: ch.id },
        select: { id: true, tgKey: true },
      })
      if (!post) return err('Пост не найден', 404)

      const messageId = Number(post.tgKey.split(':')[1])
      let tgDeleted = false
      if (Number.isFinite(messageId) && messageId > 0) {
        tgDeleted = await botDeleteChannelMessage(username, messageId)
          .then((r) => r.ok)
          .catch(() => false)
      }
      // Из ленты Tg Swipe пост уходит всегда (каскад сотрёт лайки/комменты)
      await db.post.delete({ where: { id: post.id } })

      return NextResponse.json({ ok: true, tgDeleted })
    }

    /* --- Правка текста опубликованного поста --- */
    if (d.action === 'edit') {
      const post = await db.post.findFirst({
        where: { id: d.postId, channelId: ch.id },
        select: { id: true, tgKey: true },
      })
      if (!post) return err('Пост не найден', 404)

      const messageId = Number(post.tgKey.split(':')[1])
      let tgEdited = false
      if (Number.isFinite(messageId) && messageId > 0) {
        tgEdited = await botEditChannelMessage(username, messageId, d.text)
          .then((r) => r.ok)
          .catch(() => false)
      }
      await db.post.update({ where: { id: post.id }, data: { text: d.text } })
      return NextResponse.json({ ok: true, tgEdited })
    }

    /* --- Закрепление / открепление --- */
    if (d.action === 'pin') {
      const post = await db.post.findFirst({
        where: { id: d.postId, channelId: ch.id },
        select: { id: true, tgKey: true },
      })
      if (!post) return err('Пост не найден', 404)

      const messageId = Number(post.tgKey.split(':')[1])
      if (!Number.isFinite(messageId) || messageId <= 0) return err('У поста нет номера сообщения в Telegram')

      const r = await botPinChannelMessage(username, messageId, Boolean(d.unpin)).catch(() => ({
        ok: false as const,
        error: 'Ошибка Bot API',
      }))
      if (!r.ok) return err(r.error ?? 'Не удалось закрепить — боту нужно право pin_messages')
      return NextResponse.json({ ok: true })
    }

    /* --- Настройки канала (классическое меню: название/описание/аватар) --- */
    if (d.action === 'meta') {
      const results: Record<string, boolean> = {}

      if (d.title !== undefined) {
        const r = await botSetChatTitle(username, d.title).catch(() => ({ ok: false as const }))
        results.title = r.ok
        if (r.ok) await db.channel.update({ where: { id: ch.id }, data: { title: d.title } }).catch(() => {})
      }
      if (d.description !== undefined) {
        const r = await botSetChatDescription(username, d.description).catch(() => ({ ok: false as const }))
        results.description = r.ok
        if (r.ok)
          await db.channel.update({ where: { id: ch.id }, data: { description: d.description } }).catch(() => {})
      }
      if (d.avatarUrl !== undefined) {
        const abs = absoluteMediaUrl(d.avatarUrl)
        if (!abs) return err('Неподдерживаемая ссылка на аватар')
        const r = await botSetChatPhoto(username, abs).catch(() => ({ ok: false as const }))
        results.avatar = r.ok
        if (r.ok) {
          // Сбрасываем старую og-ссылку: парсер принесёт свежую с t.me/s в течение ~часа;
          // пока показываем photoFileId через /api/avatar
          await db.channel
            .update({ where: { id: ch.id }, data: { avatarUrl: null, avatarHash: null } })
            .catch(() => {})
        }
      }

      if (Object.keys(results).length === 0) return err('Нет изменений')
      return NextResponse.json({ ok: true, results })
    }

    return err('Неизвестное действие')
  } catch (e) {
    console.error('[channel-live:post]', e)
    return err('Ошибка', 500)
  }
}
