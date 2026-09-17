import { db } from '@/lib/db'
import { isValidChannelUsername } from '@/lib/server'
import { emitAppEvent, emitAdminEvent } from '@/lib/events'
import { bumpCache } from '@/lib/redis'
import { botEnabled, getChatPhotoFileId, getChatMemberCount } from '@/lib/tg-bot'
import type { NotifiablePost } from '@/lib/tg-bot'

/** TTL обновления аватарок и счётчиков подписчиков каналов (меняются редко — 7 дней) */
const AVATAR_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Движок парсинга Tg Swipe: забирает посты публичных каналов с веб-превью
 * t.me/s/<username> и складывает их в БД (дубликаты по unique tgKey пропускаются).
 *
 * Логика вынесена из src/app/api/parse/route.ts, чтобы её использовали два входа:
 *  - POST /api/parse     — служебный (cron-сервис mini-services/feed-cron, защита CRON_SECRET);
 *  - POST /api/panel/tools {action:"parse"} — ручной запуск из /admin (защита ADMIN_KEY).
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
    // Именованные и числовые сущности (&amp; — последним; &#33; → «!», &#x27; и т.п.)
    .replace(/&#(\d+);/g, (_, code) => safeFromCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeFromCode(parseInt(hex, 16)))
    .replace(/&amp;/g, '&')
}

/** Числовой код символа с защитой от управляющих/невалидных значений */
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

type ParsedPost = {
  tgKey: string
  text: string
  mediaUrl: string | null
  mediaType: 'image' | 'video'
  publishedAt: Date
}

/**
 * Парсер публичной веб-версии канала t.me/s/<username>.
 * Достаём текст, фото/видео и время публикации из HTML.
 */
export function parseChannelHtml(html: string, username: string): ParsedPost[] {
  const out: ParsedPost[] = []
  const blocks = html.split(/<div class="tgme_widget_message_wrap/)

  for (const block of blocks.slice(1)) {
    const keyMatch = block.match(/data-post="([^"]+)"/)
    if (!keyMatch) continue
    const rawKey = keyMatch[1] // "username/12345"
    const key = rawKey.includes('/') ? rawKey : `${username}/${rawKey}`

    const textMatch = block.match(
      /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/,
    )
    const text = textMatch ? stripTags(textMatch[1]) : ''

    // Видео (прямой src в теге video) приоритетнее фото
    const videoMatch = block.match(/<video[^>]*src="([^"]+)"/)
    const photoMatch = block.match(
      /tgme_widget_message_photo_wrap[^>]*style="background-image:\s*url\('([^']+)'/,
    )
    const mediaUrl = videoMatch ? videoMatch[1] : photoMatch ? photoMatch[1] : null
    const mediaType: 'image' | 'video' = videoMatch ? 'video' : 'image'

    const timeMatch = block.match(/<time[^>]*datetime="([^"]+)"/)
    const publishedAt = timeMatch ? new Date(timeMatch[1]) : new Date()
    if (isNaN(publishedAt.getTime())) continue

    if (!text && !mediaUrl) continue
    out.push({ tgKey: key.replace('/', ':'), text, mediaUrl, mediaType, publishedAt })
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
 */
export async function runParser(
  perChannel: number,
  singleUsername?: string,
  maxChannels = 20,
  deadlineMs = 0,
  pages = 1,
): Promise<ParseResult> {
  // Нормализация лимита: некорректное/нулевое значение → дефолт 5 (как в cron-режиме)
  const per =
    Number.isFinite(perChannel) && perChannel > 0 ? Math.min(50, Math.floor(perChannel)) : 5

  let targets: string[]
  if (singleUsername) {
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
       * Обновляем только при протухшем TTL (7 дней) — лишних вызовов Bot API нет,
       * сбои не ломают парсинг. Аватарка: file_id → /api/avatar/c_<id>.
       * Счётчик: реальное число подписчиков Telegram — показывается в ленте/поиске.
       */
      if (
        botEnabled() &&
        (!channel.photoFileId ||
          !channel.avatarFetchedAt ||
          Date.now() - channel.avatarFetchedAt.getTime() > AVATAR_TTL_MS ||
          channel.membersCount == null ||
          !channel.membersFetchedAt ||
          Date.now() - channel.membersFetchedAt.getTime() > AVATAR_TTL_MS)
      ) {
        const [fileId, members] = await Promise.all([
          !channel.photoFileId ||
          !channel.avatarFetchedAt ||
          Date.now() - channel.avatarFetchedAt.getTime() > AVATAR_TTL_MS
            ? getChatPhotoFileId(target)
            : Promise.resolve(null),
          channel.membersCount == null ||
          !channel.membersFetchedAt ||
          Date.now() - channel.membersFetchedAt.getTime() > AVATAR_TTL_MS
            ? getChatMemberCount(target)
            : Promise.resolve(null),
        ])
        await db.channel
          .update({
            where: { id: channel.id },
            data: {
              ...(fileId ? { photoFileId: fileId } : {}),
              ...(members != null ? { membersCount: members } : {}),
              avatarFetchedAt: new Date(),
              membersFetchedAt: new Date(),
            },
          })
          .catch(() => {})
      }
      // Новейшие первыми; дубли отклонит unique tgKey — вставляем, пока не доберём per
      const queue = [...parsed].sort(
        (a, b) => b.publishedAt.getTime() - a.publishedAt.getTime(),
      )

      let added = 0
      for (const p of queue) {
        if (added >= per) break
        try {
          const created = await db.post.create({
            data: {
              tgKey: p.tgKey,
              channelId: channel.id,
              text: p.text,
              mediaUrl: p.mediaUrl,
              mediaType: p.mediaType,
              link: `https://t.me/${p.tgKey.replace(':', '/')}`,
              publishedAt: p.publishedAt,
            },
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
          // дубликат (unique tgKey) — пропускаем
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
