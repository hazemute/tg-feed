import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { chatSimple, chatWithTools, openRouterEnabled, type ChatMsg } from '@/lib/openrouter'
import { enVisualPrompt, pollinationsImageUrl, verifyImageUrl } from '@/lib/ai-image'
import { botPublishToChannel } from '@/lib/tg-bot'
import { tierAtLeast, tierOfUser } from '@/lib/tiers'
import { stripMarkdown } from '@/lib/markdown'
import { schemasFor, toolBy, type ToolExecResult, assistantSystemPrompt, type ToolCtx } from '@/lib/ai-tools'
import { sseStream } from '@/lib/sse'

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
async function analyzeStyle(channelId: string, username: string): Promise<StyleProfile> {
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
    { maxTokens: 300, timeoutMs: 30_000, temperature: 0.2 },
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

export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 20, windowMs: 60_000, bucket: 'ai-assistant' })
  if (!g.ok) return g.res

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('Некорректные данные')
    const d = parsed.data

    if (!openRouterEnabled() && d.action !== 'publish') {
      return err('ИИ-ассистент временно недоступен', 503)
    }

    const tier = await tierOfUser(g.uid)
    if (!tierAtLeast(tier, 'pro')) {
      return NextResponse.json(
        { error: 'pro_required', message: 'ИИ-ассистент доступен на тарифе Snap Pro' },
        { status: 402 },
      )
    }

    const channel = await db.channel.findUnique({ where: { id: d.channelId } })
    if (!channel || channel.claimedById !== g.uid) return err('Канал не привязан к вам', 403)

    /* ---------- Чат с инструментами (SSE) ---------- */
    if (d.action === 'chat') {
      registerStyleExecutor()
      const user = await db.user.findUnique({
        where: { id: g.uid },
        select: { firstName: true, lastName: true, username: true },
      })
      const userName =
        [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() ||
        (user?.username ? `@${user.username}` : 'автор канала')

      const weeklyUsed = await db.post.count({
        where: { channelId: channel.id, promotedAt: { gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) } },
      })

      const sys = assistantSystemPrompt({
        userName,
        tier,
        channelTitle: channel.title,
        channelUsername: channel.username,
        channelDescription: channel.description,
        categoryTitle: channel.categoryId ? null : null, // категория подтягивается в статистике
        style: styleFresh(channel),
        weeklyPromo: { used: weeklyUsed, limit: 7 },
      })

      const history: ChatMsg[] = [
        { role: 'system', content: sys },
        ...d.messages.map((m) => ({ role: m.role, content: m.content }) as ChatMsg),
      ]

      const ctx: ToolCtx = { uid: g.uid, kind: 'assistant', channelId: channel.id }
      const meta: Record<string, unknown> = { steps: [] }
      const steps = meta.steps as Array<{ tool: string; label: string; ok: boolean }>

      return sseStream(async (send) => {
        let messages = history
        try {
          for (let i = 0; i < MAX_LOOP; i++) {
            const r = await chatWithTools(messages, schemasFor('assistant'), {
              maxTokens: 1400,
              timeoutMs: 60_000,
              temperature: 0.6,
            })
            if (r.toolCalls.length === 0) {
              // Финальный ответ
              send('done', { reply: r.content || 'Готово!', ...meta, model: r.model })
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
            { maxTokens: 900, timeoutMs: 45_000, temperature: 0.6 },
          )
          send('done', { reply: tail.content || 'Готово!', ...meta })
        } catch (e) {
          console.error('[ai/assistant chat]', e)
          send('error', { message: 'Нейросеть не ответила — попробуйте ещё раз' })
        }
      })
    }

    /* ---------- Анализ стиля ---------- */
    if (d.action === 'style') {
      const profile = await analyzeStyle(channel.id, channel.username)
      await db.channel.update({
        where: { id: channel.id },
        data: { styleProfile: JSON.stringify(profile), styleAt: new Date() },
      })
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

      const text = await chatSimple(system, user, { maxTokens: 700, timeoutMs: 40_000, temperature: 0.75 })
      const clean = text.replace(/^["«»]+|["»]+$/g, '').trim()
      if (clean.length < 30) return err('Нейросеть вернула пустой пост — попробуйте ещё раз', 502)

      // v5.33: суть поста → английский визуальный промпт (бесплатная модель)
      // → бесплатный pollinations. И текст, и визуал — ноль рублей.
      const enPrompt = await enVisualPrompt(clean).catch(() => clean.slice(0, 220))
      const imageUrl = pollinationsImageUrl(enPrompt)
      const imageOk = await verifyImageUrl(imageUrl).catch(() => false)

      return NextResponse.json({
        text: clean,
        imageUrl: imageOk ? imageUrl : imageUrl,
        imagePending: !imageOk,
        styleAnalyzed,
      })
    }

    /* ---------- Публикация в реальный канал ---------- */
    const imageUrl = d.imageUrl && /^https:\/\//i.test(d.imageUrl) ? d.imageUrl : null
    if (imageUrl) {
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
