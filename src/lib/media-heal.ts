import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { parseChannelHtml } from '@/lib/parse-engine'
import type { ParsedPost } from '@/lib/parse-engine'
import { ogAvatarOf, syncChannelAvatarFromUrl } from '@/lib/avatar-store'
import { isTrustedMediaUrl } from '@/lib/media'

/**
 * САМОЛЕЧЕНИЕ МЕДИА (v5.59) — «у постов не грузятся аватарки и медиа».
 *
 * ПРИЧИНА (доказано замером прода: 5/5 трендовых медиа = 404): парсер
 * сохраняет в Post.mediaUrl/gallery/mediaMeta и Channel.avatarUrl ПРЯМЫЕ
 * ссылки cdn*.telesco.pe — а Telegram их ПРОТУХЛИВАЕТ (ротация токенов
 * через часы/дни). Прокси /api/media работает идеально, но проксирует
 * мёртвый URL → 404 → пустые карточки.
 *
 * РЕШЕНИЕ: /api/media при 404/403 от Telegram вызывает healMediaUrl():
 *  1) находит владельца мёртвого URL в БД (пост или канал);
 *  2) перезагружает СВЕЖУЮ страницу t.me/<канал>/<пост>?embed=1 (или
 *     лендинг канала для аватарки) — Telegram выдаёт НОВЫЕ ссылки;
 *  3) обновляет БД свежими URL (следующие страницы ленты уже здоровые);
 *  4) возвращает свежий URL — прокси отдаёт байты в ЭТОМ ЖЕ ответе.
 *
 * Итог: юзер видит картинку (задержка один раз ~0.5-2с), дальше edge-кэш
 * 30 дней; каталог самолечится и парсером (проба свежих URL через прокси).
 */

export type MediaHealResult = {
  url: string
  /** что было обновлено в БД (для лога) */
  updated: 'post' | 'channel' | 'none'
} | null

/** Негативный кэш: URL, которые не удалось вылечить — не дёргаем t.me каждый раз */
const NEG_TTL_MS = 10 * 60_000
const negCache = new Map<string, number>()
/** Дедуп параллельных лечений одного URL (stampede protection) */
const inflight = new Map<string, Promise<MediaHealResult>>()

function negGet(url: string): boolean {
  const until = negCache.get(url)
  if (until && until > Date.now()) return true
  if (until) negCache.delete(url)
  return false
}

function negSet(url: string): void {
  if (negCache.size > 500) {
    const now = Date.now()
    for (const [k, v] of negCache) if (v <= now) negCache.delete(k)
  }
  negCache.set(url, Date.now() + NEG_TTL_MS)
}

/** Идентичность telesco-ссылки: путь без query (токены ротируются) */
function urlIdentity(raw: string): string | null {
  try {
    const u = new URL(raw)
    if (!isTrustedMediaUrl(raw)) return null
    return `${u.hostname}${u.pathname}`
  } catch {
    return null
  }
}

/** Экранирование LIKE-символов (_ и %) для паттерна с ESCAPE '\' */
function likeEscape(s: string): string {
  return s.replace(/([\\%_])/g, '\\$1')
}

type PostOwner = {
  kind: 'post'
  id: string
  tgKey: string
  mediaUrl: string | null
  gallery: string | null
  mediaMeta: string | null
  username: string
}
type ChannelOwner = { kind: 'channel'; id: string; username: string; avatarUrl: string | null }
type Owner = PostOwner | ChannelOwner | null

// Имена таблиц в кавычках: Prisma создаёт их регистрозависимыми в Postgres
const OWNER_SELECT = Prisma.sql`
  p.id, p."tgKey", p."mediaUrl", p.gallery, p."mediaMeta", c.username
`

/**
 * Кто в БД ссылается на этот URL? Точное совпадение mediaUrl/avatarUrl,
 * затем LIKE по началу пути (ротация токенов меняет только query) и по
 * gallery/mediaMeta (JSON-строки). Кросс-БД: LIKE ... ESCAPE '\' работает
 * и в SQLite, и в Postgres.
 */
