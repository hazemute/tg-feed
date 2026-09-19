import { db } from '@/lib/db'
import { stripMarkdown } from '@/lib/markdown'
import { looksLikeGarbage } from '@/lib/text-clean'
import type { ToolSchema } from '@/lib/openrouter'

/**
 * ИНСТРУМЕНТЫ ИИ (v5.21): нейросеть сама решает, когда и какой инструмент
 * вызвать (нативный function calling + текстовый JSON-фолбэк — см. openrouter).
 * Никаких скриптовых команд от пользователя: «напиши пост про кофе и нарисуй
 * картинку» → модель зовёт create_post_draft и generate_image.
 *
 * Каждый инструмент несёт label — человекочитаемый статус для UI («думаю»).
 */

/* ============================ общие типы ============================ */

export type ToolExecResult = {
  ok: boolean
  /** Компактный результат для модели (строкой в role:'tool') */
  data: string
  /** Доп. данные для UI: ссылки, черновики, источники */
  meta?: Record<string, unknown>
}

export type ToolCtx = {
  uid: string
  /** Режим: assistant — владелец канала, search — читатель */
  kind: 'assistant' | 'search'
  /** id канала ассистента (только kind=assistant) */
  channelId?: string
}

export type ToolDef = {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
  exec: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<ToolExecResult>
}

const str = (v: unknown, max = 400): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : ''
const num = (v: unknown, def: number, min: number, max: number): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : def
}

/* ============================ общие инструменты ============================ */

/** Свежие посты ленты — дайджест для ассистента и поиска */
async function trendingPosts(hours: number, limit: number) {
  const since = new Date(Date.now() - hours * 3_600_000)
  const posts = await db.post.findMany({
    where: { publishedAt: { gte: since }, OR: [{ aiFlag: null }, { aiFlag: 'ok' }] },
    orderBy: [{ likesCount: 'desc' }, { publishedAt: 'desc' }],
    take: limit * 3,
    select: {
      id: true,
      text: true,
      likesCount: true,
      viewsCount: true,
      publishedAt: true,
      channel: { select: { title: true, username: true } },
    },
  })
  return posts
    .filter((p) => stripMarkdown(p.text).trim().length >= 40 && !looksLikeGarbage(p.text))
    .slice(0, limit)
}

/** Тренды ленты (оба режима) */
const getTrending: ToolDef = {
  name: 'get_trending',
  label: 'Смотрю тренды ленты…',
  description:
    'Возвращает топ свежих постов ленты Tg Swipe за последние N часов (по умолчанию 72): ' +
    'текст (обрезан), канал, лайки. Используй, чтобы узнать, что сейчас обсуждают, ' +
    'найти актуальные темы для поста или ответить на вопрос «что нового».',
  parameters: {
    type: 'object',
    properties: {
      hours: { type: 'number', description: 'Окно в часах: 24–168. По умолчанию 72.' },
      limit: { type: 'number', description: 'Сколько постов вернуть: 1–10. По умолчанию 8.' },
    },
  },
  exec: async (args) => {
    const rows = await trendingPosts(num(args.hours, 72, 24, 168), num(args.limit, 8, 1, 10))
    if (rows.length === 0) return { ok: true, data: 'За это время трендовых постов нет.' }
    const data = rows
      .map((p, i) => {
        const t = stripMarkdown(p.text).replace(/\s+/g, ' ').slice(0, 200)
        return `${i + 1}. [${p.channel.title} (@${p.channel.username}), ${p.likesCount}♥, id=${p.id}] ${t}`
      })
      .join('\n')
    return { ok: true, data }
  },
}

/** Полнотекстовый поиск по постам (режим поиска). Дialect-независимо:
 *  кандидаты берутся свежим срезом, ключевыЕ слова фильтруются в JS —
 *  case-insensitive одинаково работает и на Postgres, и на SQLite. */
