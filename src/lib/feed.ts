import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { parseJsonArray } from '@/lib/server'
import { getNsfwChannelIds, nsfwPostNotIn } from '@/lib/moderation'
import {
  computeWeight,
  rankJitter,
  REPORT_PENALTY_CAP,
  REPORT_PENALTY_PER,
} from '@/lib/rank'
import { looksLikeGarbage } from '@/lib/text-clean'
import { detectLang } from '@/lib/lang'
import type { PostLang } from '@/lib/lang'
import type { AffinityMap } from '@/lib/rank'

/**
 * Task 5-c: пост с ЭТИМ числом разных жалобщиков и больше исключается из
 * рекомендаций ПОЛНОСТЬЮ (3+ человека независимо нажали «Пожаловаться» —
 * почти наверняка реклама/скам). Канальный штраф (REPORT_PENALTY_*) остаётся
 * мягким понижением для остальных постов канала — решение о бане за людьми.
 */
export const REPORT_HIDE_THRESHOLD = 3

/*
 * v5.76: ПОДРОСТКОВЫЙ МИКС — множитель веса поста по категории канала.
 * Первая аудитория — подростки: игры/мемы/кино/аниме/IT усилены, политика и
 * «взрослые» финансы придавлены. Промо-посты (платное продвижение) не
 * подавляются — платное обещание держим в любой категории.
 */
export const FEED_MIX: Record<string, number> = {
  games: 1.45,
  humor: 1.35,
  memes: 1.35,
  anime: 1.3,
  cinema: 1.25,
  it: 1.2,
  music: 1.2,
  sport: 1.1,
  travel: 1.0,
  food: 1.0,
  other: 0.9,
  crypto: 0.8,
  business: 0.65,
  news: 0.3,
}
const FEED_MIX_DEFAULT = 0.9

// ------------------------- Глобальный индекс ленты -------------------------

/**
 * Запись глобального индекса: id поста, id канала, id категории, вес, язык.
 * Кэшируется для ВСЕХ пользователей (вес — глобальное качество поста),
 * персонализация применяется на каждом запросе поверх этих данных.
 * l — язык поста (lang.ts): фильтр «Русский / Другие» режет индекс на сервере,
 * чтобы пагинация и hasMore были честными.
 * cl — язык КАНАЛА (заголовок+описание): для постов без букв (мемы) подсказывает
 * языковой множитель ранжирования (Task 5-c) — ×0.6 вместо ×0.35.
 */
export type IndexEntry = {
  i: string
  c: string
  g: string | null
  w: number
  l: PostLang
  cl: PostLang
  /** v5.99: канал с ботом (claimedById != null) — контент владельца, придавлен в хвост */
  b: boolean
}
export type RankedIndex = { entries: IndexEntry[]; total: number }

/** Максимум постов одного канала в окне индекса (разнообразие ленты).
 *  v6.0.0: 5 → 4 — жалоба «одно и то же» реже встречается на длинной сессии. */
const MAX_PER_CHANNEL = 4

/**
 * Единая формула сигнатуры скоупа для ключа кэша индекса (v5.48).
 * Используется в /api/feed (через buildFeedScope) и в прогреве (feed-warm) —
 * расхождение ключей исключено по построению.
 */
export function feedScopeSignature(category: string, whereChannel: unknown): string {
  return `${category}|${JSON.stringify(whereChannel)}`
}

/**
 * Версия ключа глобального индекса ленты (Task 8-b). Прежде «v8» дублировалась
 * строкой в /api/feed и строкой «v7» в feed-warm — прогрев молча грел
 * НЕ ТЕ ключи (feed читал v8, warm писал v7), и при наплыве (розыгрыш)
 * первый бёрст пользователей запускал тяжёлую пересборку индекса на пуле.
 * Единая константа делает расхождение невозможным по построению.
 */
export const FEED_INDEX_KEY_V = 'v12'

