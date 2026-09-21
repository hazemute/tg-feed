import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, IS_SQLITE } from '@/lib/server'
import { guardPublic } from '@/lib/guard'
import { stripMarkdown } from '@/lib/markdown'
import type { ChannelStatsDTO, TopPostDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

const querySchema = z.object({
  username: z.string().trim().min(1).max(100),
})

/** CDN (11-a): статистика публична и одинакова для всех — edge-кэш 60с */
const CDN_CACHE = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300'

/*
 * Кабинет канала — ТОЧНАЯ статистика из БД (никаких выдумок):
 * всё считается SQL-агрегатами по реальным постам (t.me-просмотры/реакции,
 * накопленные парсером) и действиям пользователей приложения.
 *
 * «Просмотры» поста = COALESCE(viewsTg, viewsCount): приоритет у честных
 * просмотров исходного канала Telegram, фолбэк — локальный счётчик.
 *
 * Все тяжёлые выборки идут одним batch-транзакцией (одно соединение пула —
 * при connection_limit=1 параллельные запросы ловят P2024).
 */

/** Кэш в памяти процесса (90с): статистика меняется редко, таб переключают часто */
type CacheEntry = { data: ChannelStatsDTO; exp: number }
const statsCache = new Map<string, CacheEntry>()
const STATS_TTL_MS = 90_000
const STATS_MAX = 300

type AggRow = {
  posts: number
  views_total: number
  views_avg: number
  views_median: number
  views_max: number
  reactions_total: number
  likes_total: number
  text_len_avg: number
  with_text: number
  first_at: Date | null
  last_at: Date | null
  active_days: number
}

type BinRow = { dow: number; hour: number; n: number; v: number }
type SeriesRow = { publishedAt: Date; views: number; reactions: number }
type CadenceRow = { d: Date; n: number }
type MediaRow = { type: string; count: number }
type AppViewsRow = { n: number }

const ISO = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null)

/**
 * Общая сборка ChannelStatsDTO из сырых агрегатов — используется обоими путями
 * (Postgres raw SQL и SQLite/JS). Чистая функция: без обращения к БД.
 */
function finalizeStats(input: {
  a: AggRow
  bins: BinRow[]
  seriesRows: SeriesRow[]
  cadenceRows: CadenceRow[]
  topViews: Parameters<typeof topDto>[0][]
  topReactions: Parameters<typeof topDto>[0][]
  appViews: number
  mediaRows: MediaRow[]
  members: number | null | undefined
  subscribers: number | null | undefined
}): ChannelStatsDTO {
  const { a, bins, seriesRows, cadenceRows, topViews, topReactions, appViews, mediaRows, members, subscribers } = input

  // --- Медиа-микс ---
  const mediaMix = mediaRows.map((m) => ({ type: m.type, count: m.count }))

  // --- Гистограммы из бинов ---
  const weekday = Array.from({ length: 7 }, (_, dow) => {
    const rows = bins.filter((b) => b.dow === dow)
    const n = rows.reduce((s, b) => s + b.n, 0)
    const v = n > 0 ? rows.reduce((s, b) => s + b.v * b.n, 0) / n : 0
    return { dow, count: n, viewsAvg: Math.round(v) }
  })
  const hours = Array.from({ length: 24 }, (_, hour) => {
    const rows = bins.filter((b) => b.hour === hour)
    const n = rows.reduce((s, b) => s + b.n, 0)
    const v = n > 0 ? rows.reduce((s, b) => s + b.v * b.n, 0) / n : 0
    return { hour, count: n, viewsAvg: Math.round(v) }
  })

  // --- Лучшее время публикации: бин 3ч × день недели с максимумом
  //     среднего числа просмотров (только бины с ≥2 постами — честно) ---
  let bestSlot: ChannelStatsDTO['bestSlot'] = null
  {
    const slots = new Map<string, { dow: number; hour: number; wv: number; n: number }>()
    for (const b of bins) {
      const slot = Math.floor(b.hour / 3) * 3
      const key = `${b.dow}:${slot}`
      const cur = slots.get(key) ?? { dow: b.dow, hour: slot, wv: 0, n: 0 }
      cur.wv += b.v * b.n
      cur.n += b.n
      slots.set(key, cur)
    }
    for (const s of slots.values()) {
      if (s.n < 2) continue
      const avg = s.wv / s.n
      if (!bestSlot || avg > bestSlot.viewsAvg) {
        bestSlot = { dow: s.dow, hour: s.hour, viewsAvg: Math.round(avg), samples: s.n }
      }
    }
  }

  // --- Серии для графиков (хронологически) ---
  const series = seriesRows
    .slice()
    .reverse()
    .map((r) => ({
      date: new Date(r.publishedAt).toISOString(),
      views: r.views,
      reactions: r.reactions,
    }))

  // --- Ритм публикаций: 30 дней с нулями ---
  const cadence: ChannelStatsDTO['cadence'] = []
  {
    const byDay = new Map(cadenceRows.map((r) => [new Date(r.d).toISOString().slice(0, 10), r.n]))
    const today = new Date()
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86_400_000)
      const key = d.toISOString().slice(0, 10)
      cadence.push({ date: key, count: byDay.get(key) ?? 0 })
    }
  }

  // --- Интервалы между постами: (последний - первый) / (posts-1) ---
  const gapHoursAvg =
    a.posts > 1 && a.first_at && a.last_at
      ? (new Date(a.last_at).getTime() - new Date(a.first_at).getTime()) / (a.posts - 1) / 3_600_000
      : null

  const viewsTotal = a.views_total
  const erPct = viewsTotal > 0 ? (a.reactions_total / viewsTotal) * 100 : 0
  // Охват: средние просмотры поста / подписчики канала
  const reachPct = members && members > 0 ? Math.min(999, (a.views_avg / members) * 100) : null

  return {
    posts: a.posts,
    viewsTotal,
    viewsAvg: Math.round(a.views_avg),
    viewsMedian: Math.round(a.views_median),
    viewsMax: a.views_max,
    reactionsTotal: a.reactions_total,
    reactionsAvg: a.posts > 0 ? a.reactions_total / a.posts : 0,
    erPct: Math.round(erPct * 100) / 100,
    reachPct: reachPct === null ? null : Math.round(reachPct * 10) / 10,
    likesTotal: a.likes_total,
    appViews,
    textLenAvg: Math.round(a.text_len_avg),
    withTextPct: a.posts > 0 ? Math.round((a.with_text / a.posts) * 100) : 0,
    firstAt: ISO(a.first_at),
    lastAt: ISO(a.last_at),
    activeDays: a.active_days,
    postsPerDayAvg:
      a.active_days > 0 ? Math.round((a.posts / a.active_days) * 100) / 100 : 0,
    gapHoursAvg: gapHoursAvg === null ? null : Math.round(gapHoursAvg * 10) / 10,
    mediaMix,
    weekday,
    hours,
    bestSlot,
    series,
    cadence,
    topByViews: topViews.map(topDto),
    topByReactions: topReactions.map(topDto),
    membersCount: members ?? 0,
    subscribersCount: subscribers ?? 0,
  }
}

