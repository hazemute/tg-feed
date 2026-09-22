import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { chatSimple, chatWithTools, chatWithToolsStream, openRouterEnabled, openRouterErrorText, type ChatMsg } from '@/lib/openrouter'
import { aiPremiumEmojiText } from '@/lib/ai-emoji'
import {
  AI_IMAGE_SWP,
  AI_MTOK_IN_SWP,
  AI_MTOK_OUT_SWP,
  aiCanAfford,
  chargeAiUsage,
  estimateAiSwipes,
  spendSwipes,
  swipesForUsage,
  usageCollector,
} from '@/lib/wallet'
import { generatePublicImage, verifyImageUrl } from '@/lib/ai-image'
import { SITE_URL } from '@/lib/site'
import { botPublishToChannel, getBotChatRights, getChatMemberCount } from '@/lib/tg-bot'
import { sweepScheduledPostsThrottled } from '@/lib/scheduled-posts'
import { tierAtLeast, tierOfUser } from '@/lib/tiers'
import { stripMarkdown } from '@/lib/markdown'
import { schemasFor, toolBy, type ToolExecResult, assistantSystemPrompt, type ToolCtx, channelStatsBlock, aiMemoryBlock, aiCrossChatBlock } from '@/lib/ai-tools'
import { knowledgeBlock } from '@/lib/ai-knowledge'
import { sseStream } from '@/lib/sse'


/** v5.73: best-effort сохранение пары «вопрос-ответ» в постоянную историю.
 *  v5.74: пишет в СЕССИЮ (AiChatMessage.sessionId) и двигает updatedAt сессии —
 *  список чатов сортируется по свежести; авто-титул из первого вопроса. */
async function persistAiTurn(
  uid: string,
  userText: string,
  reply: string,
  meta: Record<string, unknown>,
  channelId?: string,
  sessionId?: string | null,
): Promise<void> {
  try {
    const metaClean: Record<string, unknown> = { ...meta }
    delete metaClean.steps
    delete metaClean.sourceIds
    const metaJson = Object.keys(metaClean).length > 0 ? JSON.stringify(metaClean) : null
    await db.aiChatMessage.createMany({
      data: [
        { userId: uid, surface: 'assistant', channelId: channelId ?? null, role: 'user', content: userText.slice(0, 4000), meta: null, sessionId: sessionId ?? null },
        { userId: uid, surface: 'assistant', channelId: channelId ?? null, role: 'assistant', content: reply.slice(0, 8000), meta: metaJson, sessionId: sessionId ?? null },
      ],
    })
    if (sessionId) {
      const s = await db.aiChatSession.findUnique({ where: { id: sessionId }, select: { title: true } })
      if (s) {
        await db.aiChatSession.update({
          where: { id: sessionId },
          data: {
            updatedAt: new Date(),
            ...(s.title === 'Новый чат' && userText.trim() ? { title: userText.trim().slice(0, 60) } : {}),
          },
        })
      }
    }
    // Хвост истории ограничиваем (на всякий случай — 200 последних)
    const all = await db.aiChatMessage.findMany({
      where: { userId: uid, surface: 'assistant' },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { id: true },
    })
    if (all.length === 200) {
      await db.aiChatMessage.deleteMany({ where: { id: { in: all.map((x) => x.id) } , NOT: {} }, }).catch(() => {})
    }
  } catch {
    /* история — не критично */
  }
}

export const dynamic = 'force-dynamic'

/**
 * ИИ-АССИСТЕНТ канала (Snap Pro) — v5.21: полноценный ЧАТ с инструментами.
 *
 * Режимы POST { action }:
 *  - 'chat'     { channelId, messages[] } → SSE-поток: статусы инструментов,
 *                 финальный ответ, метаданные (draft/imageUrl/publishedLink).
 *                 Модель сама решает, какие инструменты вызвать
 *                 (create_post_draft / generate_image / publish_post /
 *                 get_channel_stats / get_trending / analyze_channel_style).
 *  - 'style'    { channelId }              → проанализировать стиль (30 постов)
 *  - 'generate' { channelId, prompt? }     → legacy: черновик текст + картинка
 *  - 'publish'  { channelId, text, imageUrl? } → опубликовать в TG-канал
 *
 * Требует тир Snap Pro у владельца канала (402 pro_required иначе).
 */

const MAX_LOOP = 4 // максимум последовательных вызовов инструментов
const MAX_HISTORY = 20 // сообщений истории от клиента

