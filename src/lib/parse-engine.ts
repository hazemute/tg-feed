import { db } from '@/lib/db'
import { isValidChannelUsername } from '@/lib/server'
import { emitAppEvent, emitAdminEvent } from '@/lib/events'
import { bumpCache } from '@/lib/redis'
import { warmFeedIndexes } from '@/lib/feed-warm'
import { botEnabled, getChatPhotoFileId, getChatMemberCount, getCustomEmojiStickers } from '@/lib/tg-bot'
import { clearAnimatedEmojiKindsCache } from '@/lib/emoji-registry'
import { syncChannelAvatar } from '@/lib/avatar-store'
import { isAdCliche } from '@/lib/moderation'
import { cleanPostText } from '@/lib/text-clean'
import { PRO_INITIAL_BOOST, effectiveTier, tierAtLeast } from '@/lib/tiers'
import type { NotifiablePost } from '@/lib/tg-bot'
import { htmlToMarkdownLite } from '@/lib/markdown'

/** TTL обновления аватарок и счётчиков подписчиков каналов (меняются редко — 7 дней) */
const AVATAR_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** TTL web-аватарки (og:image → Storage): бесплатно, можно освежать чаще — раз в сутки */
const AVATAR_WEB_TTL_MS = 24 * 60 * 60 * 1000

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
  /** рекламных клише-постов пропущено (не создано) */
  adSkipped?: number
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

export type ParsedPost = {
  tgKey: string
  text: string
  media: MediaItem | null // основное медиа
  gallery: MediaItem[] // дополнительные фото/медиа
  viewsTg: number | null
  reactionsTg: number // сумма всех реакций исходного поста
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
// Прогрев edge-кэша медиа (v5.58)
// ------------------------------------------------------------------

/*
 * Telegram троттлит датацентровые IP Vercel: холодный фетч файла через
 * /api/media висел 13-15с. Edge-кэш (Vercel-CDN-Cache-Control) лечит
 * повторные запросы, но ПЕРВЫЙ запрос каждого файла всё ещё медленный.
 * Решение: парсер после вставки постов канала сам прогревает прокси
 * свежими медиа/аватаркой — юзеры почти никогда не встречают холодный
 * промах (тик проходит раз в сутки, до утреннего трафика).
 */
const MEDIA_ORIGIN =
  process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, '') ||
  process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, '') ||
  'https://tg-swipe.vercel.app'

