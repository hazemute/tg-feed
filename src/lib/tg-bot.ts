import { db } from '@/lib/db'
import { cacheGet, cacheSet } from '@/lib/redis'

/**
 * Клиент Telegram Bot API: реальная доставка уведомлений подписчикам.
 *
 * Правила безопасности/надёжности:
 *  - сообщения отправляются ТОЛЬКО проверенным пользователям (id = tg_<num>,
 *    isDemo=false — т.е. initData прошёл HMAC-проверку);
 *  - chat_id пользователя = его Telegram id (бот может писать тем, кто
 *    открывал Mini App);
 *  - очередь с интервалом 50 мс (≤20 msg/s, ниже лимита 30 msg/s);
 *  - HTML-экранирование текста постов, ограничение длины;
 *  - Post.notifiedAt защищает от повторной отправки.
 */

const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN?.trim() ?? ''

export function botEnabled(): boolean {
  return BOT_TOKEN().length > 0
}

let meCache: { username: string | null; expiresAt: number } | null = null

/** Username бота (кэш 10 минут; при отсутствии токена/ошибке — null) */
export async function getBotUsername(): Promise<string | null> {
  if (!botEnabled()) return null
  if (meCache && meCache.expiresAt > Date.now()) return meCache.username
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/getMe`, {
      signal: AbortSignal.timeout(8000),
    })
    const data = (await res.json()) as { ok?: boolean; result?: { username?: string } }
    const username = data?.ok && data.result?.username ? data.result.username : null
    meCache = { username, expiresAt: Date.now() + (username ? 10 : 1) * 60_000 }
    return username
  } catch {
    meCache = { username: null, expiresAt: Date.now() + 60_000 }
    return null
  }
}

type TgPhotoSize = { file_id?: string; width?: number; height?: number }

/**
 * Аватарка публичного канала через Bot API getChat (chat_id=@username).
 * Возвращает file_id самого большого размера (big_file_id) — вечный
 * идентификатор, рендер через /api/avatar/c_<channelId> → getFile.
 */
export async function getChatPhotoFileId(username: string): Promise<string | null> {
  if (!botEnabled()) return null
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/getChat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: `@${username.replace(/^@/, '')}` }),
      signal: AbortSignal.timeout(8000),
    })
    const data = (await res.json()) as {
      ok?: boolean
      result?: { photo?: { small_file_id?: string; big_file_id?: string } }
    }
    if (!data?.ok) return null
    const photo = data.result?.photo
    return photo?.big_file_id ?? photo?.small_file_id ?? null
  } catch {
    return null
  }
}

/**
 * Последнее фото профиля пользователя через Bot API (getUserProfilePhotos).
 * Возвращает file_id самого большого размера — вечный идентификатор файла
 * (в отличие от photo_url из initDataUnsafe, который живёт ~1 час).
 * Превращается в URL через /api/avatar/[uid] → getFile.
 */
export async function getUserPhotoFileId(tgUserId: number): Promise<string | null> {
  if (!botEnabled()) return null

  // Redis-кэш 24ч: file_id вечен, «нет фото» тоже кэшим (сентинел none),
  // чтобы не дёргать Bot API на каждый вход пользователя.
  const ck = `tgphoto:${tgUserId}`
  const cached = await cacheGet<string>(ck)
  if (cached !== null) return cached === 'none' ? null : cached

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/getUserProfilePhotos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: tgUserId, limit: 1 }),
      signal: AbortSignal.timeout(8000),
    })
    const data = (await res.json()) as {
      ok?: boolean
      result?: { photos?: TgPhotoSize[][]; total_count?: number }
    }
    const photos = data?.ok ? data.result?.photos : undefined
    if (!photos || photos.length === 0) {
      await cacheSet(ck, 'none', 24 * 60 * 60)
      return null
    }
    const sizes = photos[0]
    if (!sizes || sizes.length === 0) {
      await cacheSet(ck, 'none', 24 * 60 * 60)
      return null
    }
    // Самый большой размер последним (Telegram отдаёт по возрастанию)
    const best = [...sizes]
      .sort((a, b) => (a.width ?? 0) * (a.height ?? 0) - (b.width ?? 0) * (b.height ?? 0))
      .pop()
    const fileId = best?.file_id && typeof best.file_id === 'string' ? best.file_id : null
    if (fileId) await cacheSet(ck, fileId, 24 * 60 * 60)
    return fileId
  } catch {
    return null
  }
}

// --- getFile: file_id → временный CDN-URL ---
// Redis-кэш 45 минут (URL живёт ~1 час), общий для всех инстансов —
// аватары не дёргают Bot API на каждый запрос.
const FILE_URL_TTL_SEC = 45 * 60

export async function resolveTelegramFileUrl(fileId: string): Promise<string | null> {
  const ck = `tgfile:${fileId}`
  const cached = await cacheGet<string>(ck)
  if (cached) return cached
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/getFile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
      signal: AbortSignal.timeout(8000),
    })
    const data = (await res.json()) as { ok?: boolean; result?: { file_path?: string } }
    const path = data?.ok && data.result?.file_path ? data.result.file_path : null
    if (!path) return null
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN()}/${path}`
    await cacheSet(ck, url, FILE_URL_TTL_SEC)
    return url
  } catch {
    return null
  }
}