const chatSchema = z.object({
  action: z.literal('chat'),
  channelId: z.string().min(1),
  // v5.74: чат = сессия. null/undefined → сервер сам создаст «Новый чат»
  sessionId: z.string().max(64).nullish(),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(4000),
      }),
    )
    .min(1)
    .max(MAX_HISTORY),
})

const bodySchema = z.discriminatedUnion('action', [
  chatSchema,
  z.object({ action: z.literal('style'), channelId: z.string().min(1) }),
  z.object({
    action: z.literal('generate'),
    channelId: z.string().min(1),
    prompt: z.string().trim().max(300).optional(),
  }),
  z.object({
    action: z.literal('publish'),
    channelId: z.string().min(1),
    text: z.string().trim().min(10).max(3500),
    imageUrl: z.string().url().max(600).optional().nullable(),
  }),
])

type StyleProfile = { tone: string; topics: string; style: string; at: string }

const STYLE_TTL_DAYS = 7 // слепок стиля живёт неделю, потом пересканируем

/** Стиль канала: ещё живой? */
function styleFresh(ch: { styleProfile: string | null; styleAt: Date | null }): StyleProfile | null {
  if (!ch.styleProfile || !ch.styleAt) return null
  if (Date.now() - ch.styleAt.getTime() > STYLE_TTL_DAYS * 24 * 3600 * 1000) return null
  try {
    const p = JSON.parse(ch.styleProfile) as StyleProfile
    return p?.tone ? p : null
  } catch {
    return null
  }
}

/** Анализ стиля: 30 последних содержательных постов → цифровой слепок */
async function analyzeStyle(
  channelId: string,
  username: string,
  onUsage?: (u: { promptTokens: number; completionTokens: number; model?: string }) => void,
): Promise<StyleProfile> {
  const posts = await db.post.findMany({
    where: { channelId, text: { not: '' } },
    orderBy: { publishedAt: 'desc' },
    take: 30,
    select: { text: true },
  })
  const digest = posts
    .map((p, i) => `${i + 1}. ${stripMarkdown(p.text).replace(/\s+/g, ' ').slice(0, 280)}`)
    .join('\n')

  if (digest.length < 80) {
    return { tone: 'нейтральный', topics: 'общие темы канала', style: 'короткие посты, без сложного сленга', at: new Date().toISOString() }
  }

  const raw = await chatSimple(
    'Ты — аналитик контента. Тебе дают последние посты Telegram-канала. Оцени ТОН автора, его темы, ' +
      'манеру речи (сленг, эмодзи, длина постов, юмор/серьёзность). Ответь СТРОГО в формате:\n' +
      'TONE: <одной фразой>\nTOPICS: <через запятую, 3-6 тем>\nSTYLE: <2-3 фразы, как писать «как автор»>',
    digest,
    { maxTokens: 300, timeoutMs: 30_000, temperature: 0.2, onUsage },
  )
  const tone = raw.match(/TONE\s*:\s*(.+)/i)?.[1]?.trim() ?? 'нейтральный'
  const topics = raw.match(/TOPICS\s*:\s*(.+)/i)?.[1]?.trim() ?? 'тематика канала'
  const style = raw.match(/STYLE\s*:\s*([\s\S]+)/i)?.[1]?.trim() ?? 'короткие живые посты'

  return { tone, topics, style, at: new Date().toISOString() }
}

/** Инструмент analyze_channel_style ищет исполнитель через globalThis (реестр без циклических импортов) */
function registerStyleExecutor(): void {
  const g = globalThis as unknown as {
    __aiAnalyzeStyle?: (channelId: string) => Promise<{ tone: string; topics: string; style: string } | null>
  }
  g.__aiAnalyzeStyle = async (channelId: string) => {
    const ch = await db.channel.findUnique({ where: { id: channelId }, select: { username: true } })
    if (!ch) return null
    try {
      const p = await analyzeStyle(channelId, ch.username)
      await db.channel
        .update({ where: { id: channelId }, data: { styleProfile: JSON.stringify(p), styleAt: new Date() } })
        .catch(() => {})
      return { tone: p.tone, topics: p.topics, style: p.style }
    } catch {
      return null
    }
  }
}

