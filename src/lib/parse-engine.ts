import { db } from '@/lib/db'
import { isValidChannelUsername } from '@/lib/server'
import { emitAppEvent, emitAdminEvent } from '@/lib/events'
import { bumpCache } from '@/lib/redis'
import { botEnabled, getChatPhotoFileId, getChatMemberCount } from '@/lib/tg-bot'
import type { NotifiablePost } from '@/lib/tg-bot'
import { htmlToMarkdownLite } from '@/lib/markdown'

/** TTL обновления аватарок и счётчиков подписчиков каналов (меняются редко — 7 дней) */
const AVATAR_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Движок парсинга Tg Swipe: забирает посты публичных каналов с веб-превью
 * t.me/s/<username> и складывает их в БД (дубликаты по unique tgKey пропускаются).
 *
 * Логика вынесена из src/app/api/parse/route.ts, чтобы её использовали два входа:
 *  - POST /api/parse     — служебный (cron-сервис mini-services/feed-cron, защита CRON_SECRET);
 *  - POST /api/panel/tools {action:"parse"} — ручной запуск из /admin (защита ADMIN_KEY).
 *
 * Посты сохраняются в markdown-lite (жирный/курсив/код/спойлеры/цитаты/ссылки),
 * поддерживаются все типы медиа веб-превью: фото-альбомы, видео, GIF, стикеры,
 * файлы, аудио/голосовые, опросы и превью ссылок. Просмотры берутся из
 * оригинального канала (счётчик под постом в t.me/s) и обновляются при ре-парсинге.
 */

/** Результат парсинга одного канала */
export type ParseChannelResult = {
  username: string
  added: number
  error?: string
}

/** Итог прогона парсера (по образцу прежнего ответа POST /api/parse) */
export type ParseResult = {
  ok: true
  results: ParseChannelResult[]
  /** реально созданные посты — для рассылки уведомлений (Bot API) */
  newPosts: NotifiablePost[]
  /** true — прогон оборван по тайм-бюджету: продолжите ещё раз (для серверлес-лимитов) */
  truncated?: boolean
  /** всего активных каналов в очереди прогона (для прогресса «N из M») */
  totalTargets?: number
}

// ------------------------------------------------------------------
// Медиа-модель поста
// ------------------------------------------------------------------

export type MediaKind =
  | 'image'
  | 'video'
  | 'gif'
  | 'sticker'
  | 'voice'
  | 'audio'
  | 'file'
  | 'poll'
  | 'link'

/** Элемент медиа-контента поста (основной или в галерее) */
export type MediaItem = {
  kind: MediaKind
  url?: string // прямая ссылка на медиа (фото/видео/гиф/стикер/аудио) или картинка-превью
  poster?: string // постер видео (только http-ссылки)
  name?: string // имя файла
  size?: string // «48.2 MB»
  spoiler?: boolean // медиа-спойлер (в Telegram заблюрено до тапа)
  title?: string // аудио/линк-превью
  performer?: string // исполнитель аудио
  question?: string // опрос
  answers?: string[] // варианты опроса
  site?: string // домен линк-превью
  description?: string // описание линк-превью
  link?: string // URL линк-превью
}

type ParsedPost = {
  tgKey: string
  text: string
  media: MediaItem | null // основное медиа
  gallery: MediaItem[] // дополнительные фото/медиа
  viewsTg: number | null
  publishedAt: Date
}

// ------------------------------------------------------------------
// Вспомогательные функции разметки t.me/s
// ------------------------------------------------------------------

/** Нормализация HTML-сущностей, встречающихся в разметке t.me/s */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&#(\d+);/g, (_, code) => safeFromCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeFromCode(parseInt(hex, 16)))
    .replace(/&amp;/g, '&')
}

function safeFromCode(code: number): string {
  if (!Number.isFinite(code) || code < 32 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim()
}

/**
 * Внутренний HTML элемента с балансировкой вложенных <div>.
 * Класс-стрелка возвращает null, если закрытие не найдено (битая разметка).
 */
function extractInnerBalanced(html: string, startIdx: number): string | null {
  const openTagEnd = html.indexOf('>', startIdx)
  if (openTagEnd === -1) return null
  let depth = 1
  const re = /<\/?div\b/g
  re.lastIndex = openTagEnd + 1
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    depth += m[0] === '</div' ? -1 : 1
    if (depth === 0) return html.slice(openTagEnd + 1, m.index)
  }
  return null
}

