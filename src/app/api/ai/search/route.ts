import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardPublic } from '@/lib/guard'
import {
  AI_MTOK_IN_SWP,
  AI_MTOK_OUT_SWP,
  estimateAiSwipes,
  aiCanAfford,
  chargeAiUsage,
  swipesForUsage,
  usageCollector,
  type AiUsage,
} from '@/lib/wallet'
import { cacheGet, cacheSet, shortHash } from '@/lib/redis'
import { getNsfwChannelIds } from '@/lib/moderation'
import { looksLikeGarbage } from '@/lib/text-clean'
import { stripMarkdown } from '@/lib/markdown'
import { chatSimple, chatWithTools, chatWithToolsStream, openRouterEnabled, openRouterErrorText, type ChatMsg } from '@/lib/openrouter'
import { aiPremiumEmojiText } from '@/lib/ai-emoji'
import { aiSearchAllowance } from '@/lib/tiers'
import { POST_LIST_SELECT, postDTOFromRow } from '@/lib/dto'
import { schemasFor, toolBy, type ToolExecResult, searchSystemPrompt, type ToolCtx } from '@/lib/ai-tools'
import { knowledgeBlock } from '@/lib/ai-knowledge'
import { sseStream } from '@/lib/sse'

export const dynamic = 'force-dynamic'

/**
 * УМНЫЙ ИИ-ПОИСК — v5.21: два режима.
 *
 * 1) POST { q, category? } — одиночный вопрос (legacy, совместимость):
 *    дайджест свежих постов → ответ + карточки источников.
 * 2) POST { action:'chat', messages[] } — ЧАТ с инструментами (SSE):
 *    модель сама зовёт search_posts / read_post / get_trending,
 *    понимает контекст («где она», кто пользователь) и уточняющие вопросы.
 *
 * ЛИМИТЫ (режим q): free — 3/сутки; Plus/Pro — безлимит. Кэш 10 мин не списывает.
 * ЛИМИТЫ (чат): только авторизованные; free — 3/сутки (aiSearchLog на вопрос).
 * ТАРИФ (v5.39): сверх бесплатного лимита — ПО ТОКЕНАМ OpenRouter (usage):
 * цены за 1 млн входных/выходных токенов (lib/wallet.ts, env AI_MTOK_*_SWP);
 * лёгкий запрос ≈ 2–5 свайпов, тяжёлый — десятки. До вызова — проверка
 * худшего случая, после — списание по факту в BalanceLog.
 */

const chatSchema = z.object({
  action: z.literal('chat'),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(4000),
      }),
    )
    .min(1)
    .max(24),
})

const bodySchema = z.discriminatedUnion('action', [
  chatSchema,
  z.object({
    action: z.literal('ask').default('ask'),
    q: z.string().trim().min(3).max(300),
    category: z.string().trim().max(40).optional(),
  }),
])

const MAX_LOOP = 4

/** Сколько свежих постов читает модель (каждый обрезан до 320 символов) */
const DIGEST_LIMIT = 36
const SNIPPET_LEN = 320

type SearchPayload = {
  answer: string
  /** id постов-источников в порядке значимости */
  sourceIds: string[]
  /** Реальный token-usage вызова OpenRouter (для тарификации) */
  usage?: AiUsage | null
}

async function buildAnswer(
  q: string,
  categorySlug: string | undefined,
  onUsage?: (u: AiUsage) => void,
): Promise<SearchPayload> {
  const uc = usageCollector()
  const reportUsage = onUsage ?? uc.onUsage
  const since = new Date(Date.now() - 3 * 24 * 60 * 60_000)

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
    // egress (11-a): дайджесту нужны только тексты/счётчики — select вместо
    // include (ttsAudio/translations 220 постов больше не качаются впустую)
    select: {
      id: true,
      text: true,
      publishedAt: true,
      likesCount: true,
      reactionsTg: true,
      viewsCount: true,
      channel: { select: { id: true, title: true, username: true } },
    },
    orderBy: { publishedAt: 'desc' },
    take: 220,
  })

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

  const raw = await chatSimple(system, user, { maxTokens: 320, timeoutMs: 30_000, temperature: 0.2, onUsage: reportUsage })

  const m = raw.match(/SOURCES\s*:\s*([0-9,\s]+)/i)
  const answer = (m ? raw.slice(0, m.index) : raw).replace(/SOURCES\s*:[\s\S]*/i, '').trim()
  const idxs = (m?.[1] ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= scored.length)

  const sourceIds = idxs.slice(0, 6).map((n) => scored[n - 1]!.p.id)
  const finalIds = sourceIds.length > 0 ? sourceIds : scored.slice(0, 3).map((s) => s.p.id)

  return { answer, sourceIds: finalIds, usage: uc.acc.usage }
}