/** Тренды ленты: топ-10 свежих постов за 3 дня по вовлечённости (legacy) */
async function trendingDigest(): Promise<string> {
  const since = new Date(Date.now() - 3 * 24 * 3600 * 1000)
  const posts = await db.post.findMany({
    where: { publishedAt: { gte: since }, OR: [{ aiFlag: null }, { aiFlag: 'ok' }] },
    orderBy: [{ likesCount: 'desc' }, { publishedAt: 'desc' }],
    take: 10,
    select: { text: true, likesCount: true, channel: { select: { title: true } } },
  })
  return posts
    .map((p, i) => {
      const t = stripMarkdown(p.text).replace(/\s+/g, ' ').slice(0, 160)
      return t ? `${i + 1}. (${p.channel.title}, ${p.likesCount} лайков) ${t}` : ''
    })
    .filter(Boolean)
    .join('\n')
}


/* ==================== v5.73: постоянная история чата ==================== *
 *  GET    — последние 50 сообщений СЕССИИ (v5.74: ?sessionId=…, без параметра —
 *           самая свежая сессия) для восстановления переписки на другом
 *           устройстве/после очистки localStorage.
 *  DELETE — ?sessionId=… → удалить этот чат; без параметра — все чаты
 *           поверхности (кнопка «очистить чат» синхронно стирает и тут).
 */
export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'ai-history' })
  if (!g.ok) return g.res
  try {
    const url = new URL(request.url)
    const channelId = url.searchParams.get('channelId')
    const sessionId = url.searchParams.get('sessionId')
    // Сессия: явная из параметра, иначе — самая свежая (продолжить последний чат).
    // Чужая/несуществующая сессия → пусто (не отдаём чужую переписку).
    let sid: string | null = null
    if (sessionId) {
      const own = await db.aiChatSession.findFirst({
        where: { id: sessionId, userId: g.uid, surface: 'assistant' },
        select: { id: true },
      })
      sid = own?.id ?? null
    } else {
      const latest = await db.aiChatSession.findFirst({
        where: { userId: g.uid, surface: 'assistant', ...(channelId ? { channelId } : {}) },
        orderBy: { updatedAt: 'desc' },
        select: { id: true },
      })
      sid = latest?.id ?? null
    }
    if (!sid) return NextResponse.json({ messages: [], sessionId: null })
    const rows = await db.aiChatMessage.findMany({
      where: { userId: g.uid, surface: 'assistant', sessionId: sid },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { role: true, content: true, meta: true, createdAt: true },
    })
    return NextResponse.json({
      sessionId: sid,
      messages: rows.reverse().map((r) => ({
        role: r.role,
        text: r.content,
        at: r.createdAt.toISOString(),
        ...(r.meta ? { meta: safeParseMeta(r.meta) } : {}),
      }))},
    )
  } catch {
    return err('Ошибка', 500)
  }
}

