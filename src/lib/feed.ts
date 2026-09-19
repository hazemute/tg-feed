import { db } from '@/lib/db'
import { parseJsonArray } from '@/lib/server'
import { getNsfwChannelIds, nsfwPostNotIn } from '@/lib/moderation'
import { computeWeight, rankJitter } from '@/lib/rank'
import { looksLikeGarbage } from '@/lib/text-clean'
import { detectLang } from '@/lib/lang'
import type { AffinityMap } from '@/lib/rank'

// ------------------------- Глобальный индекс ленты -------------------------

/**
 * Запись глобального индекса: id поста, id канала, id категории, вес, язык.
 * Кэшируется для ВСЕХ пользователей (вес — глобальное качество поста),
 * персонализация применяется на каждом запросе поверх этих данных.
 * l — язык поста (lang.ts): фильтр «Русский / Другие» режет индекс на сервере,
 * чтобы пагинация и hasMore были честными.
 */
export type IndexEntry = { i: string; c: string; g: string | null; w: number; l: 'ru' | 'foreign' | 'und' }
export type RankedIndex = { entries: IndexEntry[]; total: number }

/** Максимум постов одного канала в окне индекса (разнообразие ленты) */
const MAX_PER_CHANNEL = 5

/** Where-условие выборки индекса (совместимо с Prisma PostWhereInput) */
type IndexWhere = {
  channel: {
    status: 'active'
    id?: { notIn: string[] }
    category?: { slug: string } | { slug: { in: string[] } }
  }
  AND?: Array<Record<string, unknown>>
}

/**
 * ТЯЖЁЛЫЙ пересчёт глобального индекса (400 постов + веса): единая реализация
 * для /api/feed и фонового прогрева (feed-warm.ts) — ключи и формула весов
 * всегда совпадают, расхождение исключено по построению.
 */
export async function computeRankedIndex(where: IndexWhere): Promise<RankedIndex> {
  const posts = await db.post.findMany({
    where: {
      ...where,
      // NSFW-спам (эскорт/18+) не попадает даже в индекс ленты
      AND: [
        ...nsfwPostNotIn(),
        // ИИ-модерация (v5.15): junk/nsfw/spam скрыты из ленты.
        // Посты без флага (не успели модерироваться) показываются —
        // фильтр консервативен, лента не пустеет.
        { OR: [{ aiFlag: null }, { aiFlag: 'ok' }] },
      ],
    },
    select: {
      id: true,
      channelId: true,
      text: true,
      likesCount: true,
      reactionsTg: true,
      viewsCount: true,
      hotScore: true,
      publishedAt: true,
      promotedAt: true,
      channel: {
        select: { isPremium: true, categoryId: true },
      },
    },
    orderBy: { publishedAt: 'desc' },
    take: 400,
  })
  const entries: IndexEntry[] = posts
    .filter((p) => !looksLikeGarbage(p.text)) // мгновенный детект каши — не ждём ИИ
    .map((p) => ({
      i: p.id,
      c: p.channelId,
      g: p.channel.categoryId,
      l: detectLang(p.text),
      w: computeWeight({
        likesCount: p.likesCount,
        reactionsTg: p.reactionsTg,
        viewsCount: p.viewsCount,
        hotScore: p.hotScore,
        publishedAt: p.publishedAt,
        premium: p.channel.isPremium,
        promotedAt: p.promotedAt,
      }) + rankJitter(p.id),
    }))
    .sort((a, b) => b.w - a.w)

  /*
   * КАП НА КАНАЛ (разнообразие, жалоба владельца «постоянно одно и то же»):
   * канал-флудер с серией из 20 постов не должен забивать окно индекса —
   * в ранжированный список попадают максимум MAX_PER_CHANNEL его ЛУЧШИХ
   * постов (по глобальному весу). Остальные в этом окне не участвуют:
   * канал всё равно вернётся новыми выпусками.
   */
  const perChannel = new Map<string, number>()
  const capped: IndexEntry[] = []
  for (const e of entries) {
    const n = perChannel.get(e.c) ?? 0
    if (n >= MAX_PER_CHANNEL) continue
    perChannel.set(e.c, n + 1)
    capped.push(e)
  }
  return { entries: capped, total: capped.length }
}

/**
 * Общий скоуп ленты для пользователя: активные каналы, минус скрытые,
 * фильтр по категории или интересам. Используется в /api/feed и /api/feed/fresh.
 *
 * sig — сигнатура скоупа для Redis-ключа (категория + интересы + скрытые);
 * null для 'discover' (зависит от истории просмотров, кэш не применяется).
 */
type ScopeResult = {
  where: {
    channel: {
      status: 'active'
      id?: { notIn: string[] }
      category?: { slug: string } | { slug: { in: string[] } }
    }
    publishedAt?: { gt: Date }
    AND?: Array<Record<string, unknown>>
  }
  user: { id: string; categories: string }
  sig: string | null
} | null

/**
 * Кэш скоупа в памяти процесса (60с): скоуп зависит только от (userId, category),
 * но запрос скоупа — 3-6 RTT до дальнего Supabase. Инвалидация — по TTL;
 * подписки/интересы меняются редко, лаг 60с неощутим.
 */