/*
 * v6.0.0: ПРИКАЗ ВЛАДЕЛЬЦА — «отпаршенные каналы не отображаются, только те,
 * в которых есть бот… чтоб с ботом ВООБЩЕ не отображались либо РЕДКО чем
 * запаршенные с интернета». v5.99 (пул 1 пост + демотиватор ×0.12) оказался
 * недостаточным: демотиватор ВЕСОВОЙ, а свежесть — экспонента (полураспад 36ч).
 * Пока запаршенные посты свежие (≤3–4 суток), ×0.12 держал ботовые внизу; но
 * парсер в проде работал по крону РАЗ в СУТКИ (Vercel Hobby), запаршенный
 * контент старел, и свежие ботовые посты из вебхука поднимались над ним.
 * Поэтому фикс сделан СТРУКТУРНЫМ, не весовым:
 *  1) по-канальный пул для ботовых каналов — 1 пост (запаршенным — 12);
 *  2) ЖЁСТКИЕ ЯРУСИ в порядке индекса: ВСЕ запаршенные посты стоят прежде
 *     ВСЕХ ботовых, независимо от свежести/весов (см. финальную партицию
 *     в computeRankedIndex и такую же партицию в снапшоте /api/feed);
 *  3) ботовых в индексе не более CLAIMED_TAIL_CAP постов суммарно (хвост).
 * Платное промо не страдает: промо-посты пиннятся в голову роутом отдельным
 * механизмом (getPromotedCandidates), их органический вес не важен.
 */
export const CLAIMED_MAX_PER_CHANNEL = 1
export const CLAIMED_DEMOTE = 0.12
/** v6.0.1: максимум ботовых постов в хвосте индекса. Приказ владельца ДОИСПОЛНЕН
 *  ДО КОНЦА: ботовые каналы ВООБЩЕ не отображаются в ленте (было 24 в хвосте).
 *  Контент владельцев живёт в «Мой канал», уведомлениях бота, живом канале,
 *  «Подписках» и платном промо — органический поток ленты только запаршенный. */
export const CLAIMED_TAIL_CAP = 0

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
 * ТЯЖЁЛЫЙ пересчёт глобального индекса (окно 1200 → пул ≤12 свежих/канал + веса): единая реализация
 * для /api/feed и фонового прогрева (feed-warm.ts) — ключи и формула весов
 * всегда совпадают, расхождение исключено по построению.
 */
