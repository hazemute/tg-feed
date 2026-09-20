import { db } from '@/lib/db'
import { bumpCache } from '@/lib/redis'
import { bgImageOf } from '@/lib/parse-engine'
import { getChatCard, botEnabled, botBanned, fetchLiveMembers } from '@/lib/tg-bot'
import { IS_SQLITE } from '@/lib/server'

/**
 * Адаптивный шедулер парсинга — постоянное отслеживание новых постов
 * с минимальным расходом ресурсов.
 *
 * Принцип: каждый тик обрабатывает маленькую РОТАЦИОННУЮ партию каналов
 * (по умолчанию 6), а не все сразу. Указатель ротации хранится в БД
 * (SystemSetting, одна строка) — переживает рестарты и не тратит Redis.
 * Приоритет: каналы со свежими постами (активные за 24ч) получают
 * дополнительные слоты — горячие каналы опрашиваются чаще без лишней нагрузки.
 * Заодно тик доливает медиу постам, которые старый парсер не дотащил
 * (бэкфилл через одиночную страницу t.me/<user>/<id>?embed=1).
 */

const POINTER_KEY = 'parse:pointer'
const BATCH_SIZE = 8
const HOT_SLOTS = 3 // слоты для горячих каналов поверх ротации
const ENRICH_PER_TICK = 2

/** Следующая партия каналов: ротация по всем активным + горячие слоты */
export async function nextAdaptiveBatch(): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<Array<{ username: string; last_post: Date | null }>>(
    `SELECT c."username", MAX(p."publishedAt") AS last_post
       FROM "Channel" c
       LEFT JOIN "Post" p ON p."channelId" = c."id"
      WHERE c."status" = 'active'
      GROUP BY c."username"`,
  )
  if (rows.length === 0) return []

  const usernames = rows.map((r) => r.username)
  const lastPost = new Map(rows.map((r) => [r.username, r.last_post]))

  // указатель ротации (SystemSetting — одна дешёвая строка, не Redis)
  const ptr = await db.systemSetting.findUnique({ where: { key: POINTER_KEY } })
  const start = ptr ? Number(ptr.value) || 0 : 0
  const batch: string[] = []
  for (let i = 0; i < Math.min(BATCH_SIZE, usernames.length); i++) {
    batch.push(usernames[(start + i) % usernames.length])
  }
  const nextPointer = (start + BATCH_SIZE) % Math.max(1, usernames.length)
  await db.systemSetting
    .upsert({
      where: { key: POINTER_KEY },
      create: { key: POINTER_KEY, value: String(nextPointer) },
      update: { value: String(nextPointer) },
    })
    .catch(() => {})

  // Горячие слоты: свежие посты (<24ч) вне текущей партии — их опрашиваем чаще
  const inBatch = new Set(batch)
  const hot = [...lastPost.entries()]
    .filter(([u, t]) => !inBatch.has(u) && t && Date.now() - t.getTime() < 24 * 3600_000)
    .sort((a, b) => (b[1]?.getTime() ?? 0) - (a[1]?.getTime() ?? 0))
    .slice(0, HOT_SLOTS)
    .map(([u]) => u)

  return [...batch, ...hot]
}

export type EnrichResult = { enriched: number }

/** Бэкфилл: посты без медиа → одиночная embed-страница → фото/видео */
export async function enrichMissingMedia(limit = ENRICH_PER_TICK): Promise<EnrichResult> {
  const candidates = await db.post.findMany({
    where: {
      embedTried: false,
      mediaUrl: null,
      mediaType: 'none',
      publishedAt: { gte: new Date(Date.now() - 14 * 24 * 3600_000) },
      channel: { status: 'active' },
    },
    select: { id: true, tgKey: true },
    orderBy: { publishedAt: 'desc' },
    take: limit,
  })
  let enriched = 0

  for (const post of candidates) {
    const [username, msgId] = post.tgKey.split(':')
    if (!username || !msgId) continue
    // помечаем сразу — повтор не зависит от успеха
    await db.post.update({ where: { id: post.id }, data: { embedTried: true } }).catch(() => {})
    try {
      const res = await fetch(`https://t.me/${username}/${msgId}?embed=1&mode=tme`, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) continue
      const html = await res.text()

      // фото: tgme_widget_message_photo_wrap → url(...) в ближайших 600 символах
      let url: string | null = null
      let kind: 'image' | 'video' = 'image'
      const videoSrc = html.match(/<video[^>]*>\s*<source[^>]*src="([^"]+)"/)?.[1]
        ?? html.match(/<video[^>]*src="([^"]+)"/)?.[1]
      if (videoSrc) {
        url = videoSrc
        kind = 'video'
      } else {
        const wrap = html.search(/tgme_widget_message_photo_wrap/)
        if (wrap !== -1) url = bgImageOf(html.slice(wrap, wrap + 600))
      }
      if (!url) continue

      await db.post
        .update({
          where: { id: post.id },
          data: { mediaUrl: url, mediaType: kind },
        })
        .catch(() => {})
      enriched++
    } catch {
      // сеть/таймаут — попробуем на следующем тике другие посты
    }
  }

  if (enriched > 0) await bumpCache(['feed', 'ch'])
  return { enriched }
}

