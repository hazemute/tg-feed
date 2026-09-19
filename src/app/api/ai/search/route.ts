import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardPublic } from '@/lib/guard'
import { cacheGet, cacheSet, shortHash } from '@/lib/redis'
import { getNsfwChannelIds } from '@/lib/moderation'
import { looksLikeGarbage } from '@/lib/text-clean'
import { stripMarkdown } from '@/lib/markdown'
import { chatSimple, openRouterEnabled } from '@/lib/openrouter'
import { aiSearchAllowance } from '@/lib/tiers'
import { toPostDTO } from '@/lib/dto'

export const dynamic = 'force-dynamic'

/**
 * УМНЫЙ ИИ-ПОИСК (v5.17).
 *
 * Пользователь пишет обычный вопрос («что там с биткоином за два дня?») —
 * нейросеть перечитывает свежие посты (последние 3 суток), вычленяет суть
 * и отвечает 3–4 строками. Под ответом — карточки постов-источников.
 *
 * ЛИМИТЫ: free — 3 поиска в сутки (UTC, таблица AiSearchLog); Snap Plus/Pro —
 * безлимит. Повтор того же запроса в течение 10 минут идёт из кэша и НЕ
 * списывает лимит (кэш проверяется до учёта).
 *
 * Ответ строится ТОЛЬКО по постам из базы — без выдумок: в промпте нумерованный
 * дайджест, модель обязана сослаться на использованные номера (SOURCES).
 */

const bodySchema = z.object({
  q: z.string().trim().min(3).max(300),
  category: z.string().trim().max(40).optional(),
})

/** Сколько свежих постов читает модель (каждый обрезан до 320 символов) */
const DIGEST_LIMIT = 36
const SNIPPET_LEN = 320

type SearchPayload = {
  answer: string
  /** id постов-источников в порядке значимости */
  sourceIds: string[]
}