async function findOwner(raw: string): Promise<Owner> {
  const identity = urlIdentity(raw)
  if (!identity) return null
  const path = raw.split('?')[0]
  const likePrefix = likeEscape(path) + '%'
  const likeInner = '%' + likeEscape(identity) + '%'

  // 1) пост: точное mediaUrl
  const exact = await db.post.findFirst({
    where: { mediaUrl: raw },
    select: { id: true, tgKey: true, mediaUrl: true, gallery: true, mediaMeta: true, channel: { select: { username: true } } },
  })
  if (exact) {
    return {
      kind: 'post',
      id: exact.id,
      tgKey: exact.tgKey,
      mediaUrl: exact.mediaUrl,
      gallery: exact.gallery,
      mediaMeta: exact.mediaMeta,
      username: exact.channel.username,
    }
  }

  // 2) канал: точное avatarUrl
  const ch = await db.channel.findFirst({
    where: { avatarUrl: raw },
    select: { id: true, username: true, avatarUrl: true },
  })
  if (ch) return { kind: 'channel', id: ch.id, username: ch.username, avatarUrl: ch.avatarUrl }

  // 3) пост: mediaUrl с ротированным query / внутри gallery / внутри mediaMeta
  try {
    const rows = await db.$queryRaw<
      Array<{ id: string; tgKey: string; mediaUrl: string | null; gallery: string | null; mediaMeta: string | null; username: string }>
    >(Prisma.sql`
      SELECT ${OWNER_SELECT}
      FROM "Post" p JOIN "Channel" c ON p."channelId" = c.id
      WHERE p."mediaUrl" LIKE ${likePrefix} ESCAPE '\\'
         OR p.gallery LIKE ${likeInner} ESCAPE '\\'
         OR p."mediaMeta" LIKE ${likeInner} ESCAPE '\\'
      ORDER BY p."publishedAt" DESC
      LIMIT 1
    `)
    const r = rows[0]
    if (r) return { kind: 'post', id: r.id, tgKey: r.tgKey, mediaUrl: r.mediaUrl, gallery: r.gallery, mediaMeta: r.mediaMeta, username: r.username }
  } catch {
    /* raw-запрос недоступен — лечим только точные совпадения */
  }

  // 4) канал: avatarUrl с ротированным query
  try {
    const rows = await db.$queryRaw<Array<{ id: string; username: string; avatarUrl: string | null }>>(Prisma.sql`
      SELECT c.id, c.username, c."avatarUrl"
      FROM "Channel" c
      WHERE c."avatarUrl" LIKE ${likePrefix} ESCAPE '\\'
      LIMIT 1
    `)
    const r = rows[0]
    if (r) return { kind: 'channel', id: r.id, username: r.username, avatarUrl: r.avatarUrl }
  } catch {
    /* см. выше */
  }

  return null
}

/** msgId из tgKey ("username/12345" или "username:12345" → 12345) */
function msgIdOf(tgKey: string): string | null {
  const parts = tgKey.split(/[:/]/)
  const tail = parts[parts.length - 1] ?? ''
  return /^\d+$/.test(tail) ? tail : null
}

/**
 * Свежие медиа поста: embed-страница t.me/<username>/<msgId>?embed=1&mode=tme.
 *
 * Нюанс разметки: embed использует контейнер `class="tgme_widget_message …
 * js-widget_message" data-post=…` БЕЗ суффикса _wrap (в отличие от t.me/s),
 * поэтому перед переиспользованием parseChannelHtml нормализуем класс —
 * остальной виджет-маркап (photo_wrap, <video>, реакции, просмотры) идентичен.
 */