function topDto(p: {
  id: string
  text: string
  mediaUrl: string | null
  mediaType: string
  viewsTg: number | null
  viewsCount: number
  reactionsTg: number
  publishedAt: Date
  link: string | null
}): TopPostDTO {
  return {
    id: p.id,
    // stripMarkdown: маркеры премиум-эмодзи ![e:ID](…) и разметка не утекают в сниппет
    text: stripMarkdown(p.text).replace(/\s+/g, ' ').trim().slice(0, 220),
    mediaUrl: p.mediaUrl,
    mediaType: p.mediaType,
    views: p.viewsTg ?? p.viewsCount,
    reactions: p.reactionsTg,
    publishedAt: new Date(p.publishedAt).toISOString(),
    link: p.link,
  }
}

export async function GET(request: Request) {
  const g = guardPublic(request, { limit: 60, windowMs: 60_000, bucket: 'chstats' })
  if (!g.ok) return g.res

  try {
    const { searchParams } = new URL(request.url)
    const parsed = querySchema.safeParse(Object.fromEntries(searchParams))
    if (!parsed.success) return err('username required')
    const username = parsed.data.username.replace(/^@/, '').toLowerCase()

    const cached = statsCache.get(username)
    if (cached && cached.exp > Date.now()) return NextResponse.json(cached.data, { headers: { 'Cache-Control': CDN_CACHE } })

    const channel = await db.channel.findFirst({
      where: { username },
      select: { id: true, membersCount: true, subscribersCount: true },
    })
    if (!channel) return err('channel not found', 404)
    const cid = channel.id

    /*
     * SQLite (песочница): не знает ::int/PERCENTILE_CONT/date_trunc/NOW() —
     * те же агрегаты считаются Prisma-выборкой и в JS. Прод (Postgres) идёт
     * прежним одним batch-запросом.
     */
    if (IS_SQLITE) {
      const [posts, appViewsCount] = await Promise.all([
        db.post.findMany({
          where: { channelId: cid },
          orderBy: { publishedAt: 'desc' },
          select: {
            id: true, publishedAt: true, text: true, mediaType: true, mediaUrl: true, link: true,
            viewsTg: true, viewsCount: true, reactionsTg: true, likesCount: true,
          },
        }),
        // v5.69: COUNT вместо findMany(select id) — раньше все строки PostView
        // канала тащились в память ради одного числа
        db.postView.count({
          where: {
            post: { channelId: cid },
            // Инкогнито (Snap Plus/Pro): активные платные подписчики не считаются
            user: {
              OR: [{ tier: 'free' }, { tierUntil: null }, { tierUntil: { lte: new Date() } }],
            },
          },
        }),
      ])

      const viewsOf = (p: { viewsTg: number | null; viewsCount: number }) => p.viewsTg ?? p.viewsCount
      const viewsList = posts.map(viewsOf)
      const sorted = [...viewsList].sort((x, y) => x - y)
      const median = sorted.length === 0 ? 0 : sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : Math.round(((sorted[sorted.length / 2 - 1] ?? 0) + (sorted[sorted.length / 2] ?? 0)) / 2)
      const sum = (arr: number[]) => arr.reduce((s, x) => s + x, 0)
      const chrono = [...posts].sort((x, y) => x.publishedAt.getTime() - y.publishedAt.getTime())

      const agg: AggRow = {
        posts: posts.length,
        views_total: sum(viewsList),
        views_avg: posts.length ? sum(viewsList) / posts.length : 0,
        views_median: median,
        views_max: posts.length ? Math.max(...viewsList) : 0,
        reactions_total: sum(posts.map((p) => p.reactionsTg)),
        likes_total: sum(posts.map((p) => p.likesCount)),
        text_len_avg: posts.length ? sum(posts.map((p) => p.text.length)) / posts.length : 0,
        with_text: posts.filter((p) => p.text.length > 0).length,
        first_at: chrono[0]?.publishedAt ?? null,
        last_at: chrono[chrono.length - 1]?.publishedAt ?? null,
        active_days: new Set(chrono.map((p) => p.publishedAt.toISOString().slice(0, 10))).size,
      }

      const binsMap = new Map<string, BinRow>()
      for (const p of posts) {
        const dow = p.publishedAt.getUTCDay()
        const hour = p.publishedAt.getUTCHours()
        const k = `${dow}:${hour}`
        const cur = binsMap.get(k) ?? { dow, hour, n: 0, v: 0 }
        cur.v = (cur.v * cur.n + viewsOf(p)) / (cur.n + 1)
        cur.n += 1
        binsMap.set(k, cur)
      }
      const bins = [...binsMap.values()]

      const seriesRows: SeriesRow[] = posts.slice(0, 40).map((p) => ({
        publishedAt: p.publishedAt,
        views: viewsOf(p),
        reactions: p.reactionsTg,
      }))

      const cadenceMap = new Map<string, number>()
      for (const p of posts) {
        const k = p.publishedAt.toISOString().slice(0, 10)
        cadenceMap.set(k, (cadenceMap.get(k) ?? 0) + 1)
      }
      const cadenceRows: CadenceRow[] = [...cadenceMap.entries()]
        .filter(([d]) => d >= new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10))
        .map(([d, n]) => ({ d: new Date(`${d}T00:00:00Z`), n }))

      const mediaMap = new Map<string, number>()
      for (const p of posts) mediaMap.set(p.mediaType, (mediaMap.get(p.mediaType) ?? 0) + 1)
      const mediaRows: MediaRow[] = [...mediaMap.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort((x, y) => y.count - x.count)

      const rank = (key: 'views' | 'reactions') =>
        [...posts]
          .sort((x, y) => (key === 'views' ? viewsOf(y) - viewsOf(x) : y.reactionsTg - x.reactionsTg))
          .slice(0, 5)

      const topViews = rank('views')
      const topReactions = rank('reactions')
      const appViews = appViewsCount

      const a = agg
      const built = finalizeStats({ a, bins, seriesRows, cadenceRows, topViews, topReactions, appViews, mediaRows, members: channel.membersCount ?? channel.subscribersCount, subscribers: channel.subscribersCount })
      statsCache.set(username, { data: built, exp: Date.now() + STATS_TTL_MS })
      return NextResponse.json(built, { headers: { 'Cache-Control': CDN_CACHE } })
    }

    const [agg, bins, seriesRows, cadenceRows, topViews, topReactions, appViewsRows, mediaRows] =
      await db.$transaction([
        // ===== Сводные агрегаты (один проход по постам канала) =====
        db.$queryRaw<AggRow[]>`
          SELECT
            COUNT(*)::int                                                        AS posts,
            COALESCE(SUM(COALESCE("viewsTg", "viewsCount")), 0)::int             AS views_total,
            COALESCE(AVG(COALESCE("viewsTg", "viewsCount")), 0)::float           AS views_avg,
            COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (
              ORDER BY COALESCE("viewsTg", "viewsCount")), 0)::float             AS views_median,
            COALESCE(MAX(COALESCE("viewsTg", "viewsCount")), 0)::int             AS views_max,
            COALESCE(SUM("reactionsTg"), 0)::int                                 AS reactions_total,
            COALESCE(SUM("likesCount"), 0)::int                                  AS likes_total,
            COALESCE(AVG(LENGTH("text")), 0)::float                              AS text_len_avg,
            COUNT(CASE WHEN LENGTH("text") > 0 THEN 1 END)::int                  AS with_text,
            MIN("publishedAt")                                                   AS first_at,
            MAX("publishedAt")                                                   AS last_at,
            COUNT(DISTINCT date_trunc('day', "publishedAt"))::int                AS active_days
          FROM "Post" WHERE "channelId" = ${cid}`,

        // ===== Бины (день недели, час) × просмотры: из них собираются
        // гистограммы, тепловая карта и «лучшее время публикации» =====
        db.$queryRaw<BinRow[]>`
          SELECT
            EXTRACT(DOW FROM "publishedAt" AT TIME ZONE 'UTC')::int              AS dow,
            EXTRACT(HOUR FROM "publishedAt" AT TIME ZONE 'UTC')::int             AS hour,
            COUNT(*)::int                                                        AS n,
            COALESCE(AVG(COALESCE("viewsTg", "viewsCount")), 0)::float           AS v
          FROM "Post" WHERE "channelId" = ${cid}
          GROUP BY 1, 2`,

        // ===== Динамика: последние 40 постов в хронологическом порядке =====
        db.$queryRaw<SeriesRow[]>`
          SELECT "publishedAt",
                 COALESCE("viewsTg", "viewsCount")::int                        AS views,
                 "reactionsTg"::int                                            AS reactions
          FROM "Post" WHERE "channelId" = ${cid}
          ORDER BY "publishedAt" DESC LIMIT 40`,

        // ===== Ритм публикаций: посты по дням за 30 суток =====
        db.$queryRaw<CadenceRow[]>`
          SELECT date_trunc('day', "publishedAt")                              AS d,
                 COUNT(*)::int                                                 AS n
          FROM "Post"
          WHERE "channelId" = ${cid} AND "publishedAt" > now() - interval '30 days'
          GROUP BY 1 ORDER BY 1`,

        // ===== Топ-5 по просмотрам =====
        db.post.findMany({
          where: { channelId: cid },
          orderBy: [{ viewsTg: 'desc' }, { viewsCount: 'desc' }],
          take: 5,
          select: {
            id: true, text: true, mediaUrl: true, mediaType: true,
            viewsTg: true, viewsCount: true, reactionsTg: true, publishedAt: true, link: true,
          },
        }),

        // ===== Топ-5 по реакциям =====
        db.post.findMany({
          where: { channelId: cid },
          orderBy: { reactionsTg: 'desc' },
          take: 5,
          select: {
            id: true, text: true, mediaUrl: true, mediaType: true,
            viewsTg: true, viewsCount: true, reactionsTg: true, publishedAt: true, link: true,
          },
        }),

        // ===== Читатели приложения: сколько раз посты канала открывали =====
        // Инкогнито (Snap Plus/Pro, v5.17): активные платные подписчики
        // не видны в детальной статистике — только free и истёкшие тир-подписки
        db.$queryRaw<AppViewsRow[]>`
          SELECT COUNT(*)::int AS n
          FROM "PostView" pv
          JOIN "Post" p ON p."id" = pv."postId"
          JOIN "User" u ON u."id" = pv."userId"
          WHERE p."channelId" = ${cid}
            AND (u."tier" = 'free' OR u."tier" IS NULL OR u."tierUntil" IS NULL OR u."tierUntil" <= NOW())`,

        // ===== Медиа-микс =====
        db.$queryRaw<MediaRow[]>`
          SELECT "mediaType" AS type, COUNT(*)::int AS count
          FROM "Post" WHERE "channelId" = ${cid}
          GROUP BY 1 ORDER BY 2 DESC`,
      ])

    const a = agg[0]
    if (!a) return err('channel failed', 500)
    const appViews = appViewsRows[0]?.n ?? 0

    const data = finalizeStats({
      a,
      bins,
      seriesRows,
      cadenceRows,
      topViews,
      topReactions,
      appViews,
      mediaRows,
      members: channel.membersCount ?? channel.subscribersCount,
      subscribers: channel.subscribersCount,
    })
    // membersCount/subscribersCount отдаём как есть (могут быть null)
    data.membersCount = channel.membersCount
    data.subscribersCount = channel.subscribersCount

    if (statsCache.size >= STATS_MAX) {
      const now = Date.now()
      for (const [k, e] of statsCache) if (e.exp <= now) statsCache.delete(k)
    }
    statsCache.set(username, { data, exp: Date.now() + STATS_TTL_MS })

    return NextResponse.json(data, { headers: { 'Cache-Control': CDN_CACHE } })
  } catch (e) {
    console.error('[channel/stats]', e)
    return err('stats failed', 500)
  }
}