/** Значение CSS background-image: url('…') или url("…") из фрагмента (оба вида кавычек) */
export function bgImageOf(fragment: string): string | null {
  const m = fragment.match(/background-image:\s*url\((['"]?)([^)'"]+)\1\)/)
  return m ? decodeEntities(m[2].trim()) : null
}
/** «2.1K» / «1 234» / «1,2M» → число просмотров оригинального канала */
export function parseTgViews(raw: string): number | null {
  const s = raw.trim().replace(/\s|\u00a0/g, '')
  const m = s.match(/^([\d.,]+)([KkMm])?$/)
  if (!m) return null
  let num = Number(m[1].replace(',', '.'))
  if (!Number.isFinite(num)) return null
  const suffix = m[2]?.toLowerCase()
  if (suffix === 'k') num *= 1_000
  if (suffix === 'm') num *= 1_000_000
  return Math.round(num)
}

/**
 * Полный текст поста: тег <div class="tgme_widget_message_text …"> с
 * балансировкой вложенных div (старый регэксп обрезал текст на первом
 * вложенном </div>). Возвращается markdown-lite со всей разметкой.
 */
function extractText(block: string): string {
  const marker = block.search(/<div class="tgme_widget_message_text[\s"]/)
  if (marker === -1) return ''
  const inner = extractInnerBalanced(block, marker)
  if (!inner) return ''
  return htmlToMarkdownLite(inner)
}

/** URL рядом с вхождением маркера класса: url('…') или src="…" (для стикеров) */
function urlNear(block: string, marker: string, span = 500): string | null {
  for (const m of block.matchAll(new RegExp(marker, 'g'))) {
    const scope = block.slice(m.index ?? 0, (m.index ?? 0) + span)
    const url = bgImageOf(scope) ?? scope.match(/\ssrc="([^"]+)"/)?.[1]
    if (url) return decodeEntities(url)
  }
  return null
}

/** Медиа-спойлер: маркер tg-spoiler/message_spoiler рядом с медиа-элементом */
function spoilerNear(block: string, index: number, span = 420): boolean {
  const scope = block.slice(Math.max(0, index - 120), index + span)
  return /tg-spoiler|message_spoiler/.test(scope)
}

// ------------------------------------------------------------------
// Парсер HTML канала
// ------------------------------------------------------------------

/**
 * Парсер публичной веб-версии канала t.me/s/<username>.
 * Достаёт текст (markdown-lite), все типы медиа и просмотры из HTML.
 */
export function parseChannelHtml(html: string, username: string): ParsedPost[] {
  const out: ParsedPost[] = []
  const blocks = html.split(/<div class="tgme_widget_message_wrap/)

  for (const block of blocks.slice(1)) {
    const keyMatch = block.match(/data-post="([^"]+)"/)
    if (!keyMatch) continue
    const rawKey = keyMatch[1] // "username/12345"
    const key = rawKey.includes('/') ? rawKey : `${username}/${rawKey}`

    const text = extractText(block)
    const gallery: MediaItem[] = []
    let media: MediaItem | null = null

    /* ---------- Фото (возможно альбом: несколько photo_wrap в одном посте) ----------
        Атрибуты и кавычки в разметке t.me/s варьируются — ищем класс,
        затем url() в ближайших 600 символах (надёжнее одного регэкспа) */
    for (const m of block.matchAll(/tgme_widget_message_photo_wrap/g)) {
      const scope = block.slice(m.index ?? 0, (m.index ?? 0) + 600)
      const url = bgImageOf(scope)
      if (url)
        gallery.push({
          kind: 'image',
          url,
          ...(spoilerNear(block, m.index ?? 0) ? { spoiler: true } : {}),
        })
    }

    /* ---------- Видео / GIF (прямые <video src>) ---------- */
    for (const m of block.matchAll(/<video([^>]*)>/g)) {
      const attrs = m[1]
      const src = attrs.match(/\ssrc="([^"]+)"/)?.[1]
      if (!src) continue
      const isGif = /loop|autoplay/i.test(attrs)
      const poster = attrs.match(/\sposter="(https:[^"]+)"/)?.[1]
      gallery.push({
        kind: isGif ? 'gif' : 'video',
        url: decodeEntities(src),
        ...(poster ? { poster: decodeEntities(poster) } : {}),
        ...(spoilerNear(block, m.index ?? 0) ? { spoiler: true } : {}),
      })
    }

    /* ---------- Стикеры (webp/webm: bg-image или <img>, рядом с классом) ---------- */
    const stickerUrl = urlNear(block, 'tgme_widget_message_sticker')
    if (stickerUrl) gallery.push({ kind: 'sticker', url: stickerUrl })

    /* ---------- Файлы (документы: имя + размер) ---------- */
    for (const doc of block.matchAll(
      /<div class="tgme_widget_message_document_title[^"]*">([\s\S]*?)<\/div>\s*<div class="tgme_widget_message_document_extra[^"]*">([\s\S]*?)<\/div>/g,
    )) {
      gallery.push({ kind: 'file', name: stripTags(doc[1]), size: stripTags(doc[2]) })
    }

    /* ---------- Голосовые / аудио ---------- */
    const isVoice = block.includes('tgme_widget_message_voice')
    const audioTitle = block.match(/tgme_widget_message_audio_title[^>]*>([\s\S]*?)</)
    const audioSub = block.match(/tgme_widget_message_audio_subtitle[^>]*>([\s\S]*?)</)
    const audioSrc = block.match(/<audio[^>]*src="([^"]+)"/)?.[1]
    if (isVoice || audioTitle || audioSrc) {
      const item: MediaItem = {
        kind: isVoice ? 'voice' : 'audio',
        ...(audioSrc ? { url: decodeEntities(audioSrc) } : {}),
        ...(audioTitle ? { title: stripTags(audioTitle[1]) } : {}),
        ...(audioSub ? { performer: stripTags(audioSub[1]) } : {}),
      }
      gallery.push(item)
    }

    /* ---------- Опросы ---------- */
    const pollQ = block.match(/tgme_widget_message_poll_question[^>]*>([\s\S]*?)</)
    if (pollQ) {
      const answers = [...block.matchAll(/tgme_widget_message_poll_answer_text[^>]*>([\s\S]*?)</g)].map(
        (x) => stripTags(x[1]),
      )
      gallery.push({ kind: 'poll', question: stripTags(pollQ[1]), answers })
    }

    /* ---------- Превью ссылки ---------- */
    const linkM = block.match(
      /<a[^>]*class="[^"]*tgme_widget_message_link_preview[^"]*"[^>]*href="([^"]+)"/,
    )
    const linkM2 = linkM ?? block.match(/<a[^>]*href="([^"]+)"[^>]*class="[^"]*tgme_widget_message_link_preview/)
    if (linkM2) {
      const idx = block.indexOf(linkM2[0])
      const scope = block.slice(idx, idx + 4000)
      const title = scope.match(/tgme_widget_message_link_title[^>]*>([\s\S]*?)</)?.[1]
      const desc = scope.match(/tgme_widget_message_link_description[^>]*>([\s\S]*?)</)?.[1]
      const site = scope.match(/tgme_widget_message_link_site[^>]*>([\s\S]*?)</)?.[1]
      const image = bgImageOf(scope)
      gallery.push({
        kind: 'link',
        link: decodeEntities(linkM2[1]),
        ...(title ? { title: stripTags(title) } : {}),
        ...(desc ? { description: stripTags(desc) } : {}),
        ...(site ? { site: stripTags(site) } : {}),
        ...(image ? { url: image } : {}),
      })
    }

    /* ---------- Выбор основного медиа (приоритет видео > гиф > фото > …) ---------- */
    const priority: MediaKind[] = ['video', 'gif', 'image', 'sticker', 'voice', 'audio', 'file', 'poll', 'link']
    for (const kind of priority) {
      const idx = gallery.findIndex((x) => x.kind === kind && (x.url || x.name || x.question || x.link))
      if (idx !== -1) {
        media = gallery[idx]
        gallery.splice(idx, 1)
        break
      }
    }

    /* ---------- Просмотры оригинального канала ---------- */
    const viewsRaw = block.match(/tgme_widget_message_views[^>]*>([\s\S]*?)</)?.[1] ?? ''
    const viewsTg = parseTgViews(stripTags(viewsRaw))

    const timeMatch = block.match(/<time[^>]*datetime="([^"]+)"/)
    const publishedAt = timeMatch ? new Date(timeMatch[1]) : new Date()
    if (isNaN(publishedAt.getTime())) continue

    if (!text && !media && gallery.length === 0) continue
    out.push({ tgKey: key.replace('/', ':'), text, media, gallery, viewsTg, publishedAt })
  }

  return out
}