async function scrapeFreshPost(username: string, tgKey: string): Promise<ParsedPost | null> {
  const msgId = msgIdOf(tgKey)
  if (!msgId || !username) return null
  const url = `https://t.me/${encodeURIComponent(username)}/${msgId}?embed=1&mode=tme`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return null
    const html = await res.text()
    const normalized = html.replace(/class="tgme_widget_message /g, 'class="tgme_widget_message_wrap ')
    const parsed = parseChannelHtml(normalized, username)
    // tgKey в БД хранится с ':' (parseChannelHtml: key.replace('/', ':')) —
    // сравниваем нормализованно и по хвосту msgId (соседние посты группы)
    const norm = (k: string) => k.replace(/\//g, ':')
    return parsed.find((p) => norm(p.tgKey) === norm(tgKey) || p.tgKey.endsWith(`:${msgId}`)) ?? null
  } catch {
    return null
  }
}

/**
 * Лечение мёртвого URL. Возвращает СВЕЖИЙ url для отдачи байтов
 * (для поста — соответствующий позицию в галерее; для канала — og:image).
 */
export async function healMediaUrl(raw: string): Promise<MediaHealResult> {
  if (!raw || negGet(raw)) return null
  const running = inflight.get(raw)
  if (running) return running

  const job = (async (): Promise<MediaHealResult> => {
    const owner = await findOwner(raw).catch(() => null)
    if (!owner) {
      negSet(raw)
      return null
    }

    if (owner.kind === 'channel') {
      // Аватарка канала: свежий og:image с лендинга t.me/<username>
      try {
        const res = await fetch(`https://t.me/${encodeURIComponent(owner.username)}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36' },
          signal: AbortSignal.timeout(8_000),
        })
        if (res.ok) {
          const fresh = ogAvatarOf(await res.text())
          if (fresh && fresh !== raw) {
            await syncChannelAvatarFromUrl(owner.id, fresh).catch(() => {})
            return { url: fresh, updated: 'channel' }
          }
        }
      } catch {
        /* t.me недоступен — негативный кэш ниже */
      }
      negSet(raw)
      return null
    }

    // Пост: свежий embed → новые URL → UPDATE БД
    const fresh = await scrapeFreshPost(owner.username, owner.tgKey)
    if (!fresh || (!fresh.media && fresh.gallery.length === 0)) {
      negSet(raw)
      return null
    }

    /*
     * Куда встать: сравниваем ПО ИДЕНТИЧНОСТИ (host+path, без query — токены
     * ротируются): мёртвый путь в старом primary/gallery/постере → тот же
     * слот в свежих данных. Не нашли слот — отдаём null (БД уже исправлена,
     * следующая выдача ленты будет со свежими ссылками).
     */
    const deadId = urlIdentity(raw)
    const idOf = (u?: string | null) => (u ? urlIdentity(u) : null)
    let freshUrl: string | null = null
    if (deadId && idOf(owner.mediaUrl) === deadId) freshUrl = fresh.media?.url ?? null
    if (!freshUrl && deadId) {
      try {
        const oldItems = owner.gallery ? (JSON.parse(owner.gallery) as Array<{ url?: string }>) : []
        const idx = oldItems.findIndex((g) => idOf(g.url) === deadId)
        if (idx >= 0 && fresh.gallery[idx]?.url) freshUrl = fresh.gallery[idx].url!
      } catch {
        /* позицию не нашли */
      }
    }
    if (!freshUrl && deadId && idOf(fresh.media?.poster) === deadId) freshUrl = fresh.media?.poster ?? null

    if (!freshUrl) {
      negSet(raw)
      return null
    }

    // БД — свежими данными (следующие выдачи ленты уже со здоровыми ссылками)
    const extras = fresh.media
      ? (({ url: _u, kind: _k, ...rest }) => (Object.keys(rest).length > 0 ? rest : null))(fresh.media)
      : null
    await db.post
      .update({
        where: { id: owner.id },
        data: {
          ...(fresh.media
            ? { mediaUrl: fresh.media.url ?? null, mediaType: fresh.media.kind, mediaMeta: extras ? JSON.stringify(extras) : null }
            : {}),
          ...(fresh.gallery.length > 0 ? { gallery: JSON.stringify(fresh.gallery) } : {}),
        },
      })
      .catch(() => {})

    return { url: freshUrl, updated: 'post' }
  })()

  inflight.set(raw, job)
  try {
    return await job
  } finally {
    inflight.delete(raw)
  }
}

/**
 * Прогрев edge-кэша свежевылеченного URL (парсер и хил зовут fire-and-forget).
 */
export function warmHealedMedia(url: string): void {
  const origin =
    process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, '') ||
    process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, '') ||
    'https://tg-swipe.vercel.app'
  void fetch(`${origin}/api/media?u=${encodeURIComponent(url)}`, {
    headers: { 'User-Agent': 'TgSwipeWarm/1.0' },
    signal: AbortSignal.timeout(12_000),
  }).catch(() => {})
}
