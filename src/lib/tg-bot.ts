import { db } from '@/lib/db'
import { cacheGet, cacheSet } from '@/lib/redis'

/**
 * Клиент Telegram Bot API: реальная доставка уведомлений подписчикам.
 *
 * Правила безопасности/надёжности:
 *  - сообщения отправляются ТОЛЬКО проверенным пользователям (id = tg_<num>,
 *    isGuest=false — т.е. initData прошёл HMAC-проверку);
 *  - chat_id пользователя = его Telegram id (бот может писать тем, кто
 *    открывал Mini App);
 *  - очередь с интервалом 50 мс (≤20 msg/s, ниже лимита 30 msg/s);
 *  - HTML-экранирование текста постов, ограничение длины;
 *  - Post.notifiedAt защищает от повторной отправки.
 *
 * ЭКОНОМИЯ КОМАНД: резолвы Bot API (file_id→URL, фото, счётчики) кэшируются
 * в памяти процесса ПОВЕРХ Redis-кэша — в рамках инстанса Redis не тратится
 * вовсе (Upstash тарифицирует каждую команду).
 */

// ---------------- Память-кэш (L0) поверх Redis ----------------

type MemEntry = { v: string | null; exp: number }
const mem = new Map<string, MemEntry>()
const MEM_MAX = 600

/** undefined — нет записи; null — закэшированный «нет данных» */
function memGet(key: string): string | null | undefined {
  const e = mem.get(key)
  if (!e) return undefined
  if (e.exp <= Date.now()) {
    mem.delete(key)
    return undefined
  }
  return e.v
}

function memSet(key: string, v: string | null, ttlMs: number): void {
  const now = Date.now()
  if (mem.size >= MEM_MAX) {
    let removed = 0
    for (const [k, e] of mem) {
      if (e.exp <= now) {
        mem.delete(k)
        removed++
        if (removed >= MEM_MAX / 10) break
      }
    }
    if (mem.size >= MEM_MAX) {
      const first = mem.keys().next().value
      if (first !== undefined) mem.delete(first)
    }
  }
  mem.set(key, { v, exp: now + ttlMs })
}

const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN?.trim() ?? ''

export function botEnabled(): boolean {
  return BOT_TOKEN().length > 0
}

// ---------------- Глобальный флуд-предохранитель Bot API ----------------

/**
 * После 429 Telegram продолжает банить за КАЖДЫЙ вызов (retry_after растёт).
 * Раньше бэкфиллы и тики продолжали долбить API во время бана — и продлевали
 * его на часы. Теперь первый 429 ставит ГЛОБАЛЬНУЮ паузу (память + Redis):
 * все вызовы Bot API мгновенно возвращают rateLimited, не тратя лимит и
 * не продлевая наказание. Пауза = retry_after от Telegram (кап 4 часа).
 */
const BOT_BAN_LOCAL_KEY = 'bot:globalBanUntil'
const BOT_BAN_REDIS_KEY = 'tgbot:globalBan'
let botBanUntilMs = 0
let botBanRedisChecked = false

/** Есть ли сейчас глобальная пауза Bot API (синхронно, по памяти процесса) */
function botBanned(): boolean {
  return Date.now() < botBanUntilMs
}

/** Отметить глобальную паузу после 429 (retryAfterSec — рекомендация Telegram) */
async function markBotBan(retryAfterSec: number): Promise<void> {
  const until = Date.now() + Math.min(Math.max(retryAfterSec, 30), 4 * 3600) * 1000
  if (until <= botBanUntilMs) return // уже бан длиннее — не укорачиваем
  botBanUntilMs = until
  memSet(BOT_BAN_LOCAL_KEY, String(until), until - Date.now() + 60_000)
  // синхронизируем между инстансами (Vercel): TTL = остаток бана, ±1 команда
  void cacheSet(BOT_BAN_REDIS_KEY, String(until), Math.ceil((until - Date.now()) / 1000)).catch(
    () => {},
  )
}

/** Поднять паузу из Redis при холодном старте инстанса (один раз за процесс) */
async function hydrateBotBan(): Promise<void> {
  if (botBanRedisChecked || botBanned()) return
  botBanRedisChecked = true
  try {
    const v = await cacheGet<string>(BOT_BAN_REDIS_KEY)
    if (v) {
      const until = Number(v)
      if (Number.isFinite(until) && until > Date.now()) {
        botBanUntilMs = until
        memSet(BOT_BAN_LOCAL_KEY, String(until), until - Date.now() + 60_000)
      }
    }
  } catch {
    // Redis моргнул — работает только локальная память
  }
}