// ------------------------- Карточки каналов (аватар + подписчики) -------------------------

export type CardsResult = { refreshed: number; scanned: number }

/**
 * Обновление карточек каналов ТОЛЬКО через Bot API (getChat-семейство, без t.me):
 * аватарка (file_id) и реальное число подписчиков. Приоритет — каналы вовсе без
 * аватара/счётчика, затем самые «протухшие» (TTL 7 дней). Каждый тик дергает
 * небольшую партию — 588 каналов выравниваются за ~40-50 тиков без нагрузки.
 * fetchedAt штампуем всегда: канал без аватара (удалён/запрещён) не будет
 * долбиться каждый тик, повтор — после TTL.
 */
/*
 * АДАПТИВНЫЙ ОБЪЁМ ПАРТИИ КАРТОЧЕК: после флуд-бана резкий burst (10+ каналов
 * × 2 вызова) мгновенно возвращает бан — наказание становится вечным. Теперь
 * партия стартует с 2 каналов и растёт на +2 за каждый тик без 429 (кап 12);
 * любой 429 сбрасывает к 2. Так бэкфилл сам «находит» комфортный темп.
 */
let cardRamp = 2

/** Текущий рекомендованный размер партии карточек (растёт после спокойных тиков) */
export function cardBatchSize(): number {
  return cardRamp
}

export async function refreshChannelCards(explicitLimit?: number): Promise<CardsResult> {
  // ЗАЩИТА ОТ BURST: любой явный limit (в т.ч. ручной /api/parse/avatars?limit=200)
  // обрезается адаптивным бюджетом cardRamp — именно ручные бэкфиллы дважды
  // ловили флуд-бан на 3-4 часа. Хочешь быстрее — жди роста cardRamp.
  const limit = Math.min(Math.max(explicitLimit ?? cardRamp, 1), Math.max(cardRamp, 1))
  let rows: Array<{ id: string; username: string }> = []
  try {
    if (IS_SQLITE) {
      // SQLite: нет interval/NULLS FIRST/$1 — эквивалентная выборка Prisma
      const cutoff = new Date(Date.now() - 7 * 86_400_000)
      rows = await db.channel.findMany({
        where: {
          status: 'active',
          OR: [
            { photoFileId: null },
            { membersCount: null },
            { avatarFetchedAt: null },
            { membersFetchedAt: null },
            { avatarFetchedAt: { lt: cutoff } },
            { membersFetchedAt: { lt: cutoff } },
          ],
        },
        orderBy: { subscribersCount: 'desc' },
        select: { id: true, username: true },
        take: limit,
      })
    } else {
      rows = await db.$queryRawUnsafe<Array<{ id: string; username: string }>>(
        `SELECT c."id", c."username" FROM "Channel" c
          WHERE c."status" = 'active'
            AND ( c."photoFileId" IS NULL OR c."membersCount" IS NULL
                  OR c."avatarFetchedAt" IS NULL OR c."membersFetchedAt" IS NULL
                  OR c."avatarFetchedAt" < now() - interval '7 days'
                  OR c."membersFetchedAt" < now() - interval '7 days' )
          ORDER BY c."avatarFetchedAt" NULLS FIRST, c."membersFetchedAt" NULLS FIRST,
                   c."subscribersCount" DESC
          LIMIT $1`,
        limit,
      )
    }
  } catch {
    return { refreshed: 0, scanned: 0 }
  }

  // Конкурентная обработка: 3 воркера × (getChat + getChatMemberCount + UPDATE).
  // 6 воркеров давали burst до 12 вызовов/сек — Telegram банил за частые getChat.
  // Правило флуд-безопасности: Bot API ответил 429 → ГЛОБАЛЬНАЯ пауза Bot API
  // (см. tg-bot markBotBan), оставшиеся каналы НЕ штампуются (иначе они выпадут
  // из обновления на срок TTL). Штамп fetchedAt ставится только при ok.
  let refreshed = 0
  let cursor = 0
  let banned = false
  const workers = Array.from({ length: Math.min(3, rows.length) }, async () => {
    for (;;) {
      if (banned) return
      const i = cursor++
      if (i >= rows.length) return
      const r = rows[i]
      try {
        const card = await getChatCard(r.username)
        if (card.rateLimited) {
          banned = true
          cardRamp = 2 // флуд-контроль снова жив — на следующий раз начинаем аккуратно
          return
        }
        if (card.notFound) {
          // Канал удалён/сделан приватным: штампуем fetchedAt на полный TTL,
          // чтобы не тратить лимит Bot API на мёртвый канал каждый тик.
          // Данные НЕ трогаем — если канал вернётся, обновится после TTL.
          const now = new Date()
          await db.channel.update({
            where: { id: r.id },
            data: { avatarFetchedAt: now, membersFetchedAt: now },
          }).catch(() => {})
          continue
        }
        if (!card.ok) continue // сетевой сбой — без штампа, повтор на следующем тике
        const now = new Date()
        await db.channel.update({
          where: { id: r.id },
          data: {
            // при chatLimited (бан getChat) аватар НЕ штампуем — догонит после снятия
            ...(!card.chatLimited
              ? card.photoFileId
                ? { photoFileId: card.photoFileId, avatarFetchedAt: now }
                : { avatarFetchedAt: now }
              : {}),
            ...(card.members != null
              ? { membersCount: card.members, membersFetchedAt: now }
              : { membersFetchedAt: now }),
          },
        })
        refreshed++
      } catch {
        // БД моргнула — канал останется «без штампа» и попадёт в следующую партию
      }
    }
  })
  await Promise.all(workers)
  if (!banned) cardRamp = Math.min(12, cardRamp + 2) // спокойный тик — темп растёт
  return { refreshed, scanned: rows.length }
}