type ScopeCacheEntry = { data: NonNullable<ScopeResult>; exp: number }
const scopeCache = new Map<string, ScopeCacheEntry>()
const SCOPE_TTL_MS = 60_000
const SCOPE_MAX = 1_000

function cacheKeyOf(userId: string, category: string): string {
  return `${userId}::${category}`
}

export async function buildFeedScope(userId: string, category: string): Promise<ScopeResult> {
  const ckey = cacheKeyOf(userId, category)
  const hit = scopeCache.get(ckey)
  if (hit && hit.exp > Date.now()) return hit.data

  const built = await buildFeedScopeUncached(userId, category)
  if (!built) return null

  if (scopeCache.size >= SCOPE_MAX) {
    const now = Date.now()
    for (const [k, e] of scopeCache) if (e.exp <= now) scopeCache.delete(k)
    if (scopeCache.size >= SCOPE_MAX) {
      const first = scopeCache.keys().next().value
      if (first !== undefined) scopeCache.delete(first)
    }
  }
  scopeCache.set(ckey, { data: built, exp: Date.now() + SCOPE_TTL_MS })
  return built
}

async function buildFeedScopeUncached(userId: string, category: string) {
  // Пользователь + скрытые каналы + NSFW-каналы — один batch (дальний регион:
  // каждая последовательная «(п)роверка» стоит ~1 RTT до Supabase)
  const [user, hidden, nsfwIds] = await Promise.all([
    db.user.findUnique({ where: { id: userId } }),
    db.subscription.findMany({
      where: { userId, hidden: true },
      select: { channelId: true },
    }),
    getNsfwChannelIds(), // кэш в памяти 10 мин — почти всегда мгновенно
  ])
  if (!user) return null
  const hiddenIds = [...new Set([...hidden.map((h) => h.channelId), ...nsfwIds])]

  const where: {
    channel: {
      status: 'active'
      id?: { notIn: string[] }
      category?: { slug: string } | { slug: { in: string[] } }
    }
    publishedAt?: { gt: Date }
  } = {
    channel: {
      status: 'active',
      id: hiddenIds.length > 0 ? { notIn: hiddenIds } : undefined,
    },
  }

  let interests: string[] = []
  if (category === 'discover') {
    // «Интересное»: категории, в которых пользователь ВОВЛЕЧЁН больше всего
    // (просмотры + лайки + закладки), плюс пара неизведанных — чтобы лента
    // продолжала открывать новое, а не замыкалась на привычном.
    /*
     * Batch-транзакция вместо Promise.all: при connection_limit=1 (pgbouncer)
     * параллельные запросы конкурируют за единственное соединение и ловят
     * P2024 (таймаут пула). Транзакция выполняет их последовательно в одном
     * соединении — чуть медленнее, но стабильно.
     */
    const [views, likes, bookmarks] = await db.$transaction([
      db.postView.findMany({
        where: { userId },
        select: { post: { select: { channel: { select: { categoryId: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
      db.like.findMany({
        where: { userId },
        select: { post: { select: { channel: { select: { categoryId: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: 300,
      }),
      db.bookmark.findMany({
        where: { userId },
        select: { post: { select: { channel: { select: { categoryId: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
    ])
    const engaged = new Map<string, number>()
    const bump = (v: { post?: { channel?: { categoryId?: string } } | null }, w: number) => {
      const cid = v.post?.channel?.categoryId
      if (cid) engaged.set(cid, (engaged.get(cid) ?? 0) + w)
    }
    for (const v of views) bump(v, 1)
    for (const l of likes) bump(l, 3)
    for (const b of bookmarks) bump(b, 3)

    const allCategories = await db.category.findMany({
      where: { slug: { not: 'other' } },
      select: { id: true, slug: true },
    })
    const ranked = [...allCategories].sort((a, b) => (engaged.get(b.id) ?? 0) - (engaged.get(a.id) ?? 0))
    const top = ranked.filter((c) => (engaged.get(c.id) ?? 0) > 0).slice(0, 4)
    const untouched = ranked.filter((c) => !engaged.has(c.id))
    // детерминированная «рулетка» по дню: один-два новых раздела в сутки
    const daySeed = Math.floor(Date.now() / 86_400_000)
    const exploration = untouched
      .slice(daySeed % Math.max(1, untouched.length))
      .slice(0, Math.min(2, untouched.length))
    const picked = [...top, ...exploration].map((c) => c.slug)

    // Пустая база категорий или новорождённый пользователь — вся лента
    if (picked.length > 0) {
      where.channel.category = { slug: { in: picked } }
    }
  } else if (category !== 'all') {
    where.channel.category = { slug: category }
  } else {
    interests = parseJsonArray(user.categories)
    if (interests.length > 0) {
      where.channel.category = { slug: { in: interests } }
    }
  }

  const sig =
    category === 'discover'
      ? null
      : `${category}|${interests.join(',')}|${hiddenIds.join(',')}`

  return { where, user, sig }
}

// ------------------------- Персональные сигналы -------------------------

/**
 * Аффинити пользователя (каналы/категории) + id просмотренных постов.
 * Кэш в памяти процесса на 8с: бесконечная прокрутка делает несколько
 * запросов подряд — считаем сигналы один раз, на лайки реагируем почти сразу.
 */
type AffinityCacheEntry = { data: PersonalSignals; exp: number }
const affinityCache = new Map<string, AffinityCacheEntry>()
const AFFINITY_TTL_MS = 15_000
const AFFINITY_MAX = 500

export type PersonalSignals = {
  affinity: AffinityMap
  viewedIds: Set<string>
  subscribedIds: Set<string>
  /** Каналы, скрытые кнопкой «Не интересно» — сильный минус в ранжировании */
  mutedIds: Set<string>
}

export async function loadPersonalSignals(userId: string): Promise<PersonalSignals> {
  const cached = affinityCache.get(userId)
  if (cached && cached.exp > Date.now()) return cached.data

  /*
   * Batch-транзакция (см. комментарий в buildFeedScope): одно соединение,
   * последовательное выполнение — устраняет P2024 «Timed out fetching a new
   * connection from the connection pool» при connection_limit=1.
   */
  let views: Array<{ postId: string; dwellMs: number; post: { channelId: string; channel: { categoryId: string | null } } }>
  let likes: Array<{ post: { channelId: string; channel: { categoryId: string | null } } }>
  let bookmarks: Array<{ post: { channelId: string; channel: { categoryId: string | null } } }>
  let subs: Array<{ channelId: string; notInterestedAt: Date | null }>
  let mutes: Array<{ channelId: string }>
  try {
    ;[views, likes, bookmarks, subs, mutes] = await db.$transaction([
      db.postView.findMany({
        where: { userId },
        select: {
          postId: true,
          dwellMs: true,
          post: { select: { channelId: true, channel: { select: { categoryId: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
      db.like.findMany({
        where: { userId },
        select: { post: { select: { channelId: true, channel: { select: { categoryId: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: 300,
      }),
      db.bookmark.findMany({
        where: { userId },
        select: { post: { select: { channelId: true, channel: { select: { categoryId: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      db.subscription.findMany({
        where: { userId },
        select: { channelId: true, notInterestedAt: true },
      }),
      // «Не интересно» (v5.10): отдельная таблица ChannelMute — кнопка EyeOff
      // у поста скрывает ВЕСЬ канал из персональной ленты
      db.channelMute.findMany({
        where: { userId },
        select: { channelId: true },
      }),
    ])
  } catch {
    /*
     * Деградация: пул перегружен (бёрст трафика, дальний регион Supabase) —
     * отдаём ленту без персонализации, не роняя 500-й. Ошибку кэшируем на
     * 2 секунды, чтобы не долбить пул каждой прокруткой.
     */
    const empty: PersonalSignals = {
      affinity: { channels: new Map(), categories: new Map() },
      viewedIds: new Set(),
      subscribedIds: new Set(),
      mutedIds: new Set(),
    }
    affinityCache.set(userId, { data: empty, exp: Date.now() + 2_000 })
    return empty
  }

  const affinity: AffinityMap = { channels: new Map(), categories: new Map() }
  const bump = (
    row: { post?: { channelId?: string; channel?: { categoryId?: string | null } } | null },
    w: number,
  ) => {
    const ch = row.post?.channelId
    if (ch) affinity.channels.set(ch, (affinity.channels.get(ch) ?? 0) + w)
    const cat = row.post?.channel?.categoryId
    if (cat) affinity.categories.set(cat, (affinity.categories.get(cat) ?? 0) + w)
  }
  for (const v of views) {
    /*
     * Сигналы интереса: просмотр = 1; ДОЛГОЕ ЧТЕНИЕ усиливает сигнал —
     * каждые полные 10с dwell добавляют +1 (кап +4, т.е. «дочитал 40с+» = 5).
     * Лайк/закладка = 3 (осознанное действие, но одно; долгое чтение нескольких
     * постов канала может перевесить).
     */
    const dwellW = Math.min(4, Math.floor((v.dwellMs ?? 0) / 10_000))
    bump(v, 1 + dwellW)
  }
  for (const l of likes) bump(l, 3)
  for (const b of bookmarks) bump(b, 3)

  const data: PersonalSignals = {
    affinity,
    viewedIds: new Set(views.map((v) => v.postId)),
    subscribedIds: new Set(subs.map((s) => s.channelId)),
    mutedIds: new Set(mutes.map((m) => m.channelId)),
  }

  if (affinityCache.size >= AFFINITY_MAX) {
    const now = Date.now()
    for (const [k, e] of affinityCache) if (e.exp <= now) affinityCache.delete(k)
    if (affinityCache.size >= AFFINITY_MAX) {
      const first = affinityCache.keys().next().value
      if (first !== undefined) affinityCache.delete(first)
    }
  }
  affinityCache.set(userId, { data, exp: Date.now() + AFFINITY_TTL_MS })
  return data
}