/** Диагностика: до какого времени действует глобальная пауза (0 — нет) */
export function botBanRemainSec(): number {
  return Math.max(0, Math.ceil((botBanUntilMs - Date.now()) / 1000))
}

/** Как botBanRemainSec, но поднимает паузу из Redis (для health-эндпоинтов) */
export async function botBanRemainSecAsync(): Promise<number> {
  await hydrateBotBan()
  return botBanRemainSec()
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

export type TgChatInfo = {
  id: string
  title: string
  username: string
  description: string | null
  members: number | null
  photoFileId: string | null
}

/**
 * Полная карточка публичного канала одним вызовом Bot API getChat:
 * реальный chat id, название, описание, аватарка (file_id), число подписчиков.
 * Используется автосбором при создании канала; null — канал не существует,
 * приватный или недоступен боту.
 */
export async function getChatInfo(username: string): Promise<TgChatInfo | null> {
  if (!botEnabled()) return null
  const clean = username.replace(/^@/, '')
  const mk = `ci:${clean}`
  const local = memGet(mk)
  if (local !== undefined) {
    if (local === null || local === 'none') return null
    try {
      return JSON.parse(local) as TgChatInfo
    } catch {
      return null
    }
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/getChat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: `@${clean}` }),
      signal: AbortSignal.timeout(8000),
    })
    const data = (await res.json()) as {
      ok?: boolean
      result?: {
        id?: number
        type?: string
        title?: string
        username?: string
        description?: string
        photo?: { big_file_id?: string; small_file_id?: string }
      }
    }
    const r = data?.result
    if (!data?.ok || !r || r.type !== 'channel' || typeof r.id !== 'number') {
      memSet(mk, 'none', 10 * 60_000)
      return null
    }
    const info: TgChatInfo = {
      id: String(r.id),
      title: r.title ?? clean,
      username: r.username ?? clean,
      description: r.description ?? null,
      members: null, // member count идёт отдельным дешёвым вызовом по необходимости
      photoFileId: r.photo?.big_file_id ?? r.photo?.small_file_id ?? null,
    }
    memSet(mk, JSON.stringify(info), 30 * 60_000)
    return info
  } catch {
    return null
  }
}

export type ChatCardResult = {
  /** file_id аватарки (null — у канала нет фото, но сам канал существует) */
  photoFileId: string | null
  /** реальное число подписчиков (null — нет данных) */
  members: number | null
  /** Bot API ответил 429 (флуд-бан) — пакетную обработку нужно остановить */
  rateLimited: boolean
  /** канал не существует/приватен (400/403): штампуем TTL, чтобы не дёргать каждый тик */
  notFound?: boolean
  /** вызовы прошли (не сетевой сбой): можно штамповать fetchedAt */
  ok: boolean
}

/**
 * Карточка канала ОДНИМ параллельным заходом (getChat + getChatMemberCount).
 * Отличается от «слепых» хелперов тем, что РАЗЛИЧАЕТ «фото нет» и «Bot API
 * пригрозил баном за частые вызовы»: при 429 пакетный бэкфилл обязан
 * остановиться и НЕ штамповать время — иначе каналы «выпадут» из обновления
 * на весь срок TTL.
 */