const searchPosts: ToolDef = {
  name: 'search_posts',
  label: 'Ищу по постам…',
  description:
    'Полнотекстовый поиск по постам каналов в ленте (последние 14 дней). ' +
    'Возвращает до 8 подходящих постов: текст (обрезан), канал, дату, id. ' +
    'Используй для ЛЮБОГО вопроса о содержании постов — вопрос пользователя превращай в 2-4 ключевых слова.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Поисковая фраза: ключевые слова вопроса.' },
    },
    required: ['query'],
  },
  exec: async (args) => {
    const q = str(args.query, 120)
    if (!q) return { ok: false, data: 'Ошибка: пустой запрос.' }
    const since = new Date(Date.now() - 14 * 24 * 3_600_000)
    const rows = await db.post.findMany({
      where: {
        publishedAt: { gte: since },
        OR: [{ aiFlag: null }, { aiFlag: 'ok' }],
        channel: { status: 'active' },
      },
      orderBy: [{ likesCount: 'desc' }, { publishedAt: 'desc' }],
      take: 400,
      select: {
        id: true,
        text: true,
        likesCount: true,
        publishedAt: true,
        channel: { select: { title: true, username: true } },
      },
    })
    const words = q.toLowerCase().split(/\s+/).filter((w) => w.length >= 2).slice(0, 5)
    const hits = words.length
      ? rows.filter((p) => {
          const t = p.text.toLowerCase()
          return words.every((w) => t.includes(w))
        })
      : []
    // Мягкий фолбэк: хотя бы ОДНО слово (частичный релеванс лучше пустоты)
    const partial = hits.length === 0 && words.length > 1
      ? rows.filter((p) => {
          const t = p.text.toLowerCase()
          return words.some((w) => t.includes(w))
        })
      : []
    const picked = (hits.length > 0 ? hits : partial)
      .slice(0, 8)
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
    if (picked.length === 0) return { ok: true, data: 'Ничего не найдено за последние 14 дней. Попробуй другие ключевые слова.' }
    const data = picked
      .map((p, i) => {
        const d = p.publishedAt.toISOString().slice(0, 10)
        const t = stripMarkdown(p.text).replace(/\s+/g, ' ').slice(0, 260)
        return `${i + 1}. [${p.channel.title} (@${p.channel.username}), ${d}, ${p.likesCount}♥, id=${p.id}] ${t}`
      })
      .join('\n')
    return {
      ok: true,
      data,
      meta: { sourceIds: picked.map((r) => r.id) },
    }
  },
}

/** Полный текст конкретного поста */
const readPost: ToolDef = {
  name: 'read_post',
  label: 'Читаю пост целиком…',
  description:
    'Возвращает ПОЛНЫЙ текст поста по его id (id берётся из результатов get_trending/search_posts). ' +
    'Используй, когда короткого фрагмента недостаточно.',
  parameters: {
    type: 'object',
    properties: { postId: { type: 'string', description: 'id поста' } },
    required: ['postId'],
  },
  exec: async (args) => {
    const id = str(args.postId, 64)
    if (!id) return { ok: false, data: 'Ошибка: не передан postId.' }
    const p = await db.post.findUnique({
      where: { id },
      select: {
        id: true,
        text: true,
        publishedAt: true,
        likesCount: true,
        channel: { select: { title: true, username: true, status: true } },
      },
    })
    if (!p || p.channel.status !== 'active') return { ok: true, data: 'Пост не найден или канал неактивен.' }
    return {
      ok: true,
      data: `[${p.channel.title} (@${p.channel.username}), ${p.publishedAt.toISOString().slice(0, 10)}, ${p.likesCount}♥]\n${stripMarkdown(p.text).slice(0, 2200)}`,
      meta: { sourceIds: [p.id] },
    }
  },
}

/* ============================ инструменты ассистента ============================ */