async function buildAnswer(q: string, categorySlug: string | undefined): Promise<SearchPayload> {
  const since = new Date(Date.now() - 3 * 24 * 60 * 60_000)

  // Кандидаты: свежие, прошедшие ИИ-модерацию, активный канал, нужная категория
  const candidates = await db.post.findMany({
    where: {
      publishedAt: { gte: since },
      OR: [{ aiFlag: null }, { aiFlag: 'ok' }],
      channel: {
        status: 'active',
        id: { notIn: await getNsfwChannelIds() },
        ...(categorySlug ? { category: { slug: categorySlug } } : {}),
      },
    },
    include: { channel: { include: { category: true } } },
    orderBy: { publishedAt: 'desc' },
    take: 220,
  })

  // Ранжируем кандидатов: свежесть + вовлечённость, мусор и коротышей сразу вон
  const scored = candidates
    .filter((p) => {
      const t = stripMarkdown(p.text).trim()
      return t.length >= 60 && !looksLikeGarbage(p.text)
    })
    .map((p) => {
      const hours = (Date.now() - p.publishedAt.getTime()) / 3_600_000
      const engagement = p.likesCount * 3 + p.reactionsTg * 2 + p.viewsCount * 0.2
      return { p, score: engagement / Math.pow(hours + 3, 0.8) + Math.max(0, 60 - hours) }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, DIGEST_LIMIT)

  if (scored.length === 0) {
    return {
      answer:
        'За последние дни по этой теме в ленте нет подходящих постов. Попробуйте спросить иначе или выбрать другую тему.',
      sourceIds: [],
    }
  }

  const digest = scored
    .map((s, i) => {
      const date = s.p.publishedAt.toISOString().slice(0, 16).replace('T', ' ')
      const text = stripMarkdown(s.p.text).replace(/\s+/g, ' ').slice(0, SNIPPET_LEN)
      return `[${i + 1}] (${s.p.channel.title}, ${date}) ${text}`
    })
    .join('\n')

  const system =
    'Ты — умный поисковый ассистент ленты Telegram-каналов Tg Swipe. Тебе дают вопрос пользователя и ' +
    'нумерованный дайджест свежих постов. Отвечай СТРОГО по содержимому дайджеста, ничего не выдумывай, ' +
    'не добавляй знания извне. Ответ: 3–4 короткие строки по-русски, без markdown, без вступлений ' +
    'и без перечисления номеров в тексте. ПОСЛЕ ответа отдельной строкой добавь ' +
    '"SOURCES: 1, 4, 7" — номера постов из дайджеста, которые ты использовал (от 1 до 6 штук, самые важные).'
  const user = `Вопрос пользователя: ${q}\n\nДайджест свежих постов:\n${digest}`

  const raw = await chatSimple(system, user, { maxTokens: 320, timeoutMs: 30_000, temperature: 0.2 })

  // Парсим хвост SOURCES: N, M, K
  const m = raw.match(/SOURCES\s*:\s*([0-9,\s]+)/i)
  const answer = (m ? raw.slice(0, m.index) : raw).replace(/SOURCES\s*:[\s\S]*/i, '').trim()
  const idxs = (m?.[1] ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= scored.length)

  const sourceIds = idxs.slice(0, 6).map((n) => scored[n - 1]!.p.id)
  // Фолбэк: модель не сослалась — берём топ-3 по рейтингу
  const finalIds = sourceIds.length > 0 ? sourceIds : scored.slice(0, 3).map((s) => s.p.id)

  return { answer, sourceIds: finalIds }
}

export async function POST(request: Request) {
  const g = guardPublic(request, { limit: 12, windowMs: 60_000, bucket: 'ai-search' })
  if (!g.ok) return g.res

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('Опишите вопрос — от 3 символов')
    const { q, category } = parsed.data

    if (!openRouterEnabled()) return err('ИИ-поиск временно недоступен', 503)

    // Лимит до генерации: free — 3/сутки; plus/pro — безлимит
    const allowance = g.uid ? await aiSearchAllowance(g.uid) : null
    if (allowance && !allowance.allowed) {
      return NextResponse.json(
        {
          error: 'ai_search_limit',
          message: 'Лимит ИИ-поиска на сегодня исчерпан (3 в день)',
          tier: allowance.tier,
        },
        { status: 402 },
      )
    }

    // Кэш ответа: повтор того же запроса в 10 минутах НЕ списывает лимит
    const cacheKey = `ais:${shortHash(`${q.toLowerCase()}|${category ?? ''}`)}`
    let payload = await cacheGet<SearchPayload>(cacheKey)
    let fromCache = true
    if (!payload) {
      payload = await buildAnswer(q, category)
      fromCache = false
      await cacheSet(cacheKey, payload, 600).catch(() => {})
      // Реальный вызов LLM — списываем лимит (гостям без сессии нечего списывать)
      if (g.uid) {
        await db.aiSearchLog.create({ data: { userId: g.uid, query: q.slice(0, 300) } }).catch(() => {})
      }
    }

    // Источники → полноценные PostDTO (валидные, активные каналы)
    const ids = payload.sourceIds ?? []
    const sourcePosts =
      ids.length > 0
        ? await db.post.findMany({
            where: { id: { in: ids }, channel: { status: 'active' } },
            include: { channel: { include: { category: true } } },
          })
        : []
    const byId = new Map(sourcePosts.map((p) => [p.id, p]))
    const ordered = ids.map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => Boolean(p))
    const sources = ordered.map((p) => toPostDTO(p, { liked: false, bookmarked: false, subscribed: false }))

    // Сколько осталось после этого поиска (кэш не расходует)
    let remaining: number | null = null
    if (allowance) {
      const after = fromCache
        ? allowance
        : g.uid
          ? await aiSearchAllowance(g.uid)
          : null
      remaining = after && Number.isFinite(after.remaining) ? after.remaining : null
    }

    return NextResponse.json({
      answer: payload.answer,
      sources,
      remaining,
      cached: fromCache || undefined,
    })
  } catch (e) {
    console.error('[ai/search]', e)
    return err('Нейросеть не ответила — попробуйте ещё раз', 502)
  }
}