export async function getChatCard(username: string): Promise<ChatCardResult> {
  const clean = username.replace(/^@/, '')
  const empty: ChatCardResult = { photoFileId: null, members: null, rateLimited: false, ok: false }
  if (!botEnabled()) return empty
  await hydrateBotBan()
  // Глобальная пауза: не дёргаем API во время флуд-бана (иначе продлеваем его)
  if (botBanned()) return { ...empty, rateLimited: true }
  try {
    const [chatRes, membersRes] = await Promise.all([
      fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/getChat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: `@${clean}` }),
        signal: AbortSignal.timeout(8000),
      }),
      fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/getChatMemberCount`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: `@${clean}` }),
        signal: AbortSignal.timeout(8000),
      }),
    ])
    // Флуд-защита: 429 — сигнал остановить ВСЮ пакетную обработку Bot API:
    // ставим глобальную паузу и НЕ штампуем канал (повтор после снятия)
    if (chatRes.status === 429 || membersRes.status === 429) {
      const retry = Number(chatRes.headers.get('retry-after') ?? membersRes.headers.get('retry-after') ?? '0')
      memSet(`cardban:${clean}`, String(retry), Math.min(30, Math.max(1, retry)) * 1000)
      void markBotBan(retry)
      return { photoFileId: null, members: null, rateLimited: true, ok: false }
    }
    // Канал удалён/приватен: Telegram отвечает 400/403 — фиксируем notFound,
    // чтобы шедулер не молотил несуществующий канал каждый тик
    if (chatRes.status === 400 || chatRes.status === 403 || membersRes.status === 400 || membersRes.status === 403) {
      return { photoFileId: null, members: null, rateLimited: false, notFound: true, ok: false }
    }
    const chat = (await chatRes.json().catch(() => null)) as {
      ok?: boolean
      result?: { photo?: { big_file_id?: string; small_file_id?: string } }
    } | null
    const mc = (await membersRes.json().catch(() => null)) as {
      ok?: boolean
      result?: number
    } | null
    if (!chatRes.ok && chatRes.status !== 200) return empty
    const photoFileId = chat?.ok ? (chat.result?.photo?.big_file_id ?? chat.result?.photo?.small_file_id ?? null) : null
    const members = mc?.ok && typeof mc.result === 'number' ? mc.result : null
    return { photoFileId, members, rateLimited: false, ok: Boolean(chat?.ok || mc?.ok) }
  } catch {
    return empty
  }
}

/**
 * Реальное число подписчиков публичного канала через Bot API getChatMemberCount.
 * Кэш: память 1ч → Redis 24ч («нет данных» тоже кэшим сентинелом none, чтобы
 * не молотить Bot API на каждый запрос). Для закрытых/несуществующих — null.
 */
export async function getChatMemberCount(username: string): Promise<number | null> {
  if (!botEnabled()) return null
  const clean = username.replace(/^@/, '')

  const mk = `mc:${clean}`
  const local = memGet(mk)
  if (local !== undefined) return local === null ? null : Number(local)

  const ck = `tgmembers:${clean}`
  const cached = await cacheGet<string>(ck)
  if (cached !== null) {
    const v = cached === 'none' ? null : Number(cached)
    memSet(mk, v === null ? null : String(v), 60 * 60_000)
    return v
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/getChatMemberCount`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: `@${clean}` }),
      signal: AbortSignal.timeout(8000),
    })
    const data = (await res.json()) as { ok?: boolean; result?: number }
    if (data?.ok && typeof data.result === 'number' && data.result >= 0) {
      await cacheSet(ck, String(data.result), 24 * 60 * 60)
      memSet(mk, String(data.result), 60 * 60_000)
      return data.result
    }
    await cacheSet(ck, 'none', 60 * 60)
    memSet(mk, null, 10 * 60_000)
    return null
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

  // Кэш: память 6ч → Redis 24ч: file_id вечен, «нет фото» тоже кэшим
  // (сентинел none), чтобы не дёргать Bot API на каждый вход пользователя.
  const mk = `up:${tgUserId}`
  const local = memGet(mk)
  if (local !== undefined) return local === 'none' ? null : local

  const ck = `tgphoto:${tgUserId}`
  const cached = await cacheGet<string>(ck)
  if (cached !== null) {
    memSet(mk, cached, 6 * 60 * 60_000)
    return cached === 'none' ? null : cached
  }

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
      memSet(mk, 'none', 60 * 60_000)
      return null
    }
    const sizes = photos[0]
    if (!sizes || sizes.length === 0) {
      await cacheSet(ck, 'none', 24 * 60 * 60)
      memSet(mk, 'none', 60 * 60_000)
      return null
    }
    // Самый большой размер последним (Telegram отдаёт по возрастанию)
    const best = [...sizes]
      .sort((a, b) => (a.width ?? 0) * (a.height ?? 0) - (b.width ?? 0) * (b.height ?? 0))
      .pop()
    const fileId = best?.file_id && typeof best.file_id === 'string' ? best.file_id : null
    if (fileId) {
      await cacheSet(ck, fileId, 24 * 60 * 60)
      memSet(mk, fileId, 6 * 60 * 60_000)
    }
    return fileId
  } catch {
    return null
  }
}

/**
 * Состоит ли пользователь в публичном канале? Bot API getChatMember.
 *
 * Нюансы доступа: боту разрешено запрашивать участников канала, только если
 * сам бот в нём состоит (обычно админ). Поэтому:
 *  - true/false — бот видит чат и ответил точно (кэш в памяти 5 мин);
 *  - null — проверить нечем (бота нет в канале / чат не найдён / нет токена).
 * Используется для подтверждения «подписки в один тап»: миниапп открывает
 * канал в клиенте Telegram, а после возврата мы сверяем членство.
 */
