import { db } from '@/lib/db'
import { chatSimple, openRouterEnabled } from '@/lib/openrouter'
import { cacheAside, shortHash } from '@/lib/redis'
import { looksLikeGarbage } from '@/lib/text-clean'

/**
 * Бесплатная ИИ-модерация ленты (v5.15).
 *
 * Задача: «чтобы не было непонятных тупых постов» — бессмыслица, обрывки,
 * кашица из символов, дичь без содержания, а также спам/NSFW, которые
 * проскочили мимо детерминированных фильтров (moderation.ts).
 *
 * ЭКОНОМИКА: только БЕСПЛАТНЫЕ модели OpenRouter (суффикс :free) — цепочка
 * фолбэков на случай дневных лимитов. Один вызов LLM = вердикт по пачке
 * из ≤8 постов. Вердикты кэшируются:
 *   • Redis по хэшу текста (30 дней) — дубликаты и ретраи бесплатны;
 *   • Post.aiFlag в БД — пост модерается РОВНО один раз.
 *
 * Вердикты:
 *   ok    — нормальный пост;
 *   junk  — бессмысленный/мусорный (каша, обрывки, чистый набор слов) → скрыт из ленты;
 *   nsfw  — 18+/порно/эскорт → скрыт;
 *   spam  — спам/реклама, проскочившая клише-фильтр → скрыт.
 *
 * Интеграция: /api/warm (после каждого тика парсинга) модерирует свежие
 * посты пачками; /api/panel/moderation — ручной запуск и статистика.
 * Фильтр ленты: computeRankedIndex (feed.ts) исключает не-ok посты.
 */

export type AiVerdict = 'ok' | 'junk' | 'nsfw' | 'spam'

/** Бесплатные модели (env AI_MODERATION_MODELS переопределяет) */
const FREE_MODELS = [
  'google/gemma-3-27b-it:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'deepseek/deepseek-chat-v3-0324:free',
  'mistralai/mistral-small-3.2-24b-instruct:free',
]

const VERDICT_RE = /\b(ok|junk|nsfw|spam)\b/g

/**
 * Разбор свободного ответа LLM: модель может вернуть JSON, строки
 * «id=verdict», маркированный список — вытаскиваем пары (id, verdict).
 * Ведём два независимых индекса: порядок вхождений вердиктов и упоминаний id.
 */