export async function computeRankedIndex(where: IndexWhere): Promise<RankedIndex> {
  /*
   * v5.97: окно индекса 400 → 1200. Прежнее «400 свежайших постов ПОСТАМИ»
   * покрывало только активно постящие каналы: каналы с редкими выпусками
   * (раз в несколько дней) целиком выпадали из окна — лента сужалась до
   ~2 десятков каналов и владелец видел «одни и те же каналы подряд».
   */
  const posts = await db.post.findMany({
    where: {
      ...where,
      // NSFW-спам (эскорт/18+) не попадает даже в индекс ленты
      AND: [
        ...nsfwPostNotIn(),
        // ИИ-модерация (v5.15): nsfw/spam скрыты из ленты. v6.0.1: 'junk' больше
        // НЕ скрывает, а лишь придаливает (×0.5) — бесплатные модели модерации
        // массово вешали junk на обычные игровые посты, лента пустела
        // («в ленте 2 канала»). Посты без флага показываются как раньше.
        { OR: [{ aiFlag: null }, { aiFlag: 'ok' }, { aiFlag: 'junk' }] },
        // v6.1: платные посты (memberOnly) не входят в глобальный индекс —
        // доступ персонален, они добираются в снапшоте только подписчикам
        { memberOnly: false },
      ],
    },
    select: {
      id: true,
      channelId: true,
      text: true,
      likesCount: true,
      commentsCount: true,
      reactionsTg: true,
      viewsCount: true,
      hotScore: true,
      publishedAt: true,
      promotedAt: true,
      aiFlag: true,
      channel: {
        // title/description — язык канала для языкового множителя ранжирования
        // v5.76: category.slug — подростковый микс (FEED_MIX)
        // v5.99: claimedById — канал с ботом (демотиватор хвоста ленты)
        select: {
          isPremium: true,
          categoryId: true,
          title: true,
          description: true,
          claimedById: true,
          category: { select: { slug: true } },
        },
      },
    },
    orderBy: { publishedAt: 'desc' },
    take: 1200,
  })

  /*
   * v5.97: ПО-КАНАЛЬНЫЙ ПУЛ — каждый активный канал представлен своим окном
   * свежих постов (≤12 новейших на канал), а не конкуренцией «кто чаще постит».
   * Посты приходят отсортированными по свежести → первый проход отдаёт каждому
   * каналу его 12 новейших; редкопостящие каналы больше не вылетают из индекса.
   */
  const PER_CHANNEL_POOL = 12
  const seenPerChannel = new Map<string, number>()
  const pooled = posts
    .filter((p) => !looksLikeGarbage(p.text)) // мгновенный детект каши — не ждём ИИ
    .filter((p) => {
      // v5.99: ботовому (привязанному) каналу — 1 слот в пуле, запаршенному — 12
      const cap = p.channel.claimedById ? CLAIMED_MAX_PER_CHANNEL : PER_CHANNEL_POOL
      const n = seenPerChannel.get(p.channelId) ?? 0
      if (n >= cap) return false
      seenPerChannel.set(p.channelId, n + 1)
      return true
    })

  // v5.68 антиреклама: distinct-жалобы по постам окна → сумма на канал
  // Task 5-c: попутно считаем жалобы НА КАЖДЫЙ пост — 3+ жалобщиков = пост
  // исключается из рекомендаций целиком (см. REPORT_HIDE_THRESHOLD)
  const channelReports = new Map<string, number>()
  const postReports = new Map<string, number>()
  if (pooled.length > 0) {
    try {
      const reps = await db.postReport.groupBy({
        by: ['postId'],
        _count: { _all: true },
        where: { postId: { in: pooled.map((p) => p.id) } },
      })
      const postChannel = new Map(pooled.map((p) => [p.id, p.channelId] as const))
      for (const r of reps) {
        postReports.set(r.postId, r._count._all)
        const ch = postChannel.get(r.postId)
        if (ch) channelReports.set(ch, (channelReports.get(ch) ?? 0) + r._count._all)
      }
    } catch {
      // без данных о жалобах лента работает как раньше
    }
  }

  const entries: IndexEntry[] = pooled
    // Task 5-c: посты с потоком жалоб (≥3 разных жалобщиков) — мимо рекомендаций
    .filter((p) => (postReports.get(p.id) ?? 0) < REPORT_HIDE_THRESHOLD)
    .map((p) => ({
      i: p.id,
      c: p.channelId,
      g: p.channel.categoryId,
      l: detectLang(p.text),
      cl: detectLang(`${p.channel.title} ${p.channel.description ?? ''}`),
      b: p.channel.claimedById != null,
      w: (() => {
        const base = computeWeight({
          likesCount: p.likesCount,
          commentsCount: p.commentsCount,
          reactionsTg: p.reactionsTg,
          viewsCount: p.viewsCount,
          hotScore: p.hotScore,
          publishedAt: p.publishedAt,
          premium: p.channel.isPremium,
          promotedAt: p.promotedAt,
        })
        // v5.76 подростковый микс: множитель по категории; платное продвижение
        // не подавляем (в активном 48ч окне промо множитель ≥ 1)
        const slug = p.channel.category?.slug ?? ''
        const mix = FEED_MIX[slug] ?? FEED_MIX_DEFAULT
        const promoActive =
          p.promotedAt && Date.now() - new Date(p.promotedAt).getTime() < 48 * 3_600_000
        // v6.0.1: ИИ-«junk» (ненадёжные бесплатные модели) — виден, но придален вдвое
        const aiDemote = p.aiFlag === 'junk' ? 0.5 : 1
        return base * (promoActive ? Math.max(1, mix) : mix) * aiDemote
      })() *
        // v5.99: демотиватор ботовых каналов — контент владельца стоит ниже
        // ВСЕХ запаршенных постов (приказ «редко чем запаршенные»); платное
        // промо ботового канала не теряет видимость — его пиннит роут отдельно
        (p.channel.claimedById ? CLAIMED_DEMOTE : 1) +
        // v5.68 антиреклама: канал с потоком жалоб глобально понижается
        Math.min(REPORT_PENALTY_CAP, (channelReports.get(p.channelId) ?? 0) * REPORT_PENALTY_PER) +
        rankJitter(p.id),
    }))
    // Task 5-c: детерминированный tiebreak по id — равные веса не «дрогают»
    // между пересборками индекса (стабильная пагинация)
    .sort((a, b) => b.w - a.w || (a.i < b.i ? -1 : a.i > b.i ? 1 : 0))

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

  /* ---------- v6.0.0: ЖЁСТКИЕ ЯРУСИ (финальная партиция индекса) ----------
   * Внутри каждого яруса порядок по весу; между ярусами — ВСЕГДА
   * запаршенные прежде ботовых. Пагинация режет список сверху вниз,
   * поэтому ботовые посты физически не могут попасть в первые страницы
   * ленты, пока есть хоть сколько-то запаршенных. Захардкоженный кап
   * хвоста не даёт ботовым каналам (их может стать десятки) разрастись.
   */
  const organic = capped.filter((e) => !e.b)
  /* v6.2.0: АВАРИЙНЫЙ ФОЛБЭК «пустая лента». Жёсткий кап 0 нужен, когда есть
   * живая органика — тогда ботовые не пролезают. Но если запарсенных постов
   * НЕТ ВООБЩЕ (парсер лег на t.me-таймауты, каталог пересобирается, ИИ-моде-
   * рация перефлажила органику), показывать пользователю «0 из 0» при живой
   * БД — худший исход. Возвращаем ботовые посты хвостом (≤24): лента остаётся
   * живой, как только органика появится — ярусы снова её приоритизируют. */
  const claimedAll = capped.filter((e) => e.b)
  const claimedTail = organic.length > 0 ? claimedAll.slice(0, CLAIMED_TAIL_CAP) : claimedAll.slice(0, 24)
  const finalEntries = [...organic, ...claimedTail]

  /* v6.0.1: диагностика последней пересборки индекса — видна в /api/health (поле feed):
   * владелец видит одним взглядом, сколько съели мусор-фильтр/ИИ/ботовые и сколько
   * живой органики осталось («в ленте 2 канала» ловится здесь же). */
  recordIndexStats(finalEntries, {
    window: posts.length,
    garbageRemoved: posts.length - posts.filter((p) => !looksLikeGarbage(p.text)).length,
    junkVisible: pooled.filter((p) => p.aiFlag === 'junk').length,
    claimedExcluded: capped.length - organic.length,
  })

  return { entries: finalEntries, total: finalEntries.length }
}