async function callMethod(method: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    const data = (await res.json().catch(() => null)) as { ok?: boolean } | null
    return res.ok && data?.ok === true
  } catch {
    return false
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Модель поста, пригодного для отправки (после парсера) */
export type NotifiablePost = {
  id: string
  text: string
  link: string | null
  channel: { username: string; title: string }
}

export type NotifyResult = { sent: number; failed: number; recipients: number }

const MAX_POSTS_PER_USER = 10 // защита от спама за один прогон парсера
const SEND_INTERVAL_MS = 50 // 20 msg/s — ниже официального лимита 30 msg/s

function formatPostMessage(post: NotifiablePost): string {
  const title = escapeHtml(post.channel.title)
  const text = post.text ? escapeHtml(post.text.slice(0, 350)) + (post.text.length > 350 ? '…' : '') : ''
  const url = post.link || `https://t.me/${post.channel.username}`
  return `📰 <b>${title}</b>${text ? `\n\n${text}` : ''}\n\n<a href="${url}">Открыть в Telegram →</a>`
}

/**
 * Разослать новые посты подписчикам с включённым колокольчиком.
 * Вызывается после парсинга; помечает посты notifiedAt, чтобы ретраи
 * не дублировали рассылку.
 */
export async function notifyNewPosts(posts: NotifiablePost[]): Promise<NotifyResult> {
  if (!botEnabled() || posts.length === 0) return { sent: 0, failed: 0, recipients: 0 }

  const channelIds = [...new Set(posts.map((p) => p.channel.username))]
  const byUsername = new Map(posts.map((p) => [p.channel.username, p]))

  const channels = await db.channel.findMany({
    where: { username: { in: channelIds } },
    select: { id: true, username: true },
  })
  const channelIdByUsername = new Map(channels.map((c) => [c.username, c.id]))

  // Подписчики с колокольчиком — только проверенные (не демо) пользователи
  const subs = await db.subscription.findMany({
    where: {
      notify: true,
      channelId: { in: [...channelIdByUsername.values()] },
      user: { isDemo: false, id: { startsWith: 'tg_' } },
    },
    select: { userId: true, channelId: true },
  })
  if (subs.length === 0) {
    await markNotified(posts)
    return { sent: 0, failed: 0, recipients: 0 }
  }

  // channelId → username постов
  const postsByChannelId = new Map<string, NotifiablePost[]>()
  for (const p of posts) {
    const cid = channelIdByUsername.get(p.channel.username)
    if (!cid) continue
    const list = postsByChannelId.get(cid) ?? []
    list.push(p)
    postsByChannelId.set(cid, list)
  }

  const userChat = new Map<string, number>()
  for (const s of subs) {
    const n = Number(s.userId.slice('tg_'.length))
    if (Number.isInteger(n) && n > 0) userChat.set(s.userId, n)
  }

  let sent = 0
  let failed = 0

  for (const [userId, chatId] of userChat) {
    // Посты этого прогона, релевантные пользователю (по каналам с notify=true)
    const relevant = subs
      .filter((s) => s.userId === userId)
      .flatMap((s) => postsByChannelId.get(s.channelId) ?? [])
      .slice(0, MAX_POSTS_PER_USER)

    for (const post of relevant) {
      const ok = await callMethod('sendMessage', {
        chat_id: chatId,
        text: formatPostMessage(post),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      })
      if (ok) sent++
      else failed++
      await new Promise((r) => setTimeout(r, SEND_INTERVAL_MS))
    }
  }

  await markNotified(posts)
  return { sent, failed, recipients: userChat.size }
}

/** Пометить посты обработанными (не рассылать повторно) */
async function markNotified(posts: NotifiablePost[]): Promise<void> {
  const ids = posts.map((p) => p.id).filter(Boolean)
  if (ids.length === 0) return
  try {
    await db.post.updateMany({ where: { id: { in: ids } }, data: { notifiedAt: new Date() } })
  } catch (e) {
    console.error('[tg-bot] markNotified failed', e)
  }
}
