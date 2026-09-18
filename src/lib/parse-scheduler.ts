import { db } from '@/lib/db'
import { bumpCache } from '@/lib/redis'
import { bgImageOf } from '@/lib/parse-engine'
import { getChatCard } from '@/lib/tg-bot'

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
export async function refreshChannelCards(limit = 12): Promise<CardsResult> {
  let rows: Array<{ id: string; username: string }> = []
  try {
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
  } catch {
    return { refreshed: 0, scanned: 0 }
  }

  // Конкурентная обработка: 6 воркеров × (getChat + getChatMemberCount + UPDATE).
  // Правило флуд-безопасности: Bot API ответил 429 → вся партия останавливается,
  // оставшиеся каналы НЕ штампуются (иначе они выпадут из обновления на срок TTL).
  // Штамп fetchedAt ставится только когда вызовы реально прошли (ok).
  let refreshed = 0
  let cursor = 0
  let banned = false
  const workers = Array.from({ length: Math.min(6, rows.length) }, async () => {
    for (;;) {
      if (banned) return
      const i = cursor++
      if (i >= rows.length) return
      const r = rows[i]
      try {
        const card = await getChatCard(r.username)
        if (card.rateLimited) {
          banned = true
          return
        }
        if (!card.ok) continue // сетевой сбой — без штампа, повтор на следующем тике
        const now = new Date()
        await db.channel.update({
          where: { id: r.id },
          data: {
            ...(card.photoFileId
              ? { photoFileId: card.photoFileId, avatarFetchedAt: now }
              : { avatarFetchedAt: now }),
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
  return { refreshed, scanned: rows.length }
}