/* ---------------- Статистика индекса для /api/health ---------------- */

export type FeedIndexStats = {
  at: string
  total: number
  channels: number
  claimed: number
  /** позиция первого ботового поста (-1 — ботовых нет вообще) */
  claimedFirstPos: number
  /** v6.0.1 диагностика сужения ленты: окно выборки / съедено мусором / junk виден / ботовых выброшено */
  diag?: { window: number; garbageRemoved: number; junkVisible: number; claimedExcluded: number }
}

const GIDX = globalThis as unknown as { __tgFeedIndexStats?: FeedIndexStats }

function recordIndexStats(
  entries: IndexEntry[],
  diag?: { window: number; garbageRemoved: number; junkVisible: number; claimedExcluded: number },
): void {
  try {
    const claimedFirstPos = entries.findIndex((e) => e.b)
    GIDX.__tgFeedIndexStats = {
      at: new Date().toISOString(),
      total: entries.length,
      channels: new Set(entries.map((e) => e.c)).size,
      claimed: entries.reduce((n, e) => (e.b ? n + 1 : n), 0),
      claimedFirstPos,
      diag,
    }
  } catch {
    /* статистика не должна ронять индекс */
  }
}

export function getFeedIndexStats(): FeedIndexStats | null {
  return GIDX.__tgFeedIndexStats ?? null
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
  user: { categories: string }
  sig: string | null
} | null

/**
 * Кэш скоупа в памяти процесса (60с): скоуп зависит только от (userId, category),
 * но запрос скоупа — 3-6 RTT до дальнего Supabase. Инвалидация — по TTL;
 * подписки/интересы меняются редко, лаг 60с неощутим.
 */
type ScopeCacheEntry = { data: NonNullable<ScopeResult>; exp: number }
/*
 * Кэши персональных сигналов/скоупа — через globalThis-синглтон (паттерн
 * lib/page-cache.ts): в dev (и в некоторых сборках) Next.js изолирует модули
 * разных route-бандлов, и без этого /api/notinterested,/api/report,/api/subscribe
 * вызывали бы invalidatePersonalSignals на СВОЕЙ копии Map — /api/feed не видел
 * бы сброса, и «Не интересно»/жалоба/мьют применялись бы только по TTL (15с).
 * globalThis гарантирует один инстанс на процесс для всех роутов.
 */