// ----------------- ЖИВАЯ статистика каналов (fast lane, v5.49) -----------------

/**
 * БЫСТРАЯ СТАТИСТИКА (приказ владельца: «каналы, в которых есть бот, должны
 * подтягивать статистику моментально»): каждый тик refreshing подписчиков
 * небольшой ротационной партии ПОПУЛЯРНЫХ каналов (getChatMemberCount —
 * лёгкий метод Bot API, 1 вызов на канал), минимальный возраст счётчика
 * 30 минут. Каналы, где бот не участник (400/403), держатся в негативном
 * кэше 2ч — Bot API не дёргается впустую. Любой 429 останавливает партию
 * (глобальная пауза уже стоит в fetchLiveMembers/markBotBan).
 *
 * РАСХОД: ≤6 вызовов/тик (~60-120с) ≈ 3-6 вызовов/мин при лимите Bot API
 * 30/с — незаметно; память — одна Map с негативным кэшем (кап 500 записей).
 */
const STATS_PER_TICK = 6
const STATS_MIN_AGE_MS = 30 * 60_000
const STATS_FAIL_TTL_MS = 2 * 3_600_000

const statsFail = new Map<string, number>()

export async function refreshHotChannelStats(): Promise<{ refreshed: number; skipped: boolean }> {
  if (!botEnabled() || botBanned()) return { refreshed: 0, skipped: true }
  const cutoff = new Date(Date.now() - STATS_MIN_AGE_MS)
  let rows: Array<{ id: string; username: string }> = []
  try {
    rows = await db.channel.findMany({
      where: {
        status: 'active',
        OR: [{ membersFetchedAt: null }, { membersFetchedAt: { lt: cutoff } }],
      },
      orderBy: { subscribersCount: 'desc' }, // популярные — первыми, они всегда «почти живые»
      select: { id: true, username: true },
      take: STATS_PER_TICK * 6, // запас под пропуск негативного кэша
    })
  } catch {
    return { refreshed: 0, skipped: true }
  }

  if (statsFail.size > 500) statsFail.clear()

  let refreshed = 0
  for (const r of rows) {
    if (refreshed >= STATS_PER_TICK) break
    const failAt = statsFail.get(r.id)
    if (failAt && failAt > Date.now()) continue
    const res = await fetchLiveMembers(r.username)
    if (res.rateLimited) break // флуд-бан — партию прекращаем, не наказываем Bot API
    if (res.members != null) {
      await db.channel
        .update({
          where: { id: r.id },
          data: { membersCount: res.members, membersFetchedAt: new Date() },
        })
        .catch(() => {})
      refreshed++
    } else {
      // бот не видит канал (не админ/приватен) — пауза 2ч на этот канал
      statsFail.set(r.id, Date.now() + STATS_FAIL_TTL_MS)
    }
  }
  if (refreshed > 0) await bumpCache(['ch']).catch(() => {})
  return { refreshed, skipped: false }
}