/** Единый 402 «не хватает свайпов» с тарифом по токенам */
function notEnoughSwipes(tier: string) {
  return NextResponse.json(
    {
      error: 'ai_search_limit',
      message:
        `Не хватает свайпов. ИИ тарифицируется по токенам: ${AI_MTOK_IN_SWP} свайпов за 1 млн входных ` +
        `+ ${AI_MTOK_OUT_SWP} за 1 млн выходных (обычный запрос ≈ 2–10 свайпов). ` +
        'Пополните баланс — свайпы купятся автоматически (1 ₽ = 500 свайпов).',
      tier,
    },
    { status: 402 },
  )
}

/** Посты-источники → PostDTO (валидные, активные каналы) */
async function sourcesDTO(ids: string[]) {
  if (ids.length === 0) return []
  const sourcePosts = await db.post.findMany({
    where: { id: { in: ids }, channel: { status: 'active' } },
    select: POST_LIST_SELECT,
  })
  const byId = new Map(sourcePosts.map((p) => [p.id, p]))
  const ordered = ids.map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => Boolean(p))
  return ordered.map((p) => postDTOFromRow(p, { liked: false, bookmarked: false, subscribed: false }))
}

export async function POST(request: Request) {
  const g = guardPublic(request, { limit: 12, windowMs: 60_000, bucket: 'ai-search' })
  if (!g.ok) return g.res

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('Опишите вопрос — от 3 символов')
    const d = parsed.data

    if (!openRouterEnabled()) return err('Snap Search временно недоступен', 503)

    /* ================= РЕЖИМ ЧАТА (SSE, инструменты) ================= */
    if (d.action === 'chat') {
      if (!g.uid) return err('Войдите через Telegram', 401)
      const uid = g.uid

      const allowance = await aiSearchAllowance(g.uid)
      // Платный режим (лимит исчерпан): проверяем худший случай ДО генерации —
      // списание будет ПОСЛЕ, по реальному usage OpenRouter
      const est = estimateAiSwipes(
        d.messages.reduce((a, m) => a + m.content.length, 0) + 800,
        1000 * 3, // до трёх вызовов в цепочке (инструменты + финал); по факту — дешевле
      )
      if (!allowance.allowed && !(await aiCanAfford(uid, est))) {
        return notEnoughSwipes(allowance.tier)
      }
      const paid = !allowance.allowed

      const user = await db.user.findUnique({
        where: { id: g.uid },
        select: { firstName: true, lastName: true, username: true },
      })
      const userName =
        [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() ||
        (user?.username ? `@${user.username}` : 'читатель')

      // v5.47: живая база знаний сервиса (тарифы/курс/розыгрыши/статистика)
      // — поиск отвечает и на вопросы о самом Tg Swipe
      const knowledge = await knowledgeBlock('compact').catch(() => undefined)
      const sys = searchSystemPrompt({ userName, tier: allowance.tier, knowledge })
      const history: ChatMsg[] = [
        { role: 'system', content: sys },
        ...d.messages.map((m) => ({ role: m.role, content: m.content }) as ChatMsg),
      ]
      const ctx: ToolCtx = { uid: g.uid, kind: 'search' }
      const meta: Record<string, unknown> = { steps: [], sourceIds: [] as string[] }
      const steps = meta.steps as Array<{ tool: string; label: string; ok: boolean }>
      const sourceIds = meta.sourceIds as string[]

      return sseStream(async (send) => {
        let messages = history
        const collector = usageCollector()
        // Списать по факту после цепочки (best-effort: ответ уже отдан)
        const settle = async () => {
          if (!paid) return
          await chargeAiUsage(uid, collector.acc.usage, 'Snap Search (чат)', est)
          if (collector.acc.usage) {
            send('paid', { swipes: swipesForUsage(collector.acc.usage) })
          }
        }
        try {
          for (let i = 0; i < MAX_LOOP; i++) {
            // v5.40: стриминг токенов — финальный ответ печатается в чате в реальном времени
            const r = await chatWithToolsStream(messages, schemasFor('search'), {
              maxTokens: 1000,
              timeoutMs: 60_000,
              temperature: 0.3,
              onUsage: collector.onUsage,
              onDelta: (chunk) => send('delta', { text: chunk }),
            })
            if (r.toolCalls.length === 0) {
              // v5.55: обрезанный лимитом ответ (finish_reason=length) дописываем
              let content = r.content || ''
              let finishReason = r.finishReason
              let cont = 0
              while (finishReason === 'length' && cont < 2) {
                cont++
                send('status', { tool: 'continue', label: 'Дописываю ответ…' })
                const more = await chatWithToolsStream(
                  [
                    ...messages,
                    { role: 'assistant', content },
                    {
                      role: 'user',
                      content:
                        '[система] Твой предыдущий ответ оборвался ровно на середине из-за лимита длины. Продолжи с места обрыва — без повторов написанного. Если текст логически завершён — просто закончи последнее предложение.',
                    },
                  ],
                  [],
                  {
                    maxTokens: 1000,
                    timeoutMs: 60_000,
                    temperature: 0.3,
                    onUsage: collector.onUsage,
                    onDelta: (chunk) => send('delta', { text: chunk }),
                  },
                )
                if (!more.content) break
                content += more.content
                finishReason = more.finishReason
                if (more.toolCalls.length > 0) break
              }
              const reply = await aiPremiumEmojiText(content || 'Не нашёл — переформулируйте вопрос.')
              const sources = await sourcesDTO(sourceIds.slice(0, 6))
              await settle()
              send('done', { reply, ...meta, sources })
              return
            }
            messages = [...messages, { role: 'assistant', content: r.content || '', toolCalls: r.toolCalls }]
            for (const call of r.toolCalls) {
              const def = toolBy(call.name, 'search')
              const label = def?.label ?? `Ищу: ${call.name}…`
              send('status', { tool: call.name, label })
              let args: Record<string, unknown> = {}
              try {
                args = JSON.parse(call.args || '{}') as Record<string, unknown>
              } catch {
                /* инструмент вернёт ошибку сам */
              }
              const res = def
                ? await def.exec(args, ctx).catch((e): ToolExecResult => ({ ok: false, data: `Ошибка инструмента: ${(e as Error).message}` }))
                : { ok: false, data: `Неизвестный инструмент: ${call.name}` }
              const ids = (res.meta?.sourceIds as string[] | undefined) ?? []
              for (const id of ids) if (!sourceIds.includes(id)) sourceIds.push(id)
              steps.push({ tool: call.name, label, ok: res.ok })
              messages = [
                ...messages,
                { role: 'tool', content: res.data.slice(0, 3000), toolCallId: call.id, name: call.name },
              ]
            }
          }
          // Цикл исчерпан — финальный ответ без инструментов
          const tail = await chatWithTools(
            [
              ...messages,
              { role: 'user', content: '[система] Больше не вызывай инструменты — ответь текстом по найденному.' },
            ],
            [],
            { maxTokens: 800, timeoutMs: 45_000, temperature: 0.3, onUsage: collector.onUsage },
          )
          const reply = await aiPremiumEmojiText(tail.content || 'Не нашёл — переформулируйте вопрос.')
          const sources = await sourcesDTO(sourceIds.slice(0, 6))
          await settle()
          send('done', { reply, ...meta, sources })
        } catch (e) {
          console.error('[ai/search chat]', e)
          // Токены уже потрачены на частичную цепочку — тарифицируем тоже
          await settle().catch(() => {})
          send('error', { message: openRouterErrorText(e) })
        }
      })
    }

    /* ================= Одиночный вопрос (legacy) ================= */
    // v5.54: режим требует сессию — раньше аноним получал бесплатную LLM-
    // генерацию без дневного лимита (расход OpenRouter), тормозил только
    // in-memory лимит 12/мин/инстанс. Чат и так требует вход.
    if (!g.uid) return err('Войдите через Telegram', 401)
    const q = 'q' in d ? d.q : ''
    const category = 'category' in d ? d.category : undefined

    // Лимит до генерации: free — 3/сутки; plus/pro — безлимит; сверх лимита — свайпы
    const allowance = await aiSearchAllowance(g.uid)
    if (allowance && !allowance.allowed) {
      return NextResponse.json(
        {
          error: 'ai_search_limit',
          message: 'Лимит Snap Search на сегодня исчерпан (3 в день)',
          tier: allowance.tier,
        },
        { status: 402 },
      )
    }

    // Кэш ответа: повтор того же запроса в 10 минутах НЕ списывает лимит и свайпы
    const cacheKey = `ais:${shortHash(`${q.toLowerCase()}|${category ?? ''}`)}`
    let payload = await cacheGet<SearchPayload>(cacheKey)
    let fromCache = true
    if (!payload) {
      // Свежая генерация сверх лимита — платно (по токенам), кэш-хит бесплатен
      const paid = Boolean(allowance && !allowance.allowed)
      const est = estimateAiSwipes(q.length + 12_500, 400) // дайджест ~36×320 симв + вопрос
      if (paid && g.uid && !(await aiCanAfford(g.uid, est))) {
        return notEnoughSwipes(allowance?.tier ?? 'free')
      }
      const collector = usageCollector()
      payload = await buildAnswer(q, category, collector.onUsage)
      fromCache = false
      if (paid && g.uid) await chargeAiUsage(g.uid, payload.usage ?? null, 'Snap Search', est)
      await cacheSet(cacheKey, payload, 600).catch(() => {})
      if (g.uid) {
        await db.aiSearchLog.create({ data: { userId: g.uid, query: q.slice(0, 300) } }).catch(() => {})
      }
    }

    const sources = await sourcesDTO(payload.sourceIds ?? [])

    let remaining: number | null = null
    if (allowance) {
      // v5.48: остаток считается ЛОКАЛЬНО — раньше здесь был повторный
      // aiSearchAllowance (+2 SQL: tier + count) на каждый запрос
      remaining = Number.isFinite(allowance.remaining)
        ? Math.max(0, allowance.remaining - (fromCache ? 0 : 1))
        : null
    }

    return NextResponse.json({
      answer: payload.answer,
      sources,
      remaining,
      cached: fromCache || undefined,
    })
  } catch (e) {
    console.error('[ai/search]', e)
    return err(openRouterErrorText(e), 502)
  }
}