const G = globalThis as unknown as {
  __tgFeedScopeCache?: Map<string, ScopeCacheEntry>
  __tgFeedAffinityCache?: Map<string, AffinityCacheEntry>
}
const scopeCache: Map<string, ScopeCacheEntry> = (G.__tgFeedScopeCache ??= new Map())
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

/**
 * v5.78: сколько постов в скоупе (для фолбэка пустых/УЗКИХ интересов).
 * v6.0.1: порог ПОДНЯТ с «>0» до 40: скоуз, в котором меньше 40 постов
 * (2-3 канала), — это НЕ лента, а её огрызок (жалоба владельца «только
 * 2 канала»). Дешёвый count по индексу; вызывается только когда категорийный
 * фильтр установлен (до 1 раза на построение скоупа — сам скоуп кэшируется 60с).
 *
 * v6.3.0 («миллион раз одни и те же посты»): счёт теперь В ОКНЕ ИНДЕКСА,
 * а не за всё время. Индекс берёт 1200 новейших постов (~4-5 суток при текущих
 * темпах), а прежний count смотрел на ВСЮ историю: интересы с 40+ постами ЗА
 * ЖИЗНЬ держали фильтр, хотя в реальном окне у этих категорий оставалось 2-4
 * ботовых поста — лента вырождалась в «4 из 4», крутящиеся по кругу.
 */
const SCOPE_MIN_POSTS = 40
/** Окно счётчика скоупа ≈ фактическое окно индекса (1200 новейших). Заведомо
 *  щедрое: при просадке темпов постинга реальное окно ШИРЕ — фолбэк сработает
 *  раньше (fail-open), лента станет шире, но никогда уже. */
const SCOPE_WINDOW_MS = 5 * 24 * 3_600_000

function scopeWindowWhere(where: Prisma.PostWhereInput): Prisma.PostWhereInput {
  return { ...where, publishedAt: { gt: new Date(Date.now() - SCOPE_WINDOW_MS) } }
}

async function scopePostCount(where: Prisma.PostWhereInput): Promise<number> {
  try {
    return await db.post.count({ where: scopeWindowWhere(where) })
  } catch {
    return SCOPE_MIN_POSTS // ошибка count — не в коем случае не опустошаем ленту
  }
}

/**
 * v6.3.0: есть ли в скоупе хоть ОДИН запарсенный (не ботовый) пост в окне.
 * Ботовые посты в ленту не попадают (CLAIMED_TAIL_CAP = 0), поэтому скоуп
 * интересов без органики — это аварийный фолбэк из 2-4 ботовых постов, которые
 * юзер видит бесконечно («те самые посты, которые я уже миллион раз видел»).
 * Если ГЛОБАЛЬНО органика есть, а в скоупе её ноль — фильтр интересов снимается:
 * лучше широкий поток из других категорий, чем вечное «то же самое».
 */
async function scopeHasOrganic(where: Prisma.PostWhereInput): Promise<boolean> {
  try {
    const ch = (where.channel ?? {}) as Prisma.ChannelWhereInput
    const n = await db.post.count({
      where: {
        ...scopeWindowWhere(where),
        channel: { ...ch, claimedById: null },
      },
    })
    return n > 0
  } catch {
    return true // ошибка — считаем, что органика есть (не опустошаем ленту)
  }
}