function warmMediaEdge(urls: string[]): void {
  const uniq = [...new Set(urls)]
    .filter((u) => /^https:\/\/(cdn\d+\.telesco\.pe|[\w.-]*telegram\.org)\//.test(u))
    .slice(0, 10)
  if (uniq.length === 0) return
  void (async () => {
    await Promise.all(
      uniq.map(async (u) => {
        try {
          await fetch(`${MEDIA_ORIGIN}/api/media?u=${encodeURIComponent(u)}`, {
            headers: { 'User-Agent': 'TgSwipeWarm/1.0' },
            signal: AbortSignal.timeout(12_000),
          })
        } catch {
          /* прогрев не критичен — edge соберётся первым юзером */
        }
      }),
    )
  })()
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

    /* ---------- Реакции исходного поста: сумма всех перечисленных видов ----------
        <span class="tgme_reaction"><i class="emoji">❤</i>85</span> — счётчик идёт
        после эмодзи; бывают краткие «1.2K» — парсим тем же parseTgViews */
    const reactionsRaw = block.match(/tgme_widget_message_reactions[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? ''
    let reactionsTg = 0
    if (reactionsRaw) {
      for (const r of reactionsRaw.matchAll(/<span class="tgme_reaction[^"]*">([\s\S]*?)<\/span>/g)) {
        const tail = stripTags(r[1]).replace(/^[^\d]*/, '')
        const n = parseTgViews(tail)
        if (n != null && n > 0) reactionsTg += n
      }
    }

    const timeMatch = block.match(/<time[^>]*datetime="([^"]+)"/)
    const publishedAt = timeMatch ? new Date(timeMatch[1]) : new Date()
    if (isNaN(publishedAt.getTime())) continue

    if (!text && !media && gallery.length === 0) continue
    out.push({ tgKey: key.replace('/', ':'), text, media, gallery, viewsTg, reactionsTg, publishedAt })
  }

  return out
}

/**
 * Премиум-эмодзи: посты несут маркеры ![e:ID](thumb). Резолвим Bot API, какие
 * ID — анимированные (кэш в таблице CustomEmoji навсегда) и переписываем
 * маркеры: видео-стикеры → ![ev:ID](…), Lottie (.tgs) → ![el:ID](…) — клиент
 * рендерит <video> / lottie-web. Первый проход по каналу: 1
 * getCustomEmojiStickers на НОВЫЕ id; дальше всё из таблицы — ноль Bot API.
 */
async function upgradeCustomEmoji(posts: ParsedPost[]): Promise<ParsedPost[]> {
  if (!botEnabled()) return posts
  const ids = new Set<string>()
  for (const p of posts) {
    for (const m of p.text.matchAll(/!\[e:(\d+)\]\(/g)) ids.add(m[1])
  }
  if (ids.size === 0) return posts
  try {
    const known = await db.customEmoji.findMany({ where: { id: { in: [...ids] } } })
    const knownMap = new Map(known.map((r) => [r.id, r]))
    // Перепроверке подлежат не только неизвестные ID: «статика» со старым
    // fetchedAt могла быть записана ошибочно (сбой Bot API в прошлом прогоне)
    // и без TTL навсегда оставалась картинкой вместо видео/Lottie.
    const STALE_STATIC_MS = 14 * 24 * 60 * 60 * 1000
    const missing = [...ids].filter((id) => {
      const r = knownMap.get(id)
      return !r || (r.kind === 'static' && Date.now() - r.fetchedAt.getTime() > STALE_STATIC_MS)
    })
    if (missing.length > 0) {
      const stickers = await getCustomEmojiStickers(missing)
      for (const id of missing) {
        const s = stickers.get(id)
        const row = {
          id,
          kind: s?.video ? 'video' : s?.animated ? 'lottie' : 'static',
          animated: s?.animated === true,
          fileId: (s?.video || s?.animated) && s.fileId ? s.fileId : null,
        }
        await db.customEmoji
          .upsert({
            where: { id: row.id },
            create: row,
            update: { kind: row.kind, animated: row.animated, fileId: row.fileId },
          })
          .catch(() => {})
        knownMap.set(id, { ...row, fetchedAt: new Date() })
      }
    }
    const animated = new Map(
      [...knownMap.values()]
        .filter((r) => (r.kind === 'video' || r.kind === 'lottie') && r.fileId)
        .map((r) => [r.id, r.kind] as const),
    )
    if (animated.size === 0) return posts
    for (const p of posts) {
      if (!p.text.includes('![e:')) continue
      p.text = p.text.replace(/!\[e:(\d+)\]\(/g, (full, id: string) => {
        const k = animated.get(id)
        if (k === 'video') return `![ev:${id}](`
        if (k === 'lottie') return `![el:${id}](`
        return full
      })
    }
  } catch {
    // резолвер не должен ронять парсинг — эмодзи остаются статичными
  }
  return posts
}

/**
 * РЕТРОАКТИВНЫЙ бэкфилл реестра CustomEmoji (v5.26 — приказ владельца
 * «все премиум-эмодзи отображаются с анимациями»).
 *
 * ГЭП, который закрывает: ID премиум-эмодзи попадают в реестр только при
 * парсинге канала, который этот эмодзи использует. Пост старого парсинга
 * (или пост канала, который ещё не перепарсивался) с маркером ![e:ID] —
 * ID в реестре ОТСУТСТВУЕТ → /api/emoji/[id] отвечает 404 → эмодзи навсегда
 * статичный, хотя Bot API знает анимацию.
 *
 * ЧТО ДЕЛАЕТ: сканирует свежие посты (по умолчанию 600) с маркерами,
 * находит ID без строки в CustomEmoji и резолвит их пачками
 * getCustomEmojiStickers (до 200 ID за вызов) — video/lottie получает fileId,
 * статика фиксируется с fetchedAt (не дёргаем Bot API повторно).
 * Вызывается из /api/parse/tick с троттлингом; идемпотентен.
 */
export async function backfillCustomEmoji(opts?: { scan?: number }): Promise<{ scanned: number; added: number }> {
  if (!botEnabled()) return { scanned: 0, added: 0 }
  const scan = Math.max(50, Math.min(2000, opts?.scan ?? 600))

  const posts = await db.post.findMany({
    where: { text: { contains: '![e:' } },
    orderBy: { publishedAt: 'desc' },
    take: scan,
    select: { text: true },
  })
  const ids = new Set<string>()
  for (const p of posts) {
    // Канонический текст в БД хранит ![e:ID]; ev/el-варианты на всякий случай тоже
    for (const m of p.text.matchAll(/!\[e(?:v|l)?:(\d+)\]\(/g)) ids.add(m[1])
  }
  if (ids.size === 0) return { scanned: posts.length, added: 0 }

  const known = await db.customEmoji.findMany({ where: { id: { in: [...ids] } }, select: { id: true } })
  const knownSet = new Set(known.map((r) => r.id))
  const missing = [...ids].filter((id) => !knownSet.has(id))
  if (missing.length === 0) return { scanned: posts.length, added: 0 }

  let added = 0
  for (let i = 0; i < missing.length; i += 200) {
    const chunk = missing.slice(i, i + 200)
    const stickers = await getCustomEmojiStickers(chunk)
    for (const id of chunk) {
      const s = stickers.get(id)
      const row = {
        id,
        kind: (s?.video ? 'video' : s?.animated ? 'lottie' : 'static') as 'video' | 'lottie' | 'static',
        animated: s?.animated === true,
        fileId: (s?.video || s?.animated) && s?.fileId ? s.fileId : null,
      }
      await db.customEmoji
        .upsert({ where: { id: row.id }, create: row, update: { kind: row.kind, animated: row.animated, fileId: row.fileId } })
        .catch(() => {})
      added++
    }
  }
  if (added > 0) clearAnimatedEmojiKindsCache() // dto сразу отдаёт ![ev:]/![el:]
  return { scanned: posts.length, added }
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
    // адаптивный батч: только валидные имена (SSRF-защита); username — строго lowercase
    targets = only
      .map((u) => String(u).replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '').split('/')[0].toLowerCase())
      .filter((u) => isValidChannelUsername(u))
      .slice(0, 50)
  } else if (singleUsername) {
    const norm = singleUsername
      .replace(/^@/, '')
      .replace(/^https?:\/\/t\.me\//, '')
      .split('/')[0]
      .toLowerCase()
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

  /*
   * Обработка одного канала целиком: сетевой фетч t.me/s (доминирует по времени),
   * аватарка/подписчики (Bot API) и фаза записи в БД. Вынесена из
   * последовательного цикла для параллельного пула ниже.
   */
  const parseOneChannel = async (target: string): Promise<void> => {
    try {
      const channel = await db.channel.findUnique({
        where: { username: target },
        include: { claimedBy: { select: { tier: true, tierUntil: true } } },
      })
      if (!channel) {
        processed++
        const r = { username: target, added: 0, error: 'канал не найден в базе' }
        results.push(r)
        report(r, target, processed)
        return
      }

      if (!isValidChannelUsername(target)) {
        processed++
        const r = { username: target, added: 0, error: 'недопустимый username канала' }
        results.push(r)
        report(r, channel.title, processed)
        return
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
      // Премиум-эмодзи: помечаем анимированные видео-стикеры (Bot API, кэш в БД)
      parsed = await upgradeCustomEmoji(parsed)

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
       * Аватарка: БЕСПЛАТНО из уже скачанного HTML (og:image → Supabase Storage,
       * TTL 24ч — картинка канала меняется редко, sha1 не даёт лишних аплоадов).
       * Bot API остаётся ФОЛБЭКОМ: если web-аватарки нет/протухла и photoFileId
       * пуст — тогда getChat (с учётом адаптивного ramp против флуд-банов).
       * Подписчики — по-прежнему Bot API (getChatMemberCount), TTL 7 дней.
       */
      const webAvatar = syncChannelAvatar(channel.id, html).catch(() => null)
      if (botEnabled()) {
        const needMembers =
          channel.membersCount == null ||
          !channel.membersFetchedAt ||
          Date.now() - channel.membersFetchedAt.getTime() > AVATAR_TTL_MS
        const webAvatarFresh =
          !!channel.avatarUrl &&
          !!channel.avatarFetchedAt &&
          Date.now() - channel.avatarFetchedAt.getTime() < AVATAR_WEB_TTL_MS
        const needBotAvatar =
          !webAvatarFresh &&
          (!channel.photoFileId ||
            !channel.avatarFetchedAt ||
            Date.now() - channel.avatarFetchedAt.getTime() > AVATAR_TTL_MS)
        if (needMembers || needBotAvatar) {
          const [fileId, members, landing] = await Promise.all([
            needBotAvatar ? getChatPhotoFileId(target) : Promise.resolve(null),
            needMembers ? getChatMemberCount(target) : Promise.resolve(null),
            // Анимированная аватарка: в лендинге t.me она приходит <video> вместо <img>
            needBotAvatar
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
      // web-аватарка догоняет параллельно с фазой записи постов — не тормозит тик
      void webAvatar

      // Новейшие первыми; дубли отклонит unique tgKey — вставляем, пока не доберём per
      const queue = [...parsed].sort(
        (a, b) => b.publishedAt.getTime() - a.publishedAt.getTime(),
      )

      // Просмотры/текст/медиа обновляются и у уже существующих постов:
      // один SELECT по ключам перед вставками → точечные UPDATE только где изменилось
      const existing = await db.post.findMany({
        where: { channelId: channel.id, tgKey: { in: queue.map((p) => p.tgKey) } },
        select: { tgKey: true, viewsTg: true, reactionsTg: true, text: true, mediaUrl: true, mediaType: true, gallery: true },
      })
      const existingMap = new Map(existing.map((p) => [p.tgKey, p]))

      let added = 0
      let adSkipped = 0 // рекламные клише пропущены (в ленту не попали)
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
          // v5.15: полная зачистка мусора (невидимые символы, хэштег-простыни,
          // повторные строки, utm-хвосты, канальные призывы-хвосты)
          text: cleanPostText(p.text),
          mediaUrl: primary?.url ?? null,
          mediaType: primary?.kind ?? 'none',
          mediaMeta: extras ? JSON.stringify(extras) : null,
          gallery: p.gallery.length > 0 ? JSON.stringify(p.gallery) : null,
          link: `https://t.me/${p.tgKey.replace(':', '/')}`,
          viewsTg: p.viewsTg,
          reactionsTg: p.reactionsTg,
          publishedAt: p.publishedAt,
          // Snap Pro (v5.17): посты Pro-авторов получают стартовый буст
          // температуры — при прочих равных выходят выше в общей ленте
          hotScore: tierAtLeast(effectiveTier(channel.claimedBy ?? null), 'pro')
            ? PRO_INITIAL_BOOST
            : 0,
        }

        // Дубликат заранее известен по карте существующих — сразу апдейт без
        // выброса исключения (тише и быстрее: Prisma не печатает стек ошибки)
        if (existingMap.has(p.tgKey)) {
          const old = existingMap.get(p.tgKey)
          const viewsChanged = p.viewsTg != null && old?.viewsTg !== p.viewsTg
          const reactionsChanged = p.reactionsTg > 0 && old?.reactionsTg !== p.reactionsTg
          const textChanged =
            p.text.length > 0 && cleanPostText(p.text) !== old?.text // markdown-апгрейд/зачистка
          /*
           * v5.59 — САМОЛЕЧЕНИЕ ПРОТУХШИХ ССЫЛОК: telesco.pe-ссылки Telegram
           * ротирует (замер прода: 100% трендовых медиа 404 через дни).
           * Свежий скрап всегда с новыми ссылками — если primary/gallery URL
           * ОТЛИЧАЮТСЯ от сохранённых, обновляем (раньше обновлялись только
           * пустые медиа — старые посты умирали навсегда).
           */
          const oldGalleryUrls = (() => {
            try {
              return (JSON.parse(old?.gallery ?? '[]') as Array<{ url?: string }>)
                .map((g) => g.url ?? '')
                .join('|')
            } catch {
              return ''
            }
          })()
          const freshGalleryUrls = p.gallery.map((g) => g.url ?? '').join('|')
          const mediaChanged =
            !!old &&
            ((p.media?.url && !old.mediaUrl) ||
              (p.gallery.length > 0 && !old.gallery) ||
              (!!p.media?.url && !!old.mediaUrl && old.mediaUrl !== p.media.url) ||
              (freshGalleryUrls !== '' && !!old.gallery && oldGalleryUrls !== freshGalleryUrls))
          if (viewsChanged || reactionsChanged || textChanged || mediaChanged) {
            await db.post
              .update({
                where: { tgKey: p.tgKey },
                data: {
                  ...(viewsChanged ? { viewsTg: p.viewsTg } : {}),
                  ...(reactionsChanged ? { reactionsTg: p.reactionsTg } : {}),
                  ...(textChanged ? { text: cleanPostText(p.text) } : {}),
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
          // Рекламные клише/кликбейт («читать продолжение в источнике», «смотри
          // закреп», erid-маркеры, промо-боты) в ленту не попадают: пост не
          // создаётся вовсе. Обновления просмотров дубликатов это не трогает —
          // проверка стоит только на пути СОЗДАНИЯ.
          if (isAdCliche(p.text)) {
            adSkipped++
            continue
          }
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
      // v5.58: прогрев edge-кэша — аватарка (og:image из этого же HTML) +
      // медиа вставленных постов (до 10 URL на канал за тик)
      const ogAvatar = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["'](https:[^"']+)["']/)?.[1]
      const warmUrls: string[] = ogAvatar ? [ogAvatar] : []
      for (const p of queue.slice(0, added)) {
        if (p.media?.url) warmUrls.push(p.media.url)
        for (const g of p.gallery) if (g.url) warmUrls.push(g.url)
        if (warmUrls.length >= 10) break
      }
      void warmMediaEdge(warmUrls)

      results.push({ username: target, added, adSkipped })
      processed++
      report(results[results.length - 1], channel.title, processed)
    } catch (e) {
      processed++
      const r = { username: target, added: 0, error: String((e as Error)?.message ?? e) }
      results.push(r)
      report(r, target, processed)
    }
  }

  /*
   * Пул параллельности: основной расход времени — сетевые фетчи t.me и Bot API
   * (по 1–3с на канал, последовательный тик из 8 каналов ≈ 65с). Параллелим
   * по 3 канала: фазы БД внутри каждого канала последовательны и коротки,
   * поэтому очереди пула Supabase (connection_limit=1) успевают — P2024 нет.
   */
  const CONCURRENCY = 3
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor
      if (i >= targets.length) return
      // тайм-бюджет (серверлес-лимиты): дообработаем остальные каналы следующим прогоном
      if (deadlineMs > 0 && processed > 0 && Date.now() > deadlineMs) {
        truncated = true
        return
      }
      cursor++
      await parseOneChannel(targets[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker()))

  /*
   * v5.59 — ХИЛ-ПРОХОД: проба свежих постов ЧЕРЕЗ ПРОКСИ /api/media.
   * Мёртвый URL прокси сам лечит (владеелец → embed → свежие байты → БД,
   * см. lib/media-heal.ts) — проба одновременно и проверка, и лечение,
   * и прогрев edge-кэша. Ограничено новейшими постами (их видят первыми).
   * Fire-and-forget: тик парсера не ждёт.
   */
  void (async () => {
    try {
      const probe = await db.post.findMany({
        where: { mediaUrl: { contains: 'telesco.pe' } },
        select: { mediaUrl: true },
        orderBy: { publishedAt: 'desc' },
        take: 14,
      })
      await Promise.all(
        probe.map(async ({ mediaUrl }) => {
          if (!mediaUrl) return
          try {
            const res = await fetch(`${MEDIA_ORIGIN}/api/media?u=${encodeURIComponent(mediaUrl)}`, {
              headers: { 'User-Agent': 'TgSwipeHeal/1.0' },
              signal: AbortSignal.timeout(25_000),
            })
            if (!res.ok) await res.body?.cancel().catch(() => {})
          } catch {
            /* healed или нет — следующий тик повторит */
          }
        }),
      )
    } catch {
      /* хил-проход не влияет на результат тика */
    }
  })()

  const result = { ok: true as const, results, newPosts, truncated, totalTargets: targets.length }
  emitAdminEvent('parse:done', { newPosts: newPosts.length, ms: Date.now() - startedAt })

  // Инвалидация кэша: лента/тренды/каталог/категории/поиск — новые посты.
  // Сразу после инвалидации ПРОГРЕВАЕМ глобальные индексы ленты (feed-warm):
  // новая версия ключей становится тёплой ДО первых пользовательских запросов —
  // бёрст после выхода новых постов не пересобирает индекс из БД.
  if (newPosts.length > 0) {
    await bumpCache(['feed', 'tr', 'ct', 'ch', 'sr'])
    try {
      await warmFeedIndexes()
    } catch {
      /* прогрев не влияет на результат тика */
    }
  }

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
