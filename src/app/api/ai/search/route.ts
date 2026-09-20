import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardPublic } from '@/lib/guard'
import { cacheGet, cacheSet, shortHash } from '@/lib/redis'
import { getNsfwChannelIds } from '@/lib/moderation'
import { looksLikeGarbage } from '@/lib/text-clean'
import { stripMarkdown } from '@/lib/markdown'
import { chatSimple, chatWithTools, openRouterEnabled, openRouterErrorText, type ChatMsg } from '@/lib/openrouter'
import { aiSearchAllowance } from '@/lib/tiers'
import { POST_LIST_SELECT, postDTOFromRow } from '@/lib/dto'
import { schemasFor, toolBy, type ToolExecResult, searchSystemPrompt, type ToolCtx } from '@/lib/ai-tools'
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
}

async function buildAnswer(q: string, categorySlug: string | undefined): Promise<SearchPayload> {
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

  const raw = await chatSimple(system, user, { maxTokens: 320, timeoutMs: 30_000, temperature: 0.2 })

  const m = raw.match(/SOURCES\s*:\s*([0-9,\s]+)/i)
  const answer = (m ? raw.slice(0, m.index) : raw).replace(/SOURCES\s*:[\s\S]*/i, '').trim()
  const idxs = (m?.[1] ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= scored.length)

  const sourceIds = idxs.slice(0, 6).map((n) => scored[n - 1]!.p.id)
  const finalIds = sourceIds.length > 0 ? sourceIds : scored.slice(0, 3).map((s) => s.p.id)

  return { answer, sourceIds: finalIds }
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

    if (!openRouterEnabled()) return err('ИИ-поиск временно недоступен', 503)

    /* ================= РЕЖИМ ЧАТА (SSE, инструменты) ================= */
    if (d.action === 'chat') {
      if (!g.uid) return err('Войдите через Telegram', 401)

      const allowance = await aiSearchAllowance(g.uid)
      if (!allowance.allowed) {
        return NextResponse.json(
          {
            error: 'ai_search_limit',
            message: 'Лимит ИИ-поиска на сегодня исчерпан (3 в день)',
            tier: allowance.tier,
          },
          { status: 402 },
        )
      }

      const user = await db.user.findUnique({
        where: { id: g.uid },
        select: { firstName: true, lastName: true, username: true },
      })
      const userName =
        [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() ||
        (user?.username ? `@${user.username}` : 'читатель')

      const sys = searchSystemPrompt({ userName, tier: allowance.tier })
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
        try {
          for (let i = 0; i < MAX_LOOP; i++) {
            const r = await chatWithTools(messages, schemasFor('search'), {
              maxTokens: 1000,
              timeoutMs: 60_000,
              temperature: 0.3,
            })
            if (r.toolCalls.length === 0) {
              const sources = await sourcesDTO(sourceIds.slice(0, 6))
              send('done', { reply: r.content || 'Не нашёл — переформулируйте вопрос.', ...meta, sources })
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
            { maxTokens: 800, timeoutMs: 45_000, temperature: 0.3 },
          )
          const sources = await sourcesDTO(sourceIds.slice(0, 6))
          send('done', { reply: tail.content || 'Не нашёл — переформулируйте вопрос.', ...meta, sources })
        } catch (e) {
          console.error('[ai/search chat]', e)
          send('error', { message: openRouterErrorText(e) })
        }
      })
    }

    /* ================= Одиночный вопрос (legacy) ================= */
    const q = 'q' in d ? d.q : ''
    const category = 'category' in d ? d.category : undefined

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
      if (g.uid) {
        await db.aiSearchLog.create({ data: { userId: g.uid, query: q.slice(0, 300) } }).catch(() => {})
      }
    }

    const sources = await sourcesDTO(payload.sourceIds ?? [])

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
    return err(openRouterErrorText(e), 502)
  }
}
