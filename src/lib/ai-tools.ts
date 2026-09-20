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

/**
 * ПОЛНЫЙ СНАПШОТ КАНАЛА (v5.34): вся статистика привязанного канала одним
 * Promise.all — посты, просмотры (24ч/всего), лайки, комментарии, закладки,
 * подписчики, динамика за 7 дней, топ-5 постов, продвижения, настройки.
 * Кладётся в системный промпт ассистента: модель ЗНАЕТ канал до первого
 * вопроса и не обязана тратить вызов инструмента на базовые цифры.
 */
export async function channelStatsBlock(
  channelId: string,
  channelTitle: string,
  ownerId: string | null,
  withTopPosts = true,
): Promise<string> {
  const now = Date.now()
  const since24h = new Date(now - 24 * 3_600_000)
  const since7d = new Date(now - 7 * 24 * 3_600_000)

  const [ch, postsTotal, agg, comments, bookmarks, subs, views24h, posts7d, likes7d, promo7d, lastPost, top] =
    await Promise.all([
      db.channel.findUnique({
        where: { id: channelId },
        select: { membersCount: true, subscribersCount: true },
      }),
      db.post.count({ where: { channelId } }),
      db.post.aggregate({
        where: { channelId },
        _sum: { likesCount: true, viewsCount: true },
        _avg: { likesCount: true, viewsCount: true },
      }),
      db.comment.count({ where: { post: { channelId } } }),
      db.bookmark.count({ where: { post: { channelId } } }),
      db.subscription.count({ where: { channelId, hidden: false } }),
      // Инкогнито (Snap Plus/Pro): просмотры юзеров с активным платным тиром
      // не видны в детальной статистике — фильтр совпадает с lib/tiers
      db.postView.count({
        where: {
          post: { channelId },
          createdAt: { gte: since24h },
          user: { OR: [{ tier: 'free' }, { tierUntil: { lte: new Date() } }] },
        },
      }),
      db.post.count({ where: { channelId, publishedAt: { gte: since7d } } }),
      db.like.count({ where: { post: { channelId }, createdAt: { gte: since7d } } }),
      db.post.count({ where: { channelId, promotedAt: { gte: since7d } } }),
      db.post.findFirst({
        where: { channelId },
        orderBy: { publishedAt: 'desc' },
        select: { publishedAt: true },
      }),
      withTopPosts
        ? db.post.findMany({
            where: { channelId },
            orderBy: [{ likesCount: 'desc' }, { viewsCount: 'desc' }],
            take: 5,
            select: { text: true, likesCount: true, viewsCount: true, publishedAt: true },
          })
        : Promise.resolve([]),
    ])

  const lines = [
    `Канал «${channelTitle}», полная статистика:`,
    `- постов всего: ${postsTotal}`,
    `- просмотры: всего ${agg._sum.viewsCount ?? 0} · за 24ч ${views24h} · среднее на пост ${Math.round(agg._avg.viewsCount ?? 0)}`,
    `- лайки: всего ${agg._sum.likesCount ?? 0} · за 7 дней ${likes7d} · среднее на пост ${(agg._avg.likesCount ?? 0).toFixed(1)}`,
    `- комментарии: ${comments} · закладки: ${bookmarks}`,
    `- подписчики: Telegram ${ch?.membersCount ?? ch?.subscribersCount ?? '—'} · в приложении ${subs}`,
    `- за 7 дней: новых постов ${posts7d}, продвижений ${promo7d}`,
    lastPost
      ? `- последний пост: ${lastPost.publishedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`
      : '- постов ещё нет',
  ]
  if (top.length > 0) {
    lines.push('- топ постов по лайкам:')
    for (const p of top) {
      const t = stripMarkdown(p.text).replace(/\s+/g, ' ').slice(0, 90)
      lines.push(`  · [${p.publishedAt.toISOString().slice(0, 10)}, ${p.likesCount}♥, ${p.viewsCount}👁] ${t || 'медиа-пост'}`)
    }
  }
  if (ownerId) {
    const owner = await db.user
      .findUnique({
        where: { id: ownerId },
        select: { balanceKop: true, swipes: true, tier: true, tierUntil: true },
      })
      .catch(() => null)
    if (owner) {
      // v5.39: кошелёк живёт на пользователе (эскроу рекламодателя — легаси)
      lines.push(`- кошелёк: ${(owner.balanceKop / 100).toFixed(2)} ₽ · ${owner.swipes} свайпов`)
      const active = owner.tierUntil && owner.tierUntil.getTime() > Date.now()
      lines.push(active ? `- тариф ${owner.tier} (до ${owner.tierUntil!.toISOString().slice(0, 10)})` : `- тариф: ${owner.tier}`)
    }
  }
  return lines.join('\n')
}