/**
 * Запуск парсера (вся логика прежнего POST /api/parse).
 *
 * @param perChannel — сколько НОВЫХ постов добавлять на канал за один прогон
 *   (1..50; некорректное значение → 5). Источник: https://t.me/s/<username>.
 * @param singleUsername — опционально: парсить один канал (@name / t.me/name / name)
 *   вместо активных каналов из базы.
 * @param maxChannels — сколько активных каналов обрабатывать за прогон
 *   (по умолчанию 20, как в cron-режиме; для крупного прогона — 500).
 * @param deadlineMs — мягкий тайм-бюджет всего прогона (0 = без бюджета):
 *   после дедлайна цикл останавливается, truncated=true — продолжите новым запуском.
 * @param pages — страниц истории на канал (1 = только свежие; 4 = углубление
 *   в архив через t.me/s?before=<id>). Крупные прогоны истории — pages=4.
 * @param only — явный список каналов (адаптивный шедулер): парсить только их,
 *   игнорируя maxChannels из базы.
 */
export async function runParser(
  perChannel: number,
  singleUsername?: string,
  maxChannels = 20,
  deadlineMs = 0,
  pages = 1,
  only?: string[],
): Promise<ParseResult> {
  // Нормализация лимита: некорректное/нулевое значение → дефолт 5 (как в cron-режиме)
  const per =
    Number.isFinite(perChannel) && perChannel > 0 ? Math.min(50, Math.floor(perChannel)) : 5

  let targets: string[]
  if (only && only.length > 0) {
    // адаптивный батч: только валидные имена (SSRF-защита)
    targets = only
      .map((u) => String(u).replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '').split('/')[0])
      .filter((u) => isValidChannelUsername(u))
      .slice(0, 50)
  } else if (singleUsername) {
    const norm = singleUsername
      .replace(/^@/, '')
      .replace(/^https?:\/\/t\.me\//, '')
      .split('/')[0]
    // SSRF-защита: в URL https://t.me/s/<username> попадают только [A-Za-z0-9_]
    if (!isValidChannelUsername(norm)) {
      const r = { username: singleUsername, added: 0, error: 'недопустимый username канала' }
      emitAdminEvent('parse:start', { total: 1 })
      emitAdminEvent('parse:progress', { current: 1, total: 1, username: r.username, title: r.username, added: 0, error: r.error })
      emitAdminEvent('parse:done', { newPosts: 0, ms: 0 })
      return { ok: true, results: [r], newPosts: [] }
    }
    targets = [norm]
  } else {
    const active = await db.channel.findMany({
      where: { status: 'active' },
      select: { username: true },
      take: Math.max(1, Math.min(500, Math.floor(maxChannels))),
    })
    targets = active.map((c) => c.username)
  }

  const results: ParseChannelResult[] = []
  const newPosts: NotifiablePost[] = []
  const startedAt = Date.now()
  emitAdminEvent('parse:start', { total: targets.length })

  const report = (r: ParseChannelResult, title: string, current: number) => {
    emitAdminEvent('parse:progress', {
      current,
      total: targets.length,
      username: r.username,
      title,
      added: r.added,
      ...(r.error ? { error: r.error } : {}),
    })
  }

  let processed = 0
  let truncated = false
  for (const target of targets) {
    // тайм-бюджет (серверлес-лимиты): дообработаем остальные каналы следующим прогоном
    if (deadlineMs > 0 && processed > 0 && Date.now() > deadlineMs) {
      truncated = true
      break
    }
    try {
      const channel = await db.channel.findUnique({ where: { username: target } })
      if (!channel) {
        processed++
        const r = { username: target, added: 0, error: 'канал не найден в базе' }
        results.push(r)
        report(r, target, processed)
        continue
      }

      if (!isValidChannelUsername(target)) {
        processed++
        const r = { username: target, added: 0, error: 'недопустимый username канала' }
        results.push(r)
        report(r, channel.title, processed)
        continue
      }

      const res = await fetch(`https://t.me/s/${target}`, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept-Language': 'ru,en;q=0.9',
        },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const html = await res.text()
      let parsed = parseChannelHtml(html, target)

      /* ---------- История канала: ?before=<id> пагинация ---------- */
      const maxPages = Math.max(1, Math.min(6, Math.floor(pages)))
      for (let page = 1; page < maxPages && parsed.length > 0; page++) {
        let minId: number | null = null
        for (const p of parsed) {
          const n = Number(p.tgKey.split(":")[1])
          if (Number.isFinite(n) && (minId === null || n < minId)) minId = n
        }
        if (minId === null || minId <= 1) break
        try {
          const res2 = await fetch(`https://t.me/s/${target}?before=${minId}`, {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
              "Accept-Language": "ru,en;q=0.9",
            },
            signal: AbortSignal.timeout(15000),
          })
          if (!res2.ok) break
          const parsed2 = parseChannelHtml(await res2.text(), target)
          if (parsed2.length === 0) break
          parsed = parsed.concat(parsed2)
        } catch {
          break
        }
      }

      /*
       * Аватарка и счётчик подписчиков: Bot API (getChat / getChatMemberCount).
       * Обновляем только при протухшем TTL (7 дней), а fetchedAt штампуем
       * ТОЛЬКО за реально полученные данные: сбой Bot API больше не «замораживает»
       * пустые аватарку/подписчиков на неделю — попытка повторится на следующем прогоне.
       */
      if (botEnabled()) {
        const needAvatar =
          !channel.photoFileId ||
          !channel.avatarFetchedAt ||
          Date.now() - channel.avatarFetchedAt.getTime() > AVATAR_TTL_MS
        const needMembers =
          channel.membersCount == null ||
          !channel.membersFetchedAt ||
          Date.now() - channel.membersFetchedAt.getTime() > AVATAR_TTL_MS
        if (needAvatar || needMembers) {
          const [fileId, members, landing] = await Promise.all([
            needAvatar ? getChatPhotoFileId(target) : Promise.resolve(null),
            needMembers ? getChatMemberCount(target) : Promise.resolve(null),
            // Анимированная аватарка: в лендинге t.me она приходит <video> вместо <img>
            needAvatar
              ? fetch(`https://t.me/${target}`, {
                  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0' },
                  signal: AbortSignal.timeout(10_000),
                })
                  .then((r) => (r.ok ? r.text() : ''))
                  .catch(() => '')
              : Promise.resolve(''),
          ])
          // Видео-аватарка: <video src="…mp4"> внутри блока tgme_page_photo (best-effort)
          let avatarVideoUrl: string | undefined
          if (landing) {
            const photoBlock = landing.slice(
              Math.max(0, landing.indexOf('tgme_page_photo') - 200),
              landing.indexOf('tgme_page_photo') + 1400,
            )
            const videoSrc = photoBlock.match(/<video[^>]*\ssrc="([^"]+\.(?:mp4|webm)[^"]*)"/)?.[1]
            if (videoSrc) avatarVideoUrl = decodeEntities(videoSrc)
          }
          await db.channel
            .update({
              where: { id: channel.id },
              data: {
                ...(fileId ? { photoFileId: fileId, avatarFetchedAt: new Date() } : {}),
                ...(members != null ? { membersCount: members, membersFetchedAt: new Date() } : {}),
                ...(avatarVideoUrl ? { avatarVideoUrl } : {}),
              },
            })
            .catch(() => {})
        }
      }

      // Новейшие первыми; дубли отклонит unique tgKey — вставляем, пока не доберём per
      const queue = [...parsed].sort(
        (a, b) => b.publishedAt.getTime() - a.publishedAt.getTime(),
      )

      // Просмотры/текст/медиа обновляются и у уже существующих постов:
      // один SELECT по ключам перед вставками → точечные UPDATE только где изменилось
      const existing = await db.post.findMany({
        where: { channelId: channel.id, tgKey: { in: queue.map((p) => p.tgKey) } },
        select: { tgKey: true, viewsTg: true, text: true, mediaUrl: true, mediaType: true, gallery: true },
      })
      const existingMap = new Map(existing.map((p) => [p.tgKey, p]))

      let added = 0
      for (const p of queue) {
        if (added >= per) break
        const primary = p.media
        // mediaMeta — доп. атрибуты основного медиа (файл/аудио/опрос/линк-превью);
        // gallery — остальные элементы (JSON MediaItem[])
        const extras = primary
          ? (({ url: _u, kind: _k, ...rest }) => (Object.keys(rest).length > 0 ? rest : null))(primary)
          : null
        const data = {
          tgKey: p.tgKey,
          channelId: channel.id,
          text: p.text,
          mediaUrl: primary?.url ?? null,
          mediaType: primary?.kind ?? 'none',
          mediaMeta: extras ? JSON.stringify(extras) : null,
          gallery: p.gallery.length > 0 ? JSON.stringify(p.gallery) : null,
          link: `https://t.me/${p.tgKey.replace(':', '/')}`,
          viewsTg: p.viewsTg,
          publishedAt: p.publishedAt,
        }

        // Дубликат заранее известен по карте существующих — сразу апдейт без
        // выброса исключения (тише и быстрее: Prisma не печатает стек ошибки)
        if (existingMap.has(p.tgKey)) {
          const old = existingMap.get(p.tgKey)
          const viewsChanged = p.viewsTg != null && old?.viewsTg !== p.viewsTg
          const textChanged = p.text.length > 0 && p.text !== old?.text // markdown-апгрейд/зачистка
          // Бэкфилл медиа: старый парсер часто не доставал фото/галереи
          const mediaChanged =
            !!old &&
            ((p.media?.url && !old.mediaUrl) ||
              (p.gallery.length > 0 && !old.gallery))
          if (viewsChanged || textChanged || mediaChanged) {
            await db.post
              .update({
                where: { tgKey: p.tgKey },
                data: {
                  ...(viewsChanged ? { viewsTg: p.viewsTg } : {}),
                  ...(textChanged ? { text: p.text } : {}),
                  ...(mediaChanged
                    ? {
                        mediaUrl: p.media?.url ?? null,
                        mediaType: p.media?.kind ?? 'none',
                        gallery: p.gallery.length > 0 ? JSON.stringify(p.gallery) : null,
                      }
                    : {}),
                },
              })
              .catch(() => {})
          }
          continue
        }

        try {
          const created = await db.post.create({
            data,
            select: { id: true, text: true, link: true },
          })
          added++
          newPosts.push({
            id: created.id,
            text: created.text,
            link: created.link,
            channel: { username: channel.username, title: channel.title },
          })
        } catch {
          // гонка с другим инстансом — дубликат, пропускаем
        }
      }
      results.push({ username: target, added })
      processed++
      report(results[results.length - 1], channel.title, processed)
    } catch (e) {
      processed++
      const r = { username: target, added: 0, error: String((e as Error)?.message ?? e) }
      results.push(r)
      report(r, target, processed)
    }
  }

  const result = { ok: true as const, results, newPosts, truncated, totalTargets: targets.length }
  emitAdminEvent('parse:done', { newPosts: newPosts.length, ms: Date.now() - startedAt })

  // Инвалидация кэша: лента/тренды/каталог/категории/поиск — новые посты
  if (newPosts.length > 0) await bumpCache(['feed', 'tr', 'ct', 'ch', 'sr'])

  // Живое событие для SSE-подписчиков (/api/events): пилюля «N новых» и
  // бейдж уведомлений обновятся без ожидания ближайшего поллинга
  if (newPosts.length > 0) {
    emitAppEvent('posts:new', {
      total: newPosts.length,
      usernames: [...new Set(newPosts.map((p) => p.channel.username))],
    })
  }

  return result
}