async function buildFeedScopeUncached(userId: string, category: string) {
  // Пользователь + скрытые каналы + NSFW-каналы — один batch (дальний регион:
  // каждая последовательная «(п)роверка» стоит ~1 RTT до Supabase)
  const [user, hidden, nsfwIds] = await Promise.all([
    // select: нужен только categories (egress: полная строка User не нужна)
    db.user.findUnique({ where: { id: userId }, select: { categories: true } }),
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
      select: { id: true, slug: true },
    })
    const ranked = [...allCategories].sort((a, b) => (engaged.get(b.id) ?? 0) - (engaged.get(a.id) ?? 0))
    /* Task 5-c: «top» ищется по ВСЕМ категориям (включая 'other'): если вся
     * вовлечённость юзера сидит в некатегоризованных каналах, прежний фильтр
     * slug != 'other' делал top ПУСТЫМ — «Интересное» вырождалось в пару
     * случайных неосвоенных категорий, где нет ни одного поста. В рулетку
     * exploration 'other' по-прежнему не попадает — туда не «открываем». */
    const top = ranked.filter((c) => (engaged.get(c.id) ?? 0) > 0).slice(0, 4)
    const untouched = ranked.filter((c) => !engaged.has(c.id) && c.slug !== 'other')
    // детерминированная «рулетка» по дню: один-два новых раздела в сутки
    const daySeed = Math.floor(Date.now() / 86_400_000)
    const exploration = untouched
      .slice(daySeed % Math.max(1, untouched.length))
      .slice(0, Math.min(2, untouched.length))
    const picked = [...top, ...exploration].map((c) => c.slug)

    // Пустая база категорий или новорождённый пользователь — вся лента
    if (picked.length > 0) {
      where.channel.category = { slug: { in: picked } }
      // v5.78 ФОЛБЭК → v6.0.1: узкий результат (< 40 постов) — снимаем
      // категорийный фильтр, лента показывает всё (лучше шире, чем огрызок)
      // v6.3.0: узость меряется В ОКНЕ индекса, и дополнительно снимаем фильтр,
      // если в скоупе вообще нет органики (иначе — ботовый огрызок фолбэка)
      const narrow =
        (await scopePostCount(where)) < SCOPE_MIN_POSTS || !(await scopeHasOrganic(where))
      if (narrow) {
        delete where.channel.category
      }
    }
  } else if (category !== 'all') {
    where.channel.category = { slug: category }
  } else {
    interests = parseJsonArray(user.categories)
    if (interests.length > 0) {
      where.channel.category = { slug: { in: interests } }
      // v5.78 ФОЛБЭК → v6.0.1: интересы юзера не совпадают с фактическим
      // контентом ИЛИ совпадают слишком узко (< 40 постов) → снимаем фильтр:
      // лучше показать всё, чем 2 канала (жалоба владельца).
      // v6.3.0: узость меряется В ОКНЕ индекса (а не за всю историю) + скоуп
      // без единого запарсенного поста тоже считается узким — иначе лента
      // вырождается в аварийный ботовый хвост, повторяющийся бесконечно.
      const narrow =
        (await scopePostCount(where)) < SCOPE_MIN_POSTS || !(await scopeHasOrganic(where))
      if (narrow) {
        delete where.channel.category
        interests = []
      }
    }
  }

  /*
   * v5.48: сигнатура скоупа строится ИЗ ФАКТИЧЕСКОГО where (категория +
   * интересы/набор категорий + скрытые каналы) — в том числе для 'discover'.
   * Одинаковый where → одинаковый глобальный индекс, поэтому Redis-кэш
   * индекса безопасен и для discover, хотя состав категорий и зависит от
   * истории просмотров (меняется редко; scope-кэш 60с сглаживает переходы).
   * Раньше discover уходил мимо кэша — тяжёлый computeRankedIndex (400 постов
   * + веса + sort) выполнялся на КАЖДЫЙ запрос ленты.
   */
  const sig = feedScopeSignature(category, where.channel)

  return { where, user, sig }
}

// ------------------------- Персональные сигналы -------------------------

/**
 * Аффинити пользователя (каналы/категории) + id просмотренных постов.
 * Кэш в памяти процесса на 8с: бесконечная прокрутка делает несколько
 * запросов подряд — считаем сигналы один раз, на лайки реагируем почти сразу.
 */
type AffinityCacheEntry = { data: PersonalSignals; exp: number }
const affinityCache: Map<string, AffinityCacheEntry> = (G.__tgFeedAffinityCache ??= new Map())
const AFFINITY_TTL_MS = 15_000
const AFFINITY_MAX = 500

export type PersonalSignals = {
  affinity: AffinityMap
  viewedIds: Set<string>
  /** postId → время последнего просмотра (мс) — прогрессивный штраф за просмотренное */
  viewedAt: Map<string, number>
  subscribedIds: Set<string>
  /** Каналы, скрытые кнопкой «Не интересно» — сильный минус в ранжировании */
  mutedIds: Set<string>
  /** v5.68: посты, скрытые «Не интересно» на уровне ПОСТА (не канала) */
  hiddenPostIds: Set<string>
  /** v5.68: categoryId → сколько постов этой тематики юзер скрыл — понижение приоритета */
  dislikeCategories: Map<string, number>
  /** Task 5-c: посты, на которые юзер САМ нажал «Пожаловаться», — из его рекомендаций исключаются */
  reportedPostIds: Set<string>
}