function parseVerdicts(raw: string, ids: string[]): Map<string, AiVerdict> {
  const out = new Map<string, AiVerdict>()

  // 1) Попытка JSON
  try {
    const cleaned = raw.replace(/```(?:json)?/gi, '').trim()
    const start = cleaned.indexOf('[')
    const end = cleaned.lastIndexOf(']')
    if (start !== -1 && end !== -1) {
      const arr = JSON.parse(cleaned.slice(start, end + 1)) as unknown
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (item && typeof item === 'object') {
            const o = item as Record<string, unknown>
            const id = String(o.i ?? o.id ?? '')
            const v = String(o.v ?? o.verdict ?? '').toLowerCase()
            if (id && /^(ok|junk|nsfw|spam)$/.test(v)) out.set(id, v as AiVerdict)
          }
        }
        if (out.size > 0) return out
      }
    }
  } catch {
    // падаем на текстовый разбор
  }

  // 2) Текстовый разбор: для каждого id ищем ближайший вердикт в строке
  const verdicts: Array<{ v: AiVerdict; at: number }> = []
  for (const m of raw.matchAll(VERDICT_RE)) {
    verdicts.push({ v: m[1] as AiVerdict, at: m.index ?? 0 })
  }
  if (verdicts.length === 0) return out
  for (const id of ids) {
    let best: AiVerdict | null = null
    let bestDist = Infinity
    let from = 0
    while (true) {
      const at = raw.indexOf(id, from)
      if (at === -1) break
      for (const vd of verdicts) {
        const d = Math.abs(vd.at - at)
        if (d < bestDist) {
          bestDist = d
          best = vd.v
        }
      }
      from = at + id.length
    }
    if (best) out.set(id, best)
  }
  return out
}

const SYSTEM_PROMPT =
  'Ты модератор ленты Telegram-постов. Для КАЖДОГО поста вынеси вердикт: ' +
  '"ok" — нормальный осмысленный пост (новости, мысли, мемы, анонсы, любые темы); ' +
  '"junk" — бессмыслица: бессвязная каша слов, обрывки текста без начала и конца, ' +
  'случайный набор символов, дублированная чушь, пост-заглушка без содержания; ' +
  '"nsfw" — порнография, эскорт, интим-услуги, 18+ сливы; ' +
  '"spam" — агрессивная реклама, фишинг, схемы заработка, розыгрыши-приманки. ' +
  'Сомневаешься — ставь "ok" (ложные баны хуже пропуска). ' +
  'Ответь СТРОГО JSON-массивом без пояснений: [{"i":"<id поста>","v":"<ok|junk|nsfw|spam>"}]'

/** Текст одного поста для модерации: ужимаем, лишние переносы схлопываем */
function clampForPrompt(text: string): string {
  const flat = text.replace(/\n{2,}/g, '\n').trim()
  return flat.length > 600 ? `${flat.slice(0, 600)}…` : flat
}

/** Кэш-ключ вердикта по содержимому (одинаковые тексты не модерятся дважды) */
function cacheKeyOf(text: string): string {
  return `mod:v1:${shortHash(text.slice(0, 800))}`
}

type ModeratablePost = { id: string; text: string }

/**
 * Пачка постов → вердикты. Один LLM-вызов на пачку.
 * Детерминированный мусор (looksLikeGarbage) фильтруется ДО вызова LLM.
 * Возвращает только те id, по которым удалось вынести вердикт.
 */
async function judgeBatch(posts: ModeratablePost[]): Promise<Map<string, AiVerdict>> {
  const result = new Map<string, AiVerdict>()
  const needAi: ModeratablePost[] = []

  for (const p of posts) {
    if (looksLikeGarbage(p.text)) {
      result.set(p.id, 'junk') // бесплатно, без LLM
    } else {
      needAi.push(p)
    }
  }
  if (needAi.length === 0) return result

  const userMsg = needAi
    .map((p, i) => `[${i + 1}] id=${p.id}\n${clampForPrompt(p.text)}`)
    .join('\n\n---\n\n')

  try {
    const raw = await chatSimple(SYSTEM_PROMPT, userMsg, {
      maxTokens: 400,
      timeoutMs: 30_000,
      models: FREE_MODELS,
      temperature: 0,
    })
    const judged = parseVerdicts(raw, needAi.map((p) => p.id))
    for (const [id, v] of judged) result.set(id, v)
  } catch {
    // бесплатные модели недоступны (лимиты) — посты остаются без флага,
    // попробуют на следующем тике /api/warm
  }
  return result
}

export type ModerationRunStats = {
  batches: number
  judged: number
  byVerdict: Record<AiVerdict, number>
  skippedCached: number
  garbageDetected: number
  llmCalled: boolean
}

/**
 * Основной ход: модерировать пачки свежих постов без aiFlag.
 * perBatch ≤ 8 постов, maxBatches пачек за прогон (warm: 2, ручной: до 8).
 */
export async function runAiModeration(maxBatches = 2, batchSize = 8): Promise<ModerationRunStats> {
  const stats: ModerationRunStats = {
    batches: 0,
    judged: 0,
    byVerdict: { ok: 0, junk: 0, nsfw: 0, spam: 0 },
    skippedCached: 0,
    garbageDetected: 0,
    llmCalled: false,
  }
  if (!openRouterEnabled()) return stats

  const since = new Date(Date.now() - 7 * 24 * 3600_000)
  const posts = await db.post.findMany({
    where: { aiFlag: null, publishedAt: { gte: since }, text: { not: '' } },
    select: { id: true, text: true },
    orderBy: { publishedAt: 'desc' },
    take: Math.min(64, maxBatches * batchSize * 2),
  })
  if (posts.length === 0) return stats

  for (let b = 0; b < maxBatches; b++) {
    const slice = posts.slice(b * batchSize, (b + 1) * batchSize)
    if (slice.length === 0) break

    /* Двухходовка: кэш вердиктов в Redis (одинаковые тексты + ретраи) */
    const pending: Array<{ id: string; text: string; key: string }> = []
    for (const p of slice) {
      const key = cacheKeyOf(p.text)
      pending.push({ id: p.id, text: p.text, key })
    }
    const cached = await Promise.all(
      pending.map((p) =>
        cacheAside<AiVerdict | null>({
          key: p.key,
          ttlSec: 30 * 24 * 3600,
          memoryTtlMs: 60_000,
          fetcher: async () => null, // источник истины — LLM ниже, кэш только для hit
        }).catch(() => null as AiVerdict | null),
      ),
    )

    const toJudge: ModeratablePost[] = []
    const flags: Array<{ id: string; v: AiVerdict; key: string }> = []
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i]
      const hit = cached[i]
      if (hit) {
        stats.skippedCached++
        flags.push({ id: p.id, v: hit, key: p.key })
      } else {
        toJudge.push({ id: p.id, text: p.text })
      }
    }

    if (toJudge.length > 0) {
      stats.llmCalled = true
      const judged = await judgeBatch(toJudge)
      for (const p of toJudge) {
        const v = judged.get(p.id)
        if (v) flags.push({ id: p.id, v, key: cacheKeyOf(p.text) })
      }
    }

    // Записываем вердикты (ok тоже пишем: пост не модерится повторно)
    const writeBatch = flags.map((f) =>
        db.post
          .update({
            where: { id: f.id },
            data: { aiFlag: f.v, aiFlagAt: new Date() },
            select: { id: true },
          })
          .then((r) => {
            stats.judged++
            stats.byVerdict[f.v]++
            if (f.v === 'junk') stats.garbageDetected++
            return r
          })
          .catch(() => null),
      )
    await Promise.all(writeBatch)
    void Promise.all(
      flags.map((f) =>
        cacheAside<AiVerdict>({
          key: f.key,
          ttlSec: 30 * 24 * 3600,
          memoryTtlMs: 60_000,
          fetcher: async () => f.v,
        }).catch(() => undefined),
      ),
    )

    stats.batches++
  }
  return stats
}

/** Статистика ИИ-модерации для админки: вердикты за N дней */
export async function moderationStats(days = 7): Promise<{ flag: string; n: number }[]> {
  const since = new Date(Date.now() - days * 24 * 3600_000)
  const rows = await db.post.groupBy({
    by: ['aiFlag'],
    where: { aiFlag: { not: null }, aiFlagAt: { gte: since } },
    _count: { _all: true },
  })
  return rows
    .filter((r) => r.aiFlag)
    .map((r) => ({ flag: r.aiFlag as string, n: r._count._all }))
}