/** Статистика канала ассистента */
const getChannelStats: ToolDef = {
  name: 'get_channel_stats',
  label: 'Собираю статистику канала…',
  description:
    'Статистика канала пользователя: посты, просмотры, лайки, подписчики, продвижения за неделю. ' +
    'Вызывай, когда спрашивают про динамику/цифры канала или нужно оценить, о чём пишут чаще.',
  parameters: { type: 'object', properties: {} },
  exec: async (_args, ctx) => {
    if (!ctx.channelId) return { ok: false, data: 'Ошибка: канал не привязан.' }
    const since7 = new Date(Date.now() - 7 * 24 * 3_600_000)
    const [postsTotal, agg, subs, promo] = await Promise.all([
      db.post.count({ where: { channelId: ctx.channelId } }),
      db.post.aggregate({
        where: { channelId: ctx.channelId },
        _sum: { likesCount: true, viewsCount: true },
        _avg: { likesCount: true },
      }),
      db.subscription.count({ where: { channelId: ctx.channelId, hidden: false } }),
      db.post.count({ where: { channelId: ctx.channelId, promotedAt: { gte: since7 } } }),
    ])
    const ch = await db.channel.findUnique({
      where: { id: ctx.channelId },
      select: { membersCount: true, subscribersCount: true, title: true },
    })
    const data =
      `Канал «${ch?.title ?? ''}»:\n` +
      `- постов всего: ${postsTotal}\n` +
      `- просмотров (локальные): ${agg._sum.viewsCount ?? 0}\n` +
      `- лайков всего: ${agg._sum.likesCount ?? 0} (среднее на пост: ${(agg._avg.likesCount ?? 0).toFixed(1)})\n` +
      `- подписчиков: ${ch?.membersCount ?? ch?.subscribersCount ?? subs}\n` +
      `- продвижений за 7 дней: ${promo}/7`
    return { ok: true, data }
  },
}

/** Создание черновика поста (модель сама пишет текст и передаёт его инструменту) */
const createPostDraft: ToolDef = {
  name: 'create_post_draft',
  label: 'Пишу пост…',
  description:
    'ОФОРМЛЯЕТ черновик поста канала: создай готовый текст поста по просьбе автора (в его стиле, ' +
    'по-русски, 300–900 символов, markdown-lite: **жирный**, __курсив__, эмодзи уместно, #хэштеги) ' +
    'и передай его в аргументе text. После вызова автор увидит кнопку «Опубликовать». ' +
    'Не добавляй пояснений вокруг — в text только текст поста.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Полный готовый текст поста' },
      topic: { type: 'string', description: 'О чём пост (1 фраза, для превью)' },
    },
    required: ['text'],
  },
  exec: async (args) => {
    const text = str(args.text, 4000)
    if (text.length < 30) return { ok: false, data: 'Ошибка: текст поста слишком короткий (минимум 30 символов) — напиши полноценный пост.' }
    if (text.length > 3600) return { ok: false, data: 'Ошибка: текст длиннее 3600 символов — сократи.' }
    return {
      ok: true,
      data: 'Черновик создан и показан автору. Скажи автору, что пост готов, и предложи доработки или публикацию.',
      meta: { draftText: text, topic: str(args.topic, 120) },
    }
  },
}

/** Генерация картинки (бесплатный pollinations.ai, ноль рублей — v5.33) */
const generateImage: ToolDef = {
  name: 'generate_image',
  label: 'Рисую картинку…',
  description:
    'Генерирует иллюстрацию к посту. Придумай ПОДРОБНЫЙ визуальный промпт на английском ' +
    '(стиль, композиция, настроение, цвета; без текста и надписей на картинке). ' +
    'Результат появится в чате картинкой. Используй, когда автор просит картинку/обложку/иллюстрацию.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Английский визуальный промпт (40–400 символов)' },
    },
    required: ['prompt'],
  },
  exec: async (args, ctx) => {
    const prompt = str(args.prompt, 500)
    if (prompt.length < 10) return { ok: false, data: 'Ошибка: промпт слишком короткий.' }
    const { generatePublicImage } = await import('@/lib/ai-image')
    // v5.33: картинка — только бесплатный pollinations (суть промпта уходит
    // на английский той же бесплатной моделью); второй аргумент больше не нужен
    const img = await generatePublicImage(prompt)
    if (!img.url) return { ok: false, data: 'Картинка не сгенерировалась — сервис недоступен. Продолжай без неё.' }
    return {
      ok: true,
      data: `Картинка готова: ${img.url}`,
      meta: { imageUrl: img.url, imagePending: img.pending },
    }
  },
}