/** meta хранится JSON-строкой — мягкий парс (битая строка не роняет историю) */
function safeParseMeta(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export async function DELETE(request: Request) {
  const g = guardAuth(request, { limit: 20, windowMs: 60_000, bucket: 'ai-history' })
  if (!g.ok) return g.res
  try {
    const url = new URL(request.url)
    const channelId = url.searchParams.get('channelId')
    const sessionId = url.searchParams.get('sessionId')
    if (sessionId) {
      // v5.74: удаляем один чат (сессию владельца + её сообщения)
      const del = await db.aiChatSession.deleteMany({ where: { id: sessionId, userId: g.uid } })
      if (del.count > 0) {
        await db.aiChatMessage.deleteMany({ where: { sessionId, userId: g.uid } })
      }
      return NextResponse.json({ ok: true })
    }
    // Без sessionId — полная очистка: сессии поверхности + легаси-сообщения
    const own = await db.aiChatSession.findMany({
      where: { userId: g.uid, surface: 'assistant', ...(channelId ? { channelId } : {}) },
      select: { id: true },
    })
    const ids = own.map((x) => x.id)
    await db.aiChatMessage.deleteMany({
      where: {
        userId: g.uid,
        surface: 'assistant',
        ...(channelId ? { channelId } : {}),
        ...(ids.length > 0 ? { OR: [{ sessionId: { in: ids } }, { sessionId: null }] } : { sessionId: null }),
      },
    })
    await db.aiChatSession.deleteMany({ where: { id: { in: ids }, userId: g.uid } })
    return NextResponse.json({ ok: true })
  } catch {
    return err('Ошибка', 500)
  }
}

export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 20, windowMs: 60_000, bucket: 'ai-assistant' })
  if (!g.ok) return g.res

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('Некорректные данные')
    const d = parsed.data

    if (!openRouterEnabled() && d.action !== 'publish') {
      return err('Snap Ассистент временно недоступен', 503)
    }

    const tier = await tierOfUser(g.uid)
    if (!tierAtLeast(tier, 'pro')) {
      return NextResponse.json(
        { error: 'pro_required', message: 'Snap Ассистент доступен на тарифе Snap Pro' },
        { status: 402 },
      )
    }

    /* ТАРИФ (v5.39): свайпы за токены — проверяем ХУДШИЙ случай ДО генерации.
     * Списание — после ответа по реальному usage OpenRouter (chargeAiUsage);
     * публикация (publish) ИИ не вызывает и не тарифицируется. */
    if (d.action !== 'publish') {
      const est =
        d.action === 'chat'
          ? estimateAiSwipes(d.messages.reduce((a, m) => a + m.content.length, 0) + 1200, 4200)
          : d.action === 'style'
            ? estimateAiSwipes(9200, 320) // ~30 постов × 280 симв + промпт
            : estimateAiSwipes(2800, 1100) // generate: система+стиль+тренды + пост
      if (!(await aiCanAfford(g.uid, est))) {
        return NextResponse.json(
          {
            error: 'not_enough_swipes',
            message:
              `Не хватает свайпов для Snap Ассистента: тарификация по токенам (${AI_MTOK_IN_SWP} за 1 млн входных + ${AI_MTOK_OUT_SWP} за 1 млн выходных). ` +
              'Пополните баланс — свайпы купятся автоматически (1 ₽ = 500 свайпов).',
          },
          { status: 402 },
        )
      }
    }

    // select вместо полной строки (egress: avatarHash/membersFetchedAt и пр.
    // не нужны; styleProfile/styleAt нужны для styleFresh, username/description —
    // для системного промпта и анализа стиля)
    const channel = await db.channel.findUnique({
      where: { id: d.channelId },
      select: {
        id: true,
        title: true,
        username: true,
        description: true,
        categoryId: true,
        claimedById: true,
        styleProfile: true,
        styleAt: true,
      },
    })
    if (!channel || channel.claimedById !== g.uid) return err('Канал не привязан к вам', 403)

    /* ---------- Чат с инструментами (SSE) ---------- */
    if (d.action === 'chat') {
      registerStyleExecutor()
      // v5.64: заходим — подчищаем очередь отложенных постов (срок вышел → публикуем)
      sweepScheduledPostsThrottled()
      // Категория канала + юзер + полный снапшот статистики — параллельно (v5.34:
      // ассистент знает ВЕСЬ канал до первого вопроса — цифры, настройки, топ постов)
      const [channelFull, user, statsBlock, weeklyUsed, knowledge, memory] = await Promise.all([
        channel.categoryId
          ? db.channel.findUnique({
              where: { id: channel.id },
              select: {
                ctaLabel: true,
                ctaUrl: true,
                teaserMode: true,
                createdAt: true,
                category: { select: { title: true } },
              },
            })
          : Promise.resolve(null),
        db.user.findUnique({
          where: { id: g.uid },
          select: { firstName: true, lastName: true, username: true },
        }),
        channelStatsBlock(channel.id, channel.title, channel.claimedById).catch(() => null),
        db.post.count({
          where: { channelId: channel.id, promotedAt: { gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) } },
        }),
        // v5.47: живая база знаний сервиса — ассистент знает ВСЁ приложение,
        // а не только свой канал (тарифы, свайпы, розыгрыши, лимиты)
        knowledgeBlock('full').catch(() => undefined),
        aiMemoryBlock(g.uid).catch(() => ''),
      ])
      // v5.74: ГЛОБАЛЬНАЯ ПАМЯТЬ ЧАТОВ — свежие сообщения из других чатов
      // пользователя: новый чат продолжает прошлые разговоры без пересказа
      const crossChat = await aiCrossChatBlock(g.uid, d.sessionId ?? null).catch(() => '')

      // v5.74: сессия чата — валидируем переданную или создаём «Новый чат».
      // Чужая/несуществующая сессия молча превращается в новую (не 500 — чат должен работать).
      let session: { id: string; created: boolean } | null = null
      if (d.sessionId) {
        const own = await db.aiChatSession.findFirst({
          where: { id: d.sessionId, userId: g.uid, surface: 'assistant' },
          select: { id: true },
        })
        if (own) session = { id: own.id, created: false }
      }
      if (!session) {
        const created = await db.aiChatSession
          .create({
            data: {
              userId: g.uid,
              surface: 'assistant',
              channelId: channel.id,
              title: (d.messages.find((m) => m.role === 'user')?.content ?? 'Новый чат').trim().slice(0, 60) || 'Новый чат',
            },
            select: { id: true },
          })
          .catch(() => null)
        if (created) session = { id: created.id, created: true }
      }
      const userName =
        [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() ||
        (user?.username ? `@${user.username}` : 'автор канала')

      // v5.64: ЖИВОЙ СРЕЗ TELEGRAM в системном промпте — реальные подписчики (Bot API)
      // и матрица прав бота. Оба вызова закэшированы (память 15-60 мин) — почти бесплатно.
      // Ассистент СРАЗУ знает реальное состояние канала в самом Telegram,
      // а не только цифры ленты приложения.
      const [liveMembers, botRights] = await Promise.all([
        getChatMemberCount(channel.username).catch(() => null),
        getBotChatRights(channel.username).catch(() => null),
      ])
      const liveLines: string[] = []
      if (liveMembers != null) liveLines.push(`Реальные подписчики в Telegram прямо сейчас: ${liveMembers}`)
      if (botRights) liveLines.push(`Права бота в канале: ${botRights.rightsText}`)
      const liveBlock = liveLines.length > 0 ? `\n=== TELEGRAM ЖИВЬЁМ (Bot API) ===\n${liveLines.join('\n')}\n=== конец живого среза ===` : ''
      const statsFull = statsBlock ? statsBlock + liveBlock : liveBlock.trim() || null

      const sys = assistantSystemPrompt({
        userName,
        tier,
        channelTitle: channel.title,
        channelUsername: channel.username,
        channelDescription: channel.description,
        categoryTitle: channelFull?.category?.title ?? null,
        style: styleFresh(channel),
        weeklyPromo: { used: weeklyUsed, limit: 7 },
        statsBlock: statsFull,
        cta: { label: channelFull?.ctaLabel ?? null, url: channelFull?.ctaUrl ?? null },
        teaserMode: channelFull?.teaserMode ?? 'cut',
        createdAt: channelFull?.createdAt ?? null,
        knowledge,
        memory,
        ...(crossChat ? { crossChat } : {}),
      })

      const history: ChatMsg[] = [
        { role: 'system', content: sys },
        ...d.messages.map((m) => ({ role: m.role, content: m.content }) as ChatMsg),
      ]

      const ctx: ToolCtx = { uid: g.uid, kind: 'assistant', channelId: channel.id }
      const lastUserText = [...d.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
      const meta: Record<string, unknown> = { steps: [] }
      const steps = meta.steps as Array<{ tool: string; label: string; ok: boolean }>

      return sseStream(async (send) => {
        // v5.74: сразу отдаём id сессии — клиент запомнит чат в истории
        if (session) send('session', { sessionId: session.id })
        let messages = history
        // Тарификация: копим токены всей цепочки (модель + финальный вызов),
        // списываем по факту после ответа — как в Snap Search
        const collector = usageCollector()
        const settle = async () => {
          // v5.85: показываем РЕАЛЬНО списанную сумму (с множителем тира)
          const charged = await chargeAiUsage(g.uid, collector.acc.usage, 'Snap Ассистент', 12)
          if (collector.acc.usage) send('paid', { swipes: charged || swipesForUsage(collector.acc.usage) })
        }
        try {
          for (let i = 0; i < MAX_LOOP; i++) {
            // v5.40: стриминг токенов — ответ печатается в чате в реальном времени
            const r = await chatWithToolsStream(messages, schemasFor('assistant'), {
              maxTokens: 2000,
              timeoutMs: 60_000,
              temperature: 0.6,
              onUsage: collector.onUsage,
              onDelta: (chunk) => send('delta', { text: chunk }),
            })
            if (r.toolCalls.length === 0) {
              // v5.55: ответ, ОБРЕЗАННЫЙ лимитом токенов (finish_reason=length),
              // дописываем продолжениями — «обрез чата» больше не показывается юзеру
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
                        '[система] Твой предыдущий ответ оборвался ровно на середине из-за лимита длины. Продолжи с места обрыва — без повторов написанного, без приветствий и заголовков «Продолжение». Если текст логически завершён — просто закончи последнее предложение.',
                    },
                  ],
                  [],
                  {
                    maxTokens: 1400,
                    timeoutMs: 60_000,
                    temperature: 0.6,
                    onUsage: collector.onUsage,
                    onDelta: (chunk) => send('delta', { text: chunk }),
                  },
                )
                if (!more.content) break
                content += more.content
                finishReason = more.finishReason
                if (more.toolCalls.length > 0) break
              }
              // Финальный ответ (+ премиум-эмодзи из слотов бота)
              const reply = await aiPremiumEmojiText(content || 'Готово!')
              await settle()
              void persistAiTurn(g.uid, lastUserText, reply, meta, channel.id, session?.id ?? null)
              send('done', { reply, ...meta, model: r.model, sessionId: session?.id ?? null })
              return
            }
            // Эхо вызова + статусы + исполнение
            messages = [
              ...messages,
              { role: 'assistant', content: r.content || '', toolCalls: r.toolCalls },
            ]
            for (const call of r.toolCalls) {
              const def = toolBy(call.name, 'assistant')
              const label = def?.label ?? `Вызываю ${call.name}…`
              send('status', { tool: call.name, label })
              let args: Record<string, unknown> = {}
              try {
                args = JSON.parse(call.args || '{}') as Record<string, unknown>
              } catch {
                /* аргументы битые — инструмент сам вернёт ошибку */
              }
              const res = def
                ? await def.exec(args, ctx).catch((e): ToolExecResult => ({ ok: false, data: `Ошибка инструмента: ${(e as Error).message}` }))
                : { ok: false, data: `Неизвестный инструмент: ${call.name}` }
              if (res.meta) {
                if (res.meta.draftText) meta.draftText = res.meta.draftText
                if (res.meta.draftTopic) meta.draftTopic = res.meta.draftTopic
                if (res.meta.imageUrl) meta.imageUrl = res.meta.imageUrl
                if (res.meta.imagePending !== undefined) meta.imagePending = res.meta.imagePending
                if (res.meta.publishedLink) meta.publishedLink = res.meta.publishedLink
                if (res.meta.inviteLink) meta.inviteLink = res.meta.inviteLink
                if (res.meta.scheduledAt) meta.scheduledAt = res.meta.scheduledAt
              }
              steps.push({ tool: call.name, label, ok: res.ok })
              messages = [
                ...messages,
                {
                  role: 'tool',
                  content: res.data.slice(0, 3000),
                  toolCallId: call.id,
                  name: call.name,
                },
              ]
            }
          }
          // Цикл исчерпан — просим финальный ответ без инструментов
          const tail = await chatWithTools(
            [
              ...messages,
              {
                role: 'user',
                content: '[система] Инструментов больше не вызывай — дай финальный ответ текстом.',
              },
            ],
            [],
            { maxTokens: 900, timeoutMs: 45_000, temperature: 0.6, onUsage: collector.onUsage },
          )
          const reply = await aiPremiumEmojiText(tail.content || 'Готово!')
          await settle()
          void persistAiTurn(g.uid, lastUserText, reply, meta, channel.id, session?.id ?? null)
          send('done', { reply, ...meta, sessionId: session?.id ?? null })
        } catch (e) {
          console.error('[ai/assistant chat]', e)
          // v5.74: «ИИ не ответил — свайпы не снимаем». Токены могли частично
          // уйти в провайдер, но ответа пользователь НЕ получил — тарифицируем
          // только успешные ответы (settle вызывается перед send('done')).
          send('error', { message: openRouterErrorText(e) })
        }
      })
    }

    /* ---------- Анализ стиля ---------- */
    if (d.action === 'style') {
      const collector = usageCollector()
      const profile = await analyzeStyle(channel.id, channel.username, collector.onUsage)
      await db.channel.update({
        where: { id: channel.id },
        data: { styleProfile: JSON.stringify(profile), styleAt: new Date() },
      })
      await chargeAiUsage(g.uid, collector.acc.usage, 'Snap Ассистент (стиль)', 4)
      return NextResponse.json({ ok: true, profile })
    }

    /* ---------- Генерация черновика (legacy — быстрый путь без чата) ---------- */
    if (d.action === 'generate') {
      let style = styleFresh(channel)
      let styleAnalyzed = false
      if (!style) {
        style = await analyzeStyle(channel.id, channel.username)
        await db.channel
          .update({
            where: { id: channel.id },
            data: { styleProfile: JSON.stringify(style), styleAt: new Date() },
          })
          .catch(() => {})
        styleAnalyzed = true
      }

      const trends = await trendingDigest()
      const promptLine = d.prompt ? `\nДополнительное указание автора: ${d.prompt}` : ''

      const system =
        'Ты — личный ИИ-контентщик Telegram-канала. Пишешь НОВЫЙ пост от лица автора в его стиле. ' +
        'Правила: язык — русский; длина 300–900 символов; markdown-lite: **жирный**, __курсив__, #хэштеги, ' +
        'эмодзи уместно (как автор); без выдуманных фактов и цифр — либо общая мысль, либо опора на тренды; ' +
        'без канальных штампов («подпишись», «читать в источнике»); законченная мысль, живой тон. ' +
        'Ответь ТОЛЬКО текстом поста, без пояснений и кавычек.'
      const user =
        `Стиль автора: тон — ${style.tone}; темы — ${style.topics}; манера — ${style.style}\n` +
        `Канал: «${channel.title}»${channel.description ? ` (${channel.description.slice(0, 140)})` : ''}\n` +
        (trends ? `\nСвежие тренды ленты (можно опереться на одну тему):\n${trends}\n` : '') +
        promptLine

      const collector = usageCollector()
      const text = await chatSimple(system, user, { maxTokens: 700, timeoutMs: 40_000, temperature: 0.75, onUsage: collector.onUsage })
      const clean = text.replace(/^["«»]+|["»]+$/g, '').trim()
      if (clean.length < 30) {
        // v5.74: пустой пост = ответа нет — НЕ тарифицируем
        return err('Нейросеть вернула пустой пост — попробуйте ещё раз', 502)
      }
      await chargeAiUsage(g.uid, collector.acc.usage, 'Snap Ассистент (пост)', 8)

      // v5.33: суть поста → английский визуальный промпт (бесплатная модель)
      // → бесплатный pollinations. И текст, и визуал — ноль рублей.
      // v5.70: байты скачиваются сервером, сжимаются в WebP ≤350КБ и хранятся
      // в Upload → клиенту отдаётся стабильный /api/upload/<id> (фолбэк —
      // сырая ссылка pollinations, если скачать/сохранить не удалось)
      // v5.74: картинка тарифицируется (AI_IMAGE_SWP) ТОЛЬКО при успехе;
      // сервис не ответил — списания нет
      const img = await generatePublicImage(clean, { ownerId: g.uid }).catch(() => null)
      if (img?.url) {
        await spendSwipes(g.uid, AI_IMAGE_SWP, `Генерация картинки (пост): ${clean.slice(0, 80)}`).catch(() => {})
      }

      return NextResponse.json({
        text: clean,
        imageUrl: img?.url ?? null,
        imagePending: img?.pending ?? true,
        styleAnalyzed,
      })
    }

    /* ---------- Публикация в реальный канал ---------- */
    // v5.70: принимаем и наш /api/upload/<id> (абсолютизируем через SITE_URL —
    // Telegram качает файл по https сам). Свой immutable-URL, созданный только
    // что, проверять HEAD'ом не нужно — проверяем только внешние ссылки
    const rawUrl = d.imageUrl ?? ''
    const imageUrl = /^https:\/\//i.test(rawUrl)
      ? rawUrl
      : rawUrl.startsWith('/api/upload/')
        ? `${SITE_URL}${rawUrl}`
        : null
    if (imageUrl && !imageUrl.startsWith(SITE_URL)) {
      const ok = await verifyImageUrl(imageUrl).catch(() => false)
      if (!ok) {
        return NextResponse.json({
          ok: false,
          publishedWithoutImage: true,
          error: 'Картинка не готова — отправьте ещё раз без картинки или подождите',
        })
      }
    }

    const r = await botPublishToChannel(channel.username, d.text, imageUrl)
    if (!r.ok) {
      return NextResponse.json({
        ok: false,
        error:
          r.error ??
          'Не удалось опубликовать: добавьте бота администратором канала с правом публикации',
      })
    }
    return NextResponse.json({ ok: true, link: r.link })
  } catch (e) {
    console.error('[ai/assistant]', e)
    return err('Ошибка ассистента — попробуйте ещё раз', 500)
  }
}
