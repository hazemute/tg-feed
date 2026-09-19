import { db } from '@/lib/db'
import { cacheAside, famKey, shortHash } from '@/lib/redis'
import { computeRankedIndex } from '@/lib/feed'

/**
 * ПРОГРЕВ ГЛОБАЛЬНЫХ ИНДЕКСОВ ЛЕНТЫ (защита от «лавины кэша»).
 *
 * Проблема: индекс ленты — тяжёлый SQL (~2с по дальнему Supabase). Если ключ
 * в Redis пуст в момент наплыва (вымыт, истёк, инвалидируется новым постом),
 * пересборку запускают ЗАПРОСЫ ПОЛЬЗОВАТЕЛЕЙ — бёрст с рекламы кладёт пул.
 *
 * Решение: ключи пересобирает ФОНОВЫЙ источник (парсер после добавления
 * постов, /api/warm, Vercel CRON) — пользователи почти всегда читают готовое
 * значение из Redis и никогда не «платят» за пересчёт. TTL ключей длинный
 * (6ч): свежесть обеспечивает инвалидация famKey при новых постах, а не TTL.
 *
 * Покрытие: скоуп-сигнатуры «без интересов и скрытых» — их получает каждый
 * новый пользователь/гость (большинство трафика). Персональные скоупы
 * (интересы/скрытые/discover) не прогреваются — их защищают кросс-инстансный
 * лок и stale-фолбэк cacheAside (см. src/lib/redis.ts).
 *
 * Троттлинг 15 минут: парсер тикает часто (локально каждые 60с), прогревать
 * каждый тик не нужно — Redis-ключи и так живы. force=true (Vercel CRON,
 * админские операции) игнорирует троттлинг.
 */

const WARM_THROTTLE_MS = 15 * 60_000
/** Длинный TTL прогретых ключей: не даёт истечь между обходами парсера;
 *  мусор после инвалидации версии ограничен 6ч. */
const WARM_KEY_TTL_SEC = 6 * 3_600
const MAX_CATEGORIES = 8
/** Дедлайн цикла прогрева: парсер/warm не должны раздуваться из-за медленной
 *  БД; несогретые скоупы догреются на следующем вызове (троттлинг 15 мин) */
const WARM_DEADLINE_MS = 20_000

let lastWarmAt = 0
let warming: Promise<number> | null = null

async function warmOnce(): Promise<number> {
  // «all» + категории БЕЗ скрытых/интересов: сигнатура `cat||` — общий
  // случай для гостей и новых пользователей (совпадает с buildFeedScope)
  const cats = await db.category.findMany({
    where: { slug: { not: 'other' } },
    select: { slug: true },
    orderBy: { slug: 'asc' },
    take: MAX_CATEGORIES - 1,
  })
  const categories = ['all', ...cats.map((c) => c.slug)]
  const deadline = Date.now() + WARM_DEADLINE_MS

  let warmed = 0
  for (const category of categories) {
    if (warmed > 0 && Date.now() > deadline) break
    // Формула ключа — ТОЧНО как в /api/feed: `${category}:v5:${shortHash(sig)}`
    const sig = `${category}||`
    const key = await famKey('feed', `${category}:v5:${shortHash(sig)}`)
    try {
      await cacheAside({
        key,
        ttlSec: WARM_KEY_TTL_SEC,
        memoryTtlMs: 5_000,
        fetcher: () =>
          computeRankedIndex(
            category === 'all'
              ? { channel: { status: 'active' } }
              : { channel: { status: 'active', category: { slug: category } } },
          ),
      })
      warmed++
    } catch {
      // один несогретый скоуп не роняет прогрев остальных
    }
  }
  return warmed
}

/**
 * Прогреть глобальные индексы ленты (без участия пользовательских запросов).
 * Возвращает число пересобранных скоупов (0 — прогрев не требовался/уже идёт).
 */
export async function warmFeedIndexes(opts?: { force?: boolean }): Promise<number> {
  if (!opts?.force) {
    if (Date.now() - lastWarmAt < WARM_THROTTLE_MS) return 0
  }
  if (warming) return warming // параллельные вызовы дедуплицируются
  lastWarmAt = Date.now()
  warming = warmOnce().finally(() => {
    warming = null
  })
  return warming
}