/** Публикация поста в реальный Telegram-канал */
const publishPost: ToolDef = {
  name: 'publish_post',
  label: 'Публикую в канал…',
  description:
    'ПУБЛИКУЕТ пост в Telegram-канал автора. Вызывай ТОЛЬКО когда автор явно попросил опубликовать ' +
    'и текст готов (аргумент text — готовый текст; imageUrl — если картинка была сгенерирована ' +
    'раньше в этом диалоге). Перед публикацией покажи текст в ответе.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Готовый текст поста' },
      imageUrl: { type: 'string', description: 'https-URL картинки (если есть в диалоге)' },
    },
    required: ['text'],
  },
  exec: async (args, ctx) => {
    const text = str(args.text, 4000)
    if (!ctx.channelId) return { ok: false, data: 'Ошибка: канал не привязан.' }
    if (text.length < 10) return { ok: false, data: 'Ошибка: текст поста слишком короткий.' }
    const imageUrlRaw = str(args.imageUrl, 600)
    const imageUrl = /^https:\/\//i.test(imageUrlRaw) ? imageUrlRaw : null
    const ch = await db.channel.findUnique({ where: { id: ctx.channelId }, select: { username: true } })
    if (!ch) return { ok: false, data: 'Ошибка: канал не найден.' }
    const { botPublishToChannel } = await import('@/lib/tg-bot')
    const r = await botPublishToChannel(ch.username, text, imageUrl).catch(() => ({ ok: false as const, error: 'Ошибка Bot API' }))
    if (!r.ok) return { ok: false, data: `Не удалось опубликовать: ${'error' in r && r.error ? r.error : 'добавь бота администратором канала с правом публикации'}.` }
    return {
      ok: true,
      data: `Опубликовано: ${'link' in r && r.link ? r.link : 'успешно'}`,
      meta: { publishedLink: 'link' in r && r.link ? r.link : null },
    }
  },
}

/** Анализ стиля канала (пересканировать) */
const analyzeStyleTool: ToolDef = {
  name: 'analyze_channel_style',
  label: 'Изучаю стиль канала…',
  description:
    'Анализирует последние 30 постов канала и обновляет слепок стиля автора (тон, темы, манера). ' +
    'Вызывай, если автор просит «учитай мой стиль заново» или перед важным постом.',
  parameters: { type: 'object', properties: {} },
  exec: async (_args, ctx) => {
    if (!ctx.channelId) return { ok: false, data: 'Ошибка: канал не привязан.' }
    // Реализация живёт в роуте ассистента (замкнута на analyzeStyle)
    const exec = (globalThis as { __aiAnalyzeStyle?: (channelId: string) => Promise<{ tone: string; topics: string; style: string } | null> })
      .__aiAnalyzeStyle
    if (!exec) return { ok: false, data: 'Анализ стиля временно недоступен.' }
    const profile = await exec(ctx.channelId).catch(() => null)
    if (!profile) return { ok: false, data: 'Не удалось проанализировать стиль — постов слишком мало.' }
    return { ok: true, data: `Стиль обновлён: тон — ${profile.tone}; темы — ${profile.topics}; манера — ${profile.style}` }
  },
}

/* ============================ реестры ============================ */

const SEARCH_TOOLS: ToolDef[] = [getTrending, searchPosts, readPost]
const ASSISTANT_TOOLS: ToolDef[] = [getTrending, getChannelStats, createPostDraft, generateImage, publishPost, analyzeStyleTool]

export function toolsFor(kind: ToolCtx['kind']): ToolDef[] {
  return kind === 'assistant' ? ASSISTANT_TOOLS : SEARCH_TOOLS
}