/** Статистика канала ассистента — «свежий срез» поверх снапшота в системном промпте */
const getChannelStats: ToolDef = {
  name: 'get_channel_stats',
  label: 'Собираю статистику канала…',
  description:
    'Свежая статистика канала: посты, просмотры, лайки, комментарии, закладки, подписчики, ' +
    'динамика за 7 дней, топ-5 постов. Основные цифры уже есть в системном промпте — вызывай, ' +
    'когда нужны САМЫЕ свежие данные или глубокий разбор (топ постов, вовлечённость).',
  parameters: { type: 'object', properties: {} },
  exec: async (_args, ctx) => {
    if (!ctx.channelId) return { ok: false, data: 'Ошибка: канал не привязан.' }
    const ch = await db.channel.findUnique({ where: { id: ctx.channelId }, select: { title: true, claimedById: true } })
    if (!ch) return { ok: false, data: 'Ошибка: канал не найден.' }
    const block = await channelStatsBlock(ctx.channelId, ch.title, ch.claimedById, true)
    return { ok: true, data: block }
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
    'Генерирует иллюстрацию к посту. Придумай ПОДРОБНЫЙ визуальный промпт НА АНГЛИЙСКОМ ' +
    '(60–400 символов): конкретный сюжет и объект, окружение/фон, художественный стиль ' +
    '(photo/illustration/3D/flat), освещение, цветовую палитру, ракурс/композицию, настроение. ' +
    'БЕЗ текста, букв и надписей на картинке, без водяных знаков. ' +
    'Промпт должен быть понятнее и богаче, чем сформулировал автор. ' +
    'Результат появится в чате картинкой. Используй, когда автор просит картинку/обложку/иллюстрацию.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Подробный английский визуальный промпт (60–400 символов)' },
    },
    required: ['prompt'],
  },
  exec: async (args, ctx) => {
    const prompt = str(args.prompt, 500)
    if (prompt.length < 10) return { ok: false, data: 'Ошибка: промпт слишком короткий.' }
    const { generatePublicImage } = await import('@/lib/ai-image')
    // v5.34: промпт модели дополнительно раскрывается в детальную английскую
    // визуальную сцену (enVisualPrompt) → бесплатный pollinations/flux
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
    'Ты — Snap Search — умный поиск внутри Telegram Mini App «Tg Swipe» — умная лента Telegram-каналов.',
    'Ты помогаешь читателю находить посты и понимать, что происходит в ленте.',
    `Сегодня: ${now.toISOString().slice(0, 10)} (${WEEKDAYS_RU[now.getDay()]}), ${now.toISOString().slice(11, 16)} UTC. Пользователь: ${ctx.userName}, тариф: ${ctx.tier}.`,
    '',
    'КАК РАБОТАТЬ:',
    '1. Для ЛЮБОГО вопроса о содержании постов сначала вызывай search_posts (вопрос → ключевые слова). Затем при необходимости read_post для деталей.',
    '2. Отвечай ТОЛЬКО по найденным постам — не выдумывай факты. Если постов нет — честно скажи и предложи другую формулировку.',
    '3. Формат ответа (как в ChatGPT): markdown, 2-8 строк по делу — заголовки ### только при уместности, **жирный** для ключевых мыслей, списки «- », при сравнениях — таблицы. В конце перечисли источники строкой «Источники: @username, @username».',
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
  /** ПОЛНЫЙ снапшот канала (v5.34): вся статистика/настройки — модель знает канал сразу */
  statsBlock: string | null
  cta: { label: string | null; url: string | null }
  teaserMode: string
  /** Возраст канала в приложении */
  createdAt: Date | null
}): string {
  const now = new Date()
  const age = ctx.createdAt
    ? `в ленте с ${ctx.createdAt.toISOString().slice(0, 10)}`
    : ''
  return [
    'Ты — Snap Ассистент — личный ИИ-ассистент автора Telegram-канала внутри Telegram Mini App «Tg Swipe».',
    'Ты помогаешь придумывать посты, рисовать картинки к ним, смотреть статистику канала и публиковать готовые посты.',
    `Сегодня: ${now.toISOString().slice(0, 10)} (${WEEKDAYS_RU[now.getDay()]}). Автор: ${ctx.userName}, тариф: ${ctx.tier}.`,
    `Канал автора: «${ctx.channelTitle}» (@${ctx.channelUsername})${ctx.categoryTitle ? `, категория: ${ctx.categoryTitle}` : ''}${age ? `, ${age}` : ''}${ctx.channelDescription ? `. Описание: ${ctx.channelDescription.slice(0, 160)}` : ''}.`,
    ctx.cta.label && ctx.cta.url
      ? `CTA-кнопка в постах: «${ctx.cta.label}» → ${ctx.cta.url}.`
      : 'CTA-кнопка в постах не настроена (можешь посоветовать, если уместно).',
    `Режим тизеров постов: ${ctx.teaserMode === 'none' ? 'показ целиком' : ctx.teaserMode === 'cut' ? 'обрезка по лимиту' : 'блюр-заглушка'}.`,
    ctx.style
      ? `Стиль автора (проанализирован): тон — ${ctx.style.tone}; темы — ${ctx.style.topics}; манера — ${ctx.style.style}.`
      : 'Стиль автора ещё не проанализирован — при необходимости вызови analyze_channel_style.',
    `Продвижения в ленте на этой неделе: ${ctx.weeklyPromo.used}/${ctx.weeklyPromo.limit}.`,
    '',
    ctx.statsBlock
      ? `=== ДАННЫЕ КАНАЛА (уже собраны, вызывать get_channel_stats для базовых цифр НЕ нужно) ===\n${ctx.statsBlock}\n=== конец данных канала ===`
      : 'Статистика канала сейчас недоступна — при вопросах про цифры вызови get_channel_stats.',
    '',
    'КАК РАБОТАТЬ:',
    '1. Просьба «напиши пост…» → продумай текст в стиле автора и вызови create_post_draft (в text — готовый пост). Затем коротко скажи, что готово, и предложи доработки.',
    '2. Просьба про картинку/обложку/иллюстрацию → вызови generate_image с подробным английским промптом (сюжет, окружение, стиль, свет, палитра, композиция).',
    '3. Явная просьба «опубликуй» → если текст ещё не показан, покажи его в ответе и вызови publish_post.',
    '4. Вопросы про цифры → отвечай ИЗ данных канала выше; нужен самый свежий срез или топ постов → get_channel_stats; «что сейчас в тренде» → get_trending.',
    '5. Дай совет по каналу, если автор просит «что улучшить» — опирайся на реальные цифры (вовлечённость, динамика 7 дней, топ посты).',
    '6. Обычное общение — без инструментов, дружелюбно и кратко. Пиши по-русски (или на языке автора).',
    '7. Формат ответов КАК В CHATGPT: markdown с заголовками ##/### при уместности, **жирный**, списки «- », нумерованные шаги, таблицы для сравнений, ```блоки кода``` для кода. Уместно используй эмодзи (🎉🔥✨⚡💡) — они отображаются премиум-анимациями. Без выдуманных фактов и цифр.',
  ].join('\n')
}