export async function isTelegramMember(
  username: string,
  tgUserId: number,
): Promise<boolean | null> {
  if (!botEnabled()) return null
  const clean = username.replace(/^@/, '')

  const mk = `cm:${clean}:${tgUserId}`
  const local = memGet(mk)
  if (local !== undefined) return local === '1' ? true : local === '0' ? false : null

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/getChatMember`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: `@${clean}`, user_id: tgUserId }),
      signal: AbortSignal.timeout(8000),
    })
    const data = (await res.json()) as {
      ok?: boolean
      result?: { status?: string; is_member?: boolean }
    }
    if (data?.ok) {
      const status = data.result?.status
      const member =
        status === 'creator' ||
        status === 'administrator' ||
        status === 'member' ||
        (status === 'restricted' && data.result?.is_member === true)
      memSet(mk, member ? '1' : '0', 5 * 60_000)
      return member
    }
    // «bot is not a member» / «chat not found» — проверка недоступна
    memSet(mk, 'none', 5 * 60_000)
    return null
  } catch {
    return null
  }
}

// --- getFile: file_id → временный CDN-URL ---
// Кэш: память 40мин → Redis 45мин (URL живёт ~1 час), общий для всех инстансов —
// аватары не дёргают ни Bot API, ни Redis на каждый запрос.
const FILE_URL_TTL_SEC = 45 * 60
const FILE_URL_MEM_TTL_MS = 40 * 60_000

export async function resolveTelegramFileUrl(fileId: string): Promise<string | null> {
  const mk = `fu:${fileId}`
  const local = memGet(mk)
  if (local !== undefined) return local === 'none' ? null : local

  const ck = `tgfile:${fileId}`
  const cached = await cacheGet<string>(ck)
  if (cached) {
    memSet(mk, cached, FILE_URL_MEM_TTL_MS)
    return cached
  }
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
    memSet(mk, url, FILE_URL_MEM_TTL_MS)
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

/** Информация о кастомном эмодзи: анимированный видео-стикер + file_id файла */
export type CustomEmojiInfo = { video: boolean; fileId: string | null }

/**
 * Премиум-эмодзи через Bot API getCustomEmojiStickers (до 200 id за вызов).
 * Возвращает map: custom_emoji_id → информация о стикере. Анимированные
 * видео-стикеры (is_video) рендерятся миниаппом как <video> через /api/emoji/[id];
 * Lottie-наборы (.tgs) не рендерим без плеера — остаются статичные картинки.
 */
export async function getCustomEmojiStickers(ids: string[]): Promise<Map<string, CustomEmojiInfo>> {
  const out = new Map<string, CustomEmojiInfo>()
  if (!botEnabled() || ids.length === 0) return out
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/getCustomEmojiStickers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ custom_emoji_ids: chunk }),
        signal: AbortSignal.timeout(10_000),
      })
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean
        result?: Array<{ custom_emoji_id?: string; is_video?: boolean; file?: { file_id?: string } }>
      } | null
      for (const s of data?.result ?? []) {
        if (s.custom_emoji_id) {
          out.set(s.custom_emoji_id, { video: s.is_video === true, fileId: s.file?.file_id ?? null })
        }
      }
    } catch {
      // битый чанк не роняет прогон — эмодзи останутся статичными до следующего тика
    }
  }
  return out
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
  return `<b>${title}</b>${text ? `\n\n${text}` : ''}\n\n<a href="${url}">Открыть в Telegram →</a>`
}

/**
 * Разослать новые посты подписчикам с включённым колокольчиком.
 * Вызывается после парсинга; помечает посты notifiedAt, чтобы ретраи
 * не дублировали рассылку.
 */
export async function notifyNewPosts(posts: NotifiablePost[]): Promise<NotifyResult> {
  if (!botEnabled() || posts.length === 0) return { sent: 0, failed: 0, recipients: 0 }
  // Флуд-бан Bot API: отправка в Telegram сейчас невозможна — но посты НЕ помечаем
  // notifiedAt (см. ниже): рассылка догонит после снятия бана при следующем прогоне
  await hydrateBotBan()
  if (botBanned()) return { sent: 0, failed: 0, recipients: 0 }

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
      user: { isGuest: false, id: { startsWith: 'tg_' } },
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