/** OpenRouter-схемы инструментов */
export function schemasFor(kind: ToolCtx['kind']): ToolSchema[] {
  return toolsFor(kind).map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

export function toolBy(name: string, kind: ToolCtx['kind']): ToolDef | undefined {
  return toolsFor(kind).find((t) => t.name === name)
}

/* ============================ системные промпты ============================ */

const WEEKDAYS_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота']

export function searchSystemPrompt(ctx: {
  userName: string
  tier: string
}): string {
  const now = new Date()
  return [
    'Ты — умный ИИ-поиск внутри Telegram Mini App «Tg Swipe» — умная лента Telegram-каналов.',
    'Ты помогаешь читателю находить посты и понимать, что происходит в ленте.',
    `Сегодня: ${now.toISOString().slice(0, 10)} (${WEEKDAYS_RU[now.getDay()]}), ${now.toISOString().slice(11, 16)} UTC. Пользователь: ${ctx.userName}, тариф: ${ctx.tier}.`,
    '',
    'КАК РАБОТАТЬ:',
    '1. Для ЛЮБОГО вопроса о содержании постов сначала вызывай search_posts (вопрос → ключевые слова). Затем при необходимости read_post для деталей.',
    '2. Отвечай ТОЛЬКО по найденным постам — не выдумывай факты. Если постов нет — честно скажи и предложи другую формулировку.',
    '3. Формат ответа: markdown, 2-6 строк, по делу; можешь использовать **жирный** и списки. В конце перечисли источники строкой «Источники: @username, @username».',
    '4. Общие вопросы («как дела», «что ты умеешь») отвечай без инструментов, коротко и дружелюбно.',
    '5. Язык ответа = язык вопроса (по умолчанию русский).',
  ].join('\n')
}

export function assistantSystemPrompt(ctx: {
  userName: string
  tier: string
  channelTitle: string
  channelUsername: string
  channelDescription: string | null
  categoryTitle: string | null
  style: { tone: string; topics: string; style: string } | null
  weeklyPromo: { used: number; limit: number }
}): string {
  const now = new Date()
  return [
    'Ты — личный ИИ-ассистент автора Telegram-канала внутри Telegram Mini App «Tg Swipe».',
    'Ты помогаешь придумывать посты, рисовать картинки к ним, смотреть статистику канала и публиковать готовые посты.',
    `Сегодня: ${now.toISOString().slice(0, 10)} (${WEEKDAYS_RU[now.getDay()]}). Автор: ${ctx.userName}, тариф: ${ctx.tier}.`,
    `Канал автора: «${ctx.channelTitle}» (@${ctx.channelUsername})${ctx.categoryTitle ? `, категория: ${ctx.categoryTitle}` : ''}${ctx.channelDescription ? `. Описание: ${ctx.channelDescription.slice(0, 160)}` : ''}.`,
    ctx.style
      ? `Стиль автора (проанализирован): тон — ${ctx.style.tone}; темы — ${ctx.style.topics}; манера — ${ctx.style.style}.`
      : 'Стиль автора ещё не проанализирован — при необходимости вызови analyze_channel_style.',
    `Продвижения в ленте на этой неделе: ${ctx.weeklyPromo.used}/${ctx.weeklyPromo.limit}.`,
    '',
    'КАК РАБОТАТЬ:',
    '1. Просьба «напиши пост…» → продумай текст в стиле автора и вызови create_post_draft (в text — готовый пост). Затем коротко скажи, что готово, и предложи доработки.',
    '2. Просьба про картинку/обложку/иллюстрацию → вызови generate_image с подробным английским промптом.',
    '3. Явная просьба «опубликуй» → если текст ещё не показан, покажи его в ответе и вызови publish_post.',
    '4. Вопросы про цифры канала → get_channel_stats; «что сейчас в тренде» → get_trending.',
    '5. Обычное общение — без инструментов, дружелюбно и кратко. Пиши по-русски (или на языке автора).',
    '6. Markdown в ответах: **жирный**, списки, коротко. Без выдуманных фактов и цифр.',
  ].join('\n')
}