export async function loadPersonalSignals(userId: string): Promise<PersonalSignals> {
  const cached = affinityCache.get(userId)
  if (cached && cached.exp > Date.now()) return cached.data

  /*
   * Batch-транзакция (см. комментарий в buildFeedScope): одно соединение,
   * последовательное выполнение — устраняет P2024 «Timed out fetching a new
   * connection from the connection pool» при connection_limit=1.
   */
  let views: Array<{
    postId: string
    dwellMs: number
    createdAt: Date
    post: { channelId: string; channel: { categoryId: string | null } }
  }>
  let likes: Array<{ createdAt: Date; post: { channelId: string; channel: { categoryId: string | null } } }>
  let bookmarks: Array<{ createdAt: Date; post: { channelId: string; channel: { categoryId: string | null } } }>
  let subs: Array<{ channelId: string; notInterestedAt: Date | null }>
  let mutes: Array<{ channelId: string }>
  // v5.68: «Не интересно» на уровне ПОСТА (канал остаётся, тематика понижается)
  let hides: Array<{ postId: string; post: { channel: { categoryId: string | null } } }>
  let sources: Array<{ channelId: string | null; username: string | null; tgId: string }>
  // Task 5-c: посты, пожалованные самим юзером («то, что я дизлайкнул — не показывать»)
  let ownReports: Array<{ postId: string }>
  try {
    ;[views, likes, bookmarks, subs, mutes, hides, sources, ownReports] = await db.$transaction([
      db.postView.findMany({
        where: { userId },
        select: {
          postId: true,
          dwellMs: true,
          createdAt: true,
          post: { select: { channelId: true, channel: { select: { categoryId: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
      db.like.findMany({
        where: { userId },
        select: {
          createdAt: true,
          post: { select: { channelId: true, channel: { select: { categoryId: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        take: 300,
      }),
      db.bookmark.findMany({
        where: { userId },
        select: {
          createdAt: true,
          post: { select: { channelId: true, channel: { select: { categoryId: true } } } },
        },
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
      // v5.68: скрытые ПОСТЫ («Не интересно» на пост — канал не трогаем)
      db.postHide.findMany({
        where: { userId },
        select: { postId: true, post: { select: { channel: { select: { categoryId: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: 300,
      }),
      // v5.50: ИСТОЧНИКИ РЕКОМЕНДАЦИЙ («В один клик») — каналы, которые юзер
      // переслал боту как «читаю каждый день». Сильнейший декларативный сигнал:
      // важнее просмотров (шум) и лайков (импульс) — это осознанный список.
      db.userSource.findMany({
        where: { userId },
        select: { channelId: true, username: true, tgId: true },
        orderBy: { createdAt: 'desc' },
        take: 80,
      }),
      db.postReport.findMany({
        where: { userId },
        select: { postId: true },
        orderBy: { createdAt: 'desc' },
        take: 200,
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
      viewedAt: new Map(),
      subscribedIds: new Set(),
      mutedIds: new Set(),
      hiddenPostIds: new Set(),
      dislikeCategories: new Map(),
      reportedPostIds: new Set(),
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

  /* ---------------- v5.50: источник = «читаю каждый день» ----------------
   * Вес одного источника равен ~4 лайкам: юзер РУКАМИ подтвердил ежедневное
   * чтение. Ищем каналы каталога по связке channelId (ставится ботом при
   * разборе форварда); для старых записей без связки — один ремонтный
   * запрос по username/tgId с ленивым проставлением channelId. */
  const SOURCE_AFFINITY = 12
  const SOURCE_CATEGORY_WEIGHT = 6
  const resolved = sources
    .map((s) => s.channelId)
    .filter((id): id is string => !!id)
  const unresolved = sources.filter((s) => !s.channelId && (s.username || s.tgId))
  if (unresolved.length > 0) {
    try {
      const candidates = await db.channel.findMany({
        where: {
          OR: [
            { username: { in: unresolved.map((u) => u.username!).filter(Boolean) } },
            { tgId: { in: unresolved.map((u) => u.tgId) } },
          ],
        },
        select: { id: true, categoryId: true, username: true, tgId: true },
        take: 80,
      })
      const byKey = new Map<string, (typeof candidates)[number]>()
      for (const c of candidates) {
        if (c.username) byKey.set(`@${c.username.toLowerCase()}`, c)
        byKey.set(`#${c.tgId}`, c)
      }
      for (const u of unresolved) {
        const hit = (u.username && byKey.get(`@${u.username.toLowerCase()}`)) || byKey.get(`#${u.tgId}`)
        if (hit) {
          resolved.push(hit.id)
          // ленивый ремонт связки: следующий вызов будет уже без поиска
          void db.userSource
            .updateMany({
              where: { userId, tgId: u.tgId, channelId: null },
              data: { channelId: hit.id },
            })
            .catch(() => {})
          if (hit.categoryId) {
            affinity.categories.set(
              hit.categoryId,
              (affinity.categories.get(hit.categoryId) ?? 0) + SOURCE_CATEGORY_WEIGHT,
            )
          }
        }
      }
    } catch {
      // ремонт не удался — работаем по тому, что связано напрямую
    }
  }
  for (const cid of resolved) {
    affinity.channels.set(cid, (affinity.channels.get(cid) ?? 0) + SOURCE_AFFINITY)
  }
  // Категории связанных источников — тоже сигнал (для НЕ известных нам каналов юзера)
  if (resolved.length > 0) {
    try {
      const srcCats = await db.channel.findMany({
        where: { id: { in: resolved.slice(0, 60) } },
        select: { categoryId: true },
      })
      for (const c of srcCats) {
        if (c.categoryId) {
          affinity.categories.set(
            c.categoryId,
            (affinity.categories.get(c.categoryId) ?? 0) + SOURCE_CATEGORY_WEIGHT,
          )
        }
      }
    } catch {
      // без категорий источников лента всё равно работает по каналам
    }
  }
  /* Рецент-веса (v5.27 — «алгоритмы не правильные»): сигнал интереса гаснет со
   * временем (полураспад ~3 недели, exp(-возраст/21д)). Вчерашний просмотр
   * значит в разы больше, чем месячной давности — рекомендации следуют за
   * ТЕКУЩИМ вкусом, а не за историей годичной давности. */
  const recency = (at: Date): number => {
    const ageDays = Math.max(0, (Date.now() - at.getTime()) / 86_400_000)
    return Math.exp(-ageDays / 21)
  }
  const viewedAt = new Map<string, number>()
  for (const v of views) {
    const rec = recency(v.createdAt)
    /* Сигналы интереса: просмотр = 1; ДОЛГОЕ ЧТЕНИЕ усиливает сигнал — каждые
     * полные 10с dwell добавляют +1 (кап +4, т.е. «дочитал 40с+» = 5). */
    const dwellW = Math.min(4, Math.floor((v.dwellMs ?? 0) / 10_000))
    bump(v, (1 + dwellW) * (0.35 + 0.65 * rec))
    const prev = viewedAt.get(v.postId)
    const at = v.createdAt.getTime()
    if (prev === undefined || at > prev) viewedAt.set(v.postId, at)
  }
  for (const l of likes) bump(l, 3 * (0.4 + 0.6 * recency(l.createdAt)))
  for (const b of bookmarks) bump(b, 3 * (0.4 + 0.6 * recency(b.createdAt)))

  // v5.68: скрытые посты → отрицательный сигнал по ТЕМАТИКЕ (лог-вес в personalBoost)
  const dislikeCats = new Map<string, number>()
  for (const h of hides) {
    const cat = h.post?.channel?.categoryId
    if (cat) dislikeCats.set(cat, (dislikeCats.get(cat) ?? 0) + 1)
  }

  const data: PersonalSignals = {
    affinity,
    viewedIds: new Set(views.map((v) => v.postId)),
    viewedAt,
    subscribedIds: new Set(subs.map((s) => s.channelId)),
    mutedIds: new Set(mutes.map((m) => m.channelId)),
    hiddenPostIds: new Set(hides.map((h) => h.postId)),
    dislikeCategories: dislikeCats,
    reportedPostIds: new Set(ownReports.map((r) => r.postId)),
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

/**
 * Сброс персональных сигналов юзера (v5.50): бот добавил источник — чтобы
 * лента перестроилась НЕ дожидаясь TTL кэша (15с), вебхук дёргает это сразу.
 */
export function invalidatePersonalSignals(userId: string): void {
  affinityCache.delete(userId)
}
