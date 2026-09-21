import { db } from '@/lib/db'
import { spendSwipes, AI_IMAGE_SWP } from '@/lib/wallet'
import { stripMarkdown } from '@/lib/markdown'
import { looksLikeGarbage } from '@/lib/text-clean'
import { getNsfwChannelIds } from '@/lib/moderation'
import type { ToolSchema } from '@/lib/openrouter'
import { getAiKnowledge } from '@/lib/ai-knowledge'
import { SITE_URL } from '@/lib/site'

/**
 * /api/upload/<id> → абсолютный https (Telegram качает файл сам —
 * sendPhoto/setChatPhoto не понимают относительные пути).
 * Паттерн из живого канала (api/channel/live absoluteMediaUrl).
 */
function absoluteImageUrl(u: string): string | null {
  if (/^https:\/\//i.test(u)) return u
  if (u.startsWith('/api/upload/')) return `${SITE_URL}${u}`
  return null
}

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
    // визуальную сцену (enVisualPrompt) → бесплатный pollinations/flux.
    // v5.70: байты скачиваются сервером и сохраняются в Upload → наш вечный
    // URL /api/upload/<id> (фолбэк — сырая ссылка pollinations, если не вышло)
    const img = await generatePublicImage(prompt, { ownerId: ctx.uid })
    if (!img.url) return { ok: false, data: 'Картинка не сгенерировалась — сервис недоступен. Продолжай без неё.' }
    // v5.74: картинка — платная (AI_IMAGE_SWP), но ЧЕСТНО: списываем только
    // при успешной генерации. Не вышло у сервиса — пользователь не платит.
    await spendSwipes(ctx.uid, AI_IMAGE_SWP, `Генерация картинки (ИИ): ${prompt.slice(0, 80)}`).catch(() => {})
    return {
      ok: true,
      data:
        `Картинка готова и УЖЕ ПОКАЗАНА автору картинкой под сообщением. Ссылку в текст ответа НЕ вставляй — ` +
        `автор видит картинку автоматически. Если будешь публиковать пост или менять аватар — передай этот URL без изменений: ${img.url}` +
        ` (списано ${AI_IMAGE_SWP} свайпов за генерацию).`,
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
      imageUrl: { type: 'string', description: 'URL картинки из диалога (https или /api/upload/… — передавай ровно как дал generate_image)' },
    },
    required: ['text'],
  },
  exec: async (args, ctx) => {
    const text = str(args.text, 4000)
    if (!ctx.channelId) return { ok: false, data: 'Ошибка: канал не привязан.' }
    if (text.length < 10) return { ok: false, data: 'Ошибка: текст поста слишком короткий.' }
    const imageUrlRaw = str(args.imageUrl, 600)
    // v5.70: принимаем и наш /api/upload/<id> (абсолютизируем через SITE_URL —
    // Telegram скачивает файл по https сам), и внешние https-ссылки
    const imageUrl = absoluteImageUrl(imageUrlRaw)
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

/* ============================ управление каналом (v5.58) ============================ */

/** Список последних постов канала — подготовка к удалению/ревизии («полный цикл модерации») */
const listMyPosts: ToolDef = {
  name: 'list_my_posts',
  label: 'Просматриваю посты канала…',
  description:
    'Последние посты канала автора (id, дата, просмотры, начало текста). Вызывай ПЕРЕД удалением: ' +
    '«удали пост про X» → сначала list_my_posts, покажи кандидатов списком, уточни у автора, ' +
    'потом удаляй через delete_posts (только после явного подтверждения).',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Сколько постов показать (по умолчанию 10, максимум 30)' },
    },
  },
  exec: async (args, ctx) => {
    if (!ctx.channelId) return { ok: false, data: 'Ошибка: канал не привязан.' }
    const limitRaw = typeof args.limit === 'number' ? args.limit : 10
    const limit = Math.min(Math.max(Math.round(limitRaw) || 10, 1), 30)
    const posts = await db.post.findMany({
      where: { channelId: ctx.channelId },
      orderBy: { publishedAt: 'desc' },
      take: limit,
      select: { id: true, tgKey: true, text: true, viewsCount: true, publishedAt: true },
    })
    if (posts.length === 0) return { ok: true, data: 'У канала пока нет постов в ленте Tg Swipe.' }
    const data = posts
      .map((p, i) => {
        const preview = stripMarkdown(p.text).replace(/\s+/g, ' ').trim().slice(0, 90) || 'медиа-пост'
        return `${i + 1}. id=${p.id} | ${p.publishedAt.toISOString().slice(0, 10)} | ${p.viewsCount} просм. — ${preview}`
      })
      .join('\n')
    return { ok: true, data }
  },
}

/**
 * Удаление постов по id (в Telegram + из ленты Tg Swipe). Модель обязана
 * сначала показать кандидатов (list_my_posts) и получить ЯВНОЕ подтверждение.
 */
const deletePosts: ToolDef = {
  name: 'delete_posts',
  label: 'Удаляю посты…',
  description:
    'УДАЛЯЕТ посты канала: и в Telegram (если бот админ), и из ленты Tg Swipe. Параметр postIds — ' +
    'массив id из list_my_posts. ВАЖНО: сначала найди посты (list_my_posts), покажи их автору ' +
    'и удаляй ТОЛЬКО после явного подтверждения («да, удали»). Без подтверждения НЕ вызывай.',
  parameters: {
    type: 'object',
    properties: {
      postIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Массив id постов из list_my_posts (1–20 штук)',
      },
    },
    required: ['postIds'],
  },
  exec: async (args, ctx) => {
    if (!ctx.channelId) return { ok: false, data: 'Ошибка: канал не привязан.' }
    const raw = Array.isArray(args.postIds) ? args.postIds : []
    const ids = raw.filter((v): v is string => typeof v === 'string' && v.length > 0).slice(0, 20)
    if (ids.length === 0) return { ok: false, data: 'Ошибка: не переданы id постов.' }
    const ch = await db.channel.findUnique({
      where: { id: ctx.channelId },
      select: { username: true, claimedById: true },
    })
    if (!ch) return { ok: false, data: 'Ошибка: канал не найден.' }
    // Удаляем только посты ЭТОГО канала (защита от чужих id)
    const posts = await db.post.findMany({
      where: { id: { in: ids }, channelId: ctx.channelId },
      select: { id: true, tgKey: true },
    })
    if (posts.length === 0) return { ok: false, data: 'Посты с такими id не найдены в канале.' }

    // 1) Telegram: удаляем оригинальные сообщения (bot admin — best effort)
    const { botDeleteChannelMessage } = await import('@/lib/tg-bot')
    let tgDeleted = 0
    for (const p of posts) {
      const messageId = Number(p.tgKey.split(':')[1])
      if (Number.isFinite(messageId) && messageId > 0) {
        const r = await botDeleteChannelMessage(ch.username, messageId).catch(() => ({ ok: false as const }))
        if (r.ok) tgDeleted++
      }
    }

    // 2) БД: пост исчезает из ленты Tg Swipe (каскад сотрёт лайки/закладки/комментарии)
    const del = await db.post.deleteMany({ where: { id: { in: posts.map((p) => p.id) } } })

    return {
      ok: true,
      data:
        `Удалено постов: ${del.count} из ленты Tg Swipe` +
        (tgDeleted > 0 ? `, ${tgDeleted} — также из Telegram-канала` : '') +
        (tgDeleted < del.count
          ? '. Часть постов не удалена в самом Telegram — добавь бота администратором канала с правом удаления сообщений.'
          : '') +
        '. Скажи автору, сколько постов удалено.',
    }
  },
}

/**
 * Смена названия/описания/аватара канала (в Telegram + карточке в Tg Swipe).
 * Аватар — по https-URL картинки (можно сгенерировать generate_image).
 */
const updateChannelInfo: ToolDef = {
  name: 'update_channel_info',
  label: 'Обновляю канал…',
  description:
    'Меняет НАЗВАНИЕ, ОПИСАНИЕ и/или АВАТАРА канала — и в Telegram, и в карточке ленты. ' +
    'Передавай только то, что попросил автор (title/description/avatarUrl). Смена названия/аватара — ' +
    'серьёзный шаг: покажи итоговый вариант и убедись, что автор подтвердил. avatarUrl — URL картинки ' +
    '(https или /api/upload/… — можно взять из generate_image, передавай без изменений).',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Новое название канала (2–128 символов)' },
      description: { type: 'string', description: 'Новое описание канала (до 255 символов)' },
      avatarUrl: { type: 'string', description: 'URL новой аватарки (https или /api/upload/… из generate_image)' },
    },
  },
  exec: async (args, ctx) => {
    if (!ctx.channelId) return { ok: false, data: 'Ошибка: канал не привязан.' }
    const ch = await db.channel.findUnique({
      where: { id: ctx.channelId },
      select: { username: true, title: true, description: true, avatarUrl: true },
    })
    if (!ch) return { ok: false, data: 'Ошибка: канал не найден.' }

    const title = str(args.title, 200)
    const description = str(args.description, 600)
    const avatarUrlRaw = str(args.avatarUrl, 600)
    // v5.70: /api/upload/<id> от generate_image тоже годится — абсолютизируем
    // для Bot API (setChatPhoto качает файл по https) и храним абсолютным
    const avatarUrl = absoluteImageUrl(avatarUrlRaw)
    if (!title && !description && !avatarUrl) {
      return { ok: false, data: 'Ошибка: передай хотя бы одно поле (title/description/avatarUrl).' }
    }
    if (title && title.length < 2) return { ok: false, data: 'Ошибка: название слишком короткое.' }

    const { botSetChatTitle, botSetChatDescription, botSetChatPhoto } = await import('@/lib/tg-bot')
    const results: string[] = []
    let dbTitle = ch.title
    let dbDesc = ch.description
    let dbAvatar = ch.avatarUrl

    if (title) {
      const r = await botSetChatTitle(ch.username, title).catch(() => ({ ok: false as const, error: 'Ошибка Bot API' }))
      if (r.ok) {
        dbTitle = title
        results.push(`название → «${title}» (Telegram + лента)`)
      } else {
        // Telegram отказал (нет прав) — карточку ленты всё равно обновляем
        dbTitle = title
        results.push(`название → «${title}» (в ленте; в Telegram не вышло: ${r.error ?? 'нет прав'} — добавь бота админом с правом change_channel_info)`)
      }
    }
    if (description) {
      const r = await botSetChatDescription(ch.username, description).catch(() => ({ ok: false as const, error: 'Ошибка Bot API' }))
      if (r.ok) {
        dbDesc = description
        results.push('описание обновлено (Telegram + лента)')
      } else {
        dbDesc = description
        results.push(`описание обновлено в ленте; в Telegram не вышло (${r.error ?? 'нет прав'})`)
      }
    }
    if (avatarUrl) {
      const r = await botSetChatPhoto(ch.username, avatarUrl).catch(() => ({ ok: false as const, error: 'Ошибка Bot API' }))
      if (r.ok) {
        dbAvatar = avatarUrl
        results.push('аватар обновлён (Telegram + лента)')
      } else {
        results.push(`аватар в Telegram не обновился (${r.error ?? 'ошибка'}); попробуй другую картинку`)
      }
    }

    // Карточка канала в ленте Tg Swipe (клиентские кэши короткоживущие —
    // обновлённая карточка появится при следующем запросе сама)
    await db.channel.update({
      where: { id: ctx.channelId },
      data: {
        ...(title ? { title: dbTitle } : {}),
        ...(description ? { description: dbDesc } : {}),
        ...(dbAvatar ? { avatarUrl: dbAvatar } : {}),
      },
    })
    return { ok: true, data: `Готово: ${results.join('; ')}.` }
  },
}

/* ============================ живой аудит Telegram (v5.64) ============================ */

/**
 * ПОЛНЫЙ АУДИТ КАНАЛА ИЗ САМОГО TELEGRAM (через бота, не из ленты трендов!):
 * getChat (название/описание), getChatMemberCount (реальные подписчики),
 * getChatAdministrators (админы), getChatMember(bot) — матрица прав бота,
 * + реальные просмотры/реакции Telegram (viewsTg/reactionsTg из парсера t.me)
 * + база ленты приложения. Модель получает СЫРЫЕ цифры и пишет оценку.
 */
const auditTelegramChannel: ToolDef = {
  name: 'audit_telegram_channel',
  label: 'Провожу живой аудит канала через Telegram…',
  description:
    'ЖИВОЙ АУДИТ канала прямо из Telegram через бота (НЕ из ленты приложения): реальные подписчики ' +
    'Bot API, название/описание в самом Telegram, список админов, права бота (что реально можно делать), ' +
    'реальные просмотры/реакции свежих постов, частота публикаций. ' +
    'Вызывай на «оцени канал», «дай аудит», «что улучшить», «как канал» — и пиши развёрнутую оценку: ' +
    'оформление, контент-ритм, вовлечённость (ER), сильные стороны и 3-5 конкретных шагов роста.',
  parameters: { type: 'object', properties: {} },
  exec: async (_args, ctx) => {
    if (!ctx.channelId) return { ok: false, data: 'Ошибка: канал не привязан.' }
    const ch = await db.channel.findUnique({
      where: { id: ctx.channelId },
      select: { username: true, title: true, membersCount: true, createdAt: true },
    })
    if (!ch) return { ok: false, data: 'Ошибка: канал не найден.' }

    const { getChatInfo, getChatMemberCount, getChatAdmins, getBotChatRights } = await import('@/lib/tg-bot')
    // Bot API: всё параллельно, отказы — не фатал (аудит собирается из того, что доступно)
    const [tgChat, liveMembers, admins, rights, recent, postsTotal] = await Promise.all([
      getChatInfo(ch.username).catch(() => null),
      getChatMemberCount(ch.username).catch(() => null),
      getChatAdmins(ch.username).catch(() => null),
      getBotChatRights(ch.username).catch(() => null),
      db.post.findMany({
        where: { channelId: ctx.channelId },
        orderBy: { publishedAt: 'desc' },
        take: 20,
        select: { viewsTg: true, reactionsTg: true, viewsCount: true, likesCount: true, publishedAt: true },
      }),
      db.post.count({ where: { channelId: ctx.channelId } }),
    ])

    const lines: string[] = ['=== ЖИВОЙ АУДИТ TELEGRAM-КАНАЛА (Bot API, данные из самого Telegram) ===']
    lines.push(`Канал: «${tgChat?.title ?? ch.title}» (@${ch.username})`)
    if (tgChat) {
      lines.push(
        tgChat.description
          ? `Описание в Telegram (${tgChat.description.length} симв.): ${tgChat.description.slice(0, 200)}`
          : 'Описание в Telegram: ОТСУТСТВУЕТ — рекомендуй добавить (первое, что видит новый подписчик)',
      )
    } else {
      lines.push('getChat недоступен: бот не видит канал (добавь бота в канал).')
    }
    const members = liveMembers ?? tgChat?.members ?? null
    lines.push(`Реальные подписчики в Telegram: ${members ?? 'неизвестно'}${ch.membersCount && liveMembers && ch.membersCount !== liveMembers ? ' (в карточке ленты: ' + ch.membersCount + ' — обновится при следующем парсинге)' : ''}`)
    if (admins && admins.length > 0) {
      const list = admins
        .slice(0, 6)
        .map((a) => `${a.status === 'creator' ? 'владелец' : 'админ'} ${a.username ? '@' + a.username : a.name}${a.isBot ? ' (бот)' : ''}${a.customTitle ? ` «${a.customTitle}»` : ''}`)
        .join('; ')
      lines.push(`Администрация (${admins.length}): ${list}`)
    }
    lines.push(`Права бота в канале: ${rights ? rights.rightsText : 'неизвестны (бот не в канале?)'}`)

    // Реальные просмотры/реакции Telegram (t.me/s парсинг) по свежим постам
    const withTg = recent.filter((p) => p.viewsTg != null)
    if (withTg.length > 0) {
      const avgViews = Math.round(withTg.reduce((a, p) => a + (p.viewsTg ?? 0), 0) / withTg.length)
      const avgReact = withTg.reduce((a, p) => a + p.reactionsTg, 0) / withTg.length
      const er = avgViews > 0 ? ((avgReact / avgViews) * 100).toFixed(2) : '0'
      lines.push(`Реальные просмотры Telegram (среднее по ${withTg.length} свежим постам): ${avgViews}`)
      lines.push(`Реакции Telegram: среднее ${avgReact.toFixed(1)} на пост, ER ≈ ${er}% от просмотров`)
      // Ориентир ER для каналов Telegram
      const erNum = Number(er)
      lines.push(
        erNum >= 8
          ? 'ER отличный (>8%)'
          : erNum >= 4
            ? 'ER хороший (4-8%)'
            : erNum >= 2
              ? 'ER средний (2-4%) — есть куда расти'
              : 'ER низкий (<2%) — контент мало цепляет, нужны вовлекающие форматы',
      )
    } else {
      const avgViews = recent.length > 0 ? Math.round(recent.reduce((a, p) => a + p.viewsCount, 0) / recent.length) : 0
      lines.push(`Реальных TG-просмотров пока нет (канал ещё не парсился) — просмотры ленты приложения: среднее ${avgViews}`)
    }

    // Контент-ритм
    if (recent.length > 0) {
      const oldest = recent[recent.length - 1].publishedAt.getTime()
      const newest = recent[0].publishedAt.getTime()
      const days = Math.max((newest - oldest) / 86_400_000, 0.5)
      const perWeek = ((recent.length / days) * 7).toFixed(1)
      lines.push(`Частота публикаций: ≈${perWeek} постов/нед по последним ${recent.length} постам; всего в ленте ${postsTotal}`)
    }
    lines.push('=== конец живого аудита. Напиши оценку и план действий по этим цифрам. ===')
    return { ok: true, data: lines.join('\n') }
  },
}

/* ============================ контент-менеджмент (v5.64) ============================ */

/** Правка уже опубликованного поста (Telegram + лента) */
const editPublishedPost: ToolDef = {
  name: 'edit_published_post',
  label: 'Правлю опубликованный пост…',
  description:
    'РЕДАКТИРУЕТ опубликованный пост: и в Telegram (editMessage, если бот админ с правом правки), и в ленте. ' +
    'Параметры: postId — id из list_my_posts; newText — полный НОВЫЙ текст поста. ' +
    'Сначала list_my_posts → покажи пост автору → предложи новый текст → после подтверждения вызывай.',
  parameters: {
    type: 'object',
    properties: {
      postId: { type: 'string', description: 'id поста из list_my_posts' },
      newText: { type: 'string', description: 'Полный новый текст поста' },
    },
    required: ['postId', 'newText'],
  },
  exec: async (args, ctx) => {
    if (!ctx.channelId) return { ok: false, data: 'Ошибка: канал не привязан.' }
    const postId = str(args.postId, 60)
    const newText = str(args.newText, 4000)
    if (!postId || newText.length < 10) return { ok: false, data: 'Ошибка: нужен postId и готовый newText (минимум 10 символов).' }
    const ch = await db.channel.findUnique({ where: { id: ctx.channelId }, select: { username: true } })
    if (!ch) return { ok: false, data: 'Ошибка: канал не найден.' }
    const post = await db.post.findFirst({
      where: { id: postId, channelId: ctx.channelId },
      select: { id: true, tgKey: true },
    })
    if (!post) return { ok: false, data: 'Пост с таким id не найден в этом канале.' }

    // 1) Telegram (best effort)
    const { botEditChannelMessage } = await import('@/lib/tg-bot')
    const messageId = Number(post.tgKey.split(':')[1])
    let tgEdited = false
    if (Number.isFinite(messageId) && messageId > 0) {
      const r = await botEditChannelMessage(ch.username, messageId, newText).catch(() => ({ ok: false as const }))
      tgEdited = r.ok
    }

    // 2) Лента: новый текст, кэши (саммари/озвучка/переводы) инвалидируем
    await db.post.update({
      where: { id: post.id },
      data: { text: newText, aiSummary: null, ttsAudio: null, ttsAt: null, translations: null },
    })
    return {
      ok: true,
      data:
        `Пост отредактирован в ленте Tg Swipe` +
        (tgEdited ? ' и в Telegram-канале.' : '. В Telegram правка не прошла — нужен бот-админ с правом edit_messages.'),
    }
  },
}

/** Закрепление/открепление постов в канале */
const pinPost: ToolDef = {
  name: 'pin_post',
  label: 'Закрепляю пост…',
  description:
    'Закрепляет или открепляет пост в Telegram-канале (право pin_messages). action: "pin" — закрепить postId, ' +
    '"unpin" — открепить конкретный postId, "unpin_all" — открепить ВСЕ закреплённые. ' +
    'Закрепление видно всем подписчикам — согласуй с автором, какой пост закрепить.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['pin', 'unpin', 'unpin_all'], description: 'Что сделать' },
      postId: { type: 'string', description: 'id поста из list_my_posts (не нужен для unpin_all)' },
    },
    required: ['action'],
  },
  exec: async (args, ctx) => {
    if (!ctx.channelId) return { ok: false, data: 'Ошибка: канал не привязан.' }
    const action = str(args.action, 12)
    const postId = str(args.postId, 60)
    const ch = await db.channel.findUnique({ where: { id: ctx.channelId }, select: { username: true } })
    if (!ch) return { ok: false, data: 'Ошибка: канал не найден.' }
    const { botPinChannelMessage, botUnpinAllChannelMessages } = await import('@/lib/tg-bot')

    if (action === 'unpin_all') {
      const r = await botUnpinAllChannelMessages(ch.username).catch(() => ({ ok: false as const, error: 'Ошибка Bot API' }))
      return r.ok
        ? { ok: true, data: 'Все закреплённые посты откреплены.' }
        : { ok: false, data: `Не получилось: ${r.error ?? 'нет прав pin_messages'}.` }
    }
    if (!postId) return { ok: false, data: 'Ошибка: для pin/unpin нужен postId (найди через list_my_posts).' }
    const post = await db.post.findFirst({ where: { id: postId, channelId: ctx.channelId }, select: { tgKey: true } })
    if (!post) return { ok: false, data: 'Пост с таким id не найден в канале.' }
    const messageId = Number(post.tgKey.split(':')[1])
    if (!Number.isFinite(messageId) || messageId <= 0) return { ok: false, data: 'У поста нет Telegram message id.' }
    const r = await botPinChannelMessage(ch.username, messageId, action === 'unpin').catch(() => ({ ok: false as const, error: 'Ошибка Bot API' }))
    return r.ok
      ? { ok: true, data: action === 'pin' ? 'Пост закреплён в канале.' : 'Пост откреплён.' }
      : { ok: false, data: `Не получилось: ${r.error ?? 'нет прав pin_messages'}.` }
  },
}

/** Пригласительная ссылка с меткой/лимитом/сроком */
const createInviteLink: ToolDef = {
  name: 'create_invite_link',
  label: 'Создаю пригласительную ссылку…',
  description:
    'Создаёт пригласительную ссылку канала (право invite_users): name — метка для учёта, memberLimit — лимит ' +
    'активаций, expireHours — срок жизни в часах (0 — вечная). Возвращает ссылку: автор может сразу ' +
    'поделиться или повесить на кампанию. Для закрытых каналов — единственный вход.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Метка ссылки (до 32 символов), например "розыгрыш-май"' },
      memberLimit: { type: 'number', description: 'Лимит подписчиков по ссылке (0 — без лимита)' },
      expireHours: { type: 'number', description: 'Срок жизни в часах (0 — вечная)' },
    },
  },
  exec: async (args, ctx) => {
    if (!ctx.channelId) return { ok: false, data: 'Ошибка: канал не привязан.' }
    const ch = await db.channel.findUnique({ where: { id: ctx.channelId }, select: { username: true } })
    if (!ch) return { ok: false, data: 'Ошибка: канал не найден.' }
    const { botCreateInviteLink } = await import('@/lib/tg-bot')
    const r = await botCreateInviteLink(ch.username, {
      name: str(args.name, 32) || undefined,
      memberLimit: typeof args.memberLimit === 'number' ? args.memberLimit : undefined,
      expireHours: typeof args.expireHours === 'number' ? args.expireHours : undefined,
    }).catch(() => ({ ok: false as const, error: 'Ошибка Bot API' }))
    if (!r.ok || !r.link) return { ok: false, data: `Не получилось: ${r.error ?? 'нет прав invite_users'}.` }
    const parts = [str(args.name, 32), typeof args.memberLimit === 'number' && args.memberLimit > 0 ? `лимит ${args.memberLimit}` : '', typeof args.expireHours === 'number' && args.expireHours > 0 ? `${args.expireHours}ч` : ''].filter(Boolean).join(', ')
    return { ok: true, data: `Ссылка создана${parts ? ` (${parts})` : ''}: ${r.link}`, meta: { inviteLink: r.link } }
  },
}

/** Отзыв пригласительной ссылки */
const revokeInviteLink: ToolDef = {
  name: 'revoke_invite_link',
  label: 'Отзываю ссылку…',
  description:
    'Отзывает пригласительную ссылку канала — по ней больше никто не вступит. ' +
    'Передавай точный link, который был выдан create_invite_link (или взят из диалога).',
  parameters: {
    type: 'object',
    properties: {
      link: { type: 'string', description: 'Полная ссылка https://t.me/+…' },
    },
    required: ['link'],
  },
  exec: async (args, ctx) => {
    if (!ctx.channelId) return { ok: false, data: 'Ошибка: канал не привязан.' }
    const link = str(args.link, 300)
    if (!/^https:\/\/t\.me\//.test(link)) return { ok: false, data: 'Ошибка: нужна полная ссылка вида https://t.me/+…' }
    const ch = await db.channel.findUnique({ where: { id: ctx.channelId }, select: { username: true } })
    if (!ch) return { ok: false, data: 'Ошибка: канал не найден.' }
    const { botRevokeInviteLink } = await import('@/lib/tg-bot')
    const r = await botRevokeInviteLink(ch.username, link).catch(() => ({ ok: false as const, error: 'Ошибка Bot API' }))
    return r.ok
      ? { ok: true, data: 'Ссылка отозвана — по ней больше не вступить.' }
      : { ok: false, data: `Не получилось: ${r.error ?? 'нет прав invite_users'}.` }
  },
}

/** Лучшее время для публикаций — гистограмма по реальным просмотрам */
const getBestPostingTime: ToolDef = {
  name: 'get_best_posting_time',
  label: 'Считаю лучшее время для постов…',
  description:
    'Анализ реальной активности аудитории: средние просмотры по ЧАСУ публикации последних 90 постов. ' +
    'Возвращает топ-3 часа (UTC) и худшие. Используй на «когда лучше постить», «в какое время публиковать» ' +
    '— переведи часы в пояс автора (обычно МСК = UTC+3) и дай рекомендацию.',
  parameters: { type: 'object', properties: {} },
  exec: async (_args, ctx) => {
    if (!ctx.channelId) return { ok: false, data: 'Ошибка: канал не привязан.' }
    const posts = await db.post.findMany({
      where: { channelId: ctx.channelId },
      orderBy: { publishedAt: 'desc' },
      take: 90,
      select: { publishedAt: true, viewsTg: true, viewsCount: true },
    })
    if (posts.length < 6) return { ok: true, data: 'Постов пока мало (<6) — статистику по часам собрать нельзя. Советуй общие окна: 8-10 и 18-21 по МСК.' }
    const byHour = new Map<number, { sum: number; n: number }>()
    for (const p of posts) {
      const h = p.publishedAt.getUTCHours()
      const views = p.viewsTg ?? p.viewsCount
      const cur = byHour.get(h) ?? { sum: 0, n: 0 }
      cur.sum += views
      cur.n += 1
      byHour.set(h, cur)
    }
    const rows = [...byHour.entries()]
      .filter(([, v]) => v.n >= 2)
      .map(([h, v]) => ({ h, avg: Math.round(v.sum / v.n), n: v.n }))
      .sort((a, b) => b.avg - a.avg)
    if (rows.length < 3) return { ok: true, data: 'Данных по часам пока мало — публикуйте в разные часы неделю, потом повтори анализ.' }
    const top = rows.slice(0, 3).map((r) => `${String(r.h).padStart(2, '0')}:00 UTC (ср. ${r.avg} просм., ${r.n} постов)`)
    const worst = rows.slice(-2).map((r) => `${String(r.h).padStart(2, '0')}:00 UTC (ср. ${r.avg})`)
    return {
      ok: true,
      data:
        `Анализ ${posts.length} последних постов:\n` +
        `Лучшие часы публикации: ${top.join('; ')}.\n` +
        `Худшие окна: ${worst.join('; ')}.\n` +
        `Дай рекомендацию: 1-2 конкретных окна (переведи в МСК = UTC+3, уточни это) и почему.`,
    }
  },
}

/** Отложенная публикация: очередь ScheduledPost, свип публикует через бота */
const schedulePost: ToolDef = {
  name: 'schedule_post',
  label: 'Ставлю пост в расписание…',
  description:
    'ОТКЛАДЫВАЕТ пост в очередь отложенных: уйдёт в канал автоматически в указанное время (система сама ' +
    'опубликует через бота). Параметры: text — готовый текст поста, atIso — время публикации в ISO 8601 UTC ' +
    '(например 2025-06-01T15:00:00Z; переведи время автора в UTC сам!), imageUrl — https-картинка из диалога. ' +
    'Покажи автору текст и точное время (двойную проверку пояса!), получи подтверждение, затем вызывай.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Полный готовый текст поста' },
      atIso: { type: 'string', description: 'Время публикации в ISO UTC (YYYY-MM-DDTHH:mm:ssZ)' },
      imageUrl: { type: 'string', description: 'https-URL картинки (если есть)' },
    },
    required: ['text', 'atIso'],
  },
  exec: async (args, ctx) => {
    if (!ctx.channelId) return { ok: false, data: 'Ошибка: канал не привязан.' }
    const text = str(args.text, 4000)
    const atRaw = str(args.atIso, 40)
    if (text.length < 10) return { ok: false, data: 'Ошибка: текст поста слишком короткий.' }
    const at = new Date(atRaw)
    if (Number.isNaN(at.getTime())) return { ok: false, data: `Ошибка: не понял время «${atRaw}» — передай ISO UTC (YYYY-MM-DDTHH:mm:ssZ).` }
    const diff = at.getTime() - Date.now()
    if (diff < 5 * 60_000) return { ok: false, data: 'Ошибка: время в прошлом или слишком близко (минимум +5 минут).' }
    if (diff > 30 * 24 * 3600_000) return { ok: false, data: 'Ошибка: максимум 30 дней вперёд.' }
    const imageUrlRaw = str(args.imageUrl, 600)
    const imageUrl = /^https:\/\//i.test(imageUrlRaw) ? imageUrlRaw : null
    const sp = await db.scheduledPost.create({
      data: {
        channelId: ctx.channelId,
        text,
        ...(imageUrl ? { imageUrl } : {}),
        scheduledAt: at,
        createdBy: ctx.uid,
      },
      select: { id: true },
    })
    return {
      ok: true,
      data: `Пост поставлен в очередь (id=${sp.id}): публикация ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC. Скажи автору точное время и напомни, что пост уйдёт автоматически.`,
      meta: { scheduledAt: at.toISOString() },
    }
  },
}

/** Очередь отложенных постов канала */
const listScheduledPosts: ToolDef = {
  name: 'list_scheduled_posts',
  label: 'Смотрю расписание постов…',
  description:
    'Показывает отложенные посты канала: предстоящие (id, время UTC, начало текста, ошибки) и недавно ' +
    'опубликованные/отменённые. Вызывай на «что в расписании», «какие посты запланированы», перед отменой.',
  parameters: { type: 'object', properties: {} },
  exec: async (_args, ctx) => {
    if (!ctx.channelId) return { ok: false, data: 'Ошибка: канал не привязан.' }
    const { scheduledQueueFor } = await import('@/lib/scheduled-posts')
    const data = await scheduledQueueFor(ctx.channelId).catch(() => 'Очередь недоступна.')
    return { ok: true, data }
  },
}

/** Снятие поста с очереди */
const cancelScheduledPost: ToolDef = {
  name: 'cancel_scheduled_post',
  label: 'Отменяю отложенный пост…',
  description:
    'Убирает пост из очереди отложенных (публиковаться не будет). Сначала list_scheduled_posts → покажи → ' +
    'подтверди у автора → передай id. Отменить можно только ещё не опубликованный пост.',
  parameters: {
    type: 'object',
    properties: {
      postId: { type: 'string', description: 'id отложенного поста из list_scheduled_posts' },
    },
    required: ['postId'],
  },
  exec: async (args, ctx) => {
    if (!ctx.channelId) return { ok: false, data: 'Ошибка: канал не привязан.' }
    const id = str(args.postId, 60)
    if (!id) return { ok: false, data: 'Ошибка: нужен id отложенного поста.' }
    const sp = await db.scheduledPost.findFirst({
      where: { id, channelId: ctx.channelId, publishedAt: null },
      select: { id: true },
    })
    if (!sp) return { ok: false, data: 'Такого отложенного поста нет (возможно, уже опубликован).' }
    await db.scheduledPost.delete({ where: { id: sp.id } })
    return { ok: true, data: 'Отложенный пост отменён и удалён из очереди.' }
  },
}

/** Настройка показа постов в ленте приложения (тизер-режим) */
const setTeaserMode: ToolDef = {
  name: 'set_teaser_mode',
  label: 'Настраиваю показ постов…',
  description:
    'Меняет ТИЗЕР-РЕЖИМ канала в ленте Tg Swipe: "none" — посты видны целиком (максимум охвата в приложении), ' +
    '"cut" — первые N символов + «Читать в канале» (конверсия в подписку Telegram), "blur" — текст виден, ' +
    'но размыт до подписки (жёсткая конверсия). Для cut можно задать teaserLimit (60-400 символов). ' +
    'Объясни автору эффект каждого режима и спроси, какой выбрать.',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['none', 'cut', 'blur'], description: 'Режим показа' },
      teaserLimit: { type: 'number', description: 'Для cut: сколько символов показывать (60-400)' },
    },
    required: ['mode'],
  },
  exec: async (args, ctx) => {
    if (!ctx.channelId) return { ok: false, data: 'Ошибка: канал не привязан.' }
    const mode = str(args.mode, 8)
    if (!['none', 'cut', 'blur'].includes(mode)) return { ok: false, data: 'Ошибка: mode должен быть none/cut/blur.' }
    const limitRaw = typeof args.teaserLimit === 'number' ? Math.round(args.teaserLimit) : null
    const limit = limitRaw && limitRaw >= 60 && limitRaw <= 400 ? limitRaw : null
    await db.channel.update({
      where: { id: ctx.channelId },
      data: { teaserMode: mode, ...(limit ? { teaserLimit: limit } : {}) },
    })
    const names: Record<string, string> = { none: 'посты видны целиком', cut: `обрезка до ${limit ?? 'лимита по умолчанию'} символов + кнопка «Читать в канале»`, blur: 'текст размыт до подписки' }
    return { ok: true, data: `Тизер-режим обновлён: ${mode} (${names[mode]}).` }
  },
}

/** CTA-кнопка в раскрытом посте */
const setCtaButton: ToolDef = {
  name: 'set_cta_button',
  label: 'Настраиваю кнопку в постах…',
  description:
    'Ставит или убирает CTA-кнопку в раскрытом посте канала (например «Забрать бонус» → https://…). ' +
    'label + url — установить (url только https); без аргументов — убрать кнопку. ' +
    'Покажи итоговый вариант перед применением.',
  parameters: {
    type: 'object',
    properties: {
      label: { type: 'string', description: 'Текст кнопки (до 40 символов)' },
      url: { type: 'string', description: 'https-ссылка кнопки' },
    },
  },
  exec: async (args, ctx) => {
    if (!ctx.channelId) return { ok: false, data: 'Ошибка: канал не привязан.' }
    const label = str(args.label, 60)
    const urlRaw = str(args.url, 600)
    if (!label && !urlRaw) {
      await db.channel.update({ where: { id: ctx.channelId }, data: { ctaLabel: null, ctaUrl: null } })
      return { ok: true, data: 'CTA-кнопка убрана.' }
    }
    const url = /^https:\/\//i.test(urlRaw) ? urlRaw : null
    if (!label || !url) return { ok: false, data: 'Ошибка: нужны ОБА поля (label и https-url), либо не передавай ничего — тогда кнопка уберётся.' }
    await db.channel.update({ where: { id: ctx.channelId }, data: { ctaLabel: label.slice(0, 40), ctaUrl: url } })
    return { ok: true, data: `Кнопка обновлена: «${label.slice(0, 40)}» → ${url}` }
  },
}

/* ============================ реестры ============================ */

/** Живые факты сервиса из базы знаний (кэш 45с — вызов почти бесплатный) */
const getServiceFacts: ToolDef = {
  name: 'get_service_facts',
  label: 'Проверяю факты о сервисе…',
  description:
    'Актуальные факты о сервисе Tg Swipe: сколько активных каналов/постов за 24ч/пользователей, ' +
    'активные розыгрыши (призы, дедлайн, участники), версия приложения. ' +
    'Используй для вопросов «сколько у вас…», «какие сейчас розыгрыши», «что за сервис». ' +
    'Основные факты уже есть в системном промпте — вызывай, когда нужен САМЫЙ свежий срез.',
  parameters: { type: 'object', properties: {} },
  exec: async () => {
    const kb = await getAiKnowledge().catch(() => null)
    if (!kb) return { ok: false, data: 'Факты сервиса временно недоступны.' }
    return { ok: true, data: kb.live || 'Статистика пуста.' }
  },
}

/** Поиск по каталогу каналов (не по постам!) */
const searchChannels: ToolDef = {
  name: 'search_channels',
  label: 'Ищу по каналам…',
  description:
    'Поиск по КАТАЛОГУ каналов ленты (не по постам): название, @юзернейм, описание. ' +
    'Возвращает до 8 каналов: название, @username, категория, подписчики в приложении, описание. ' +
    'Используй, когда пользователь ищет каналы по теме («найди каналы про кино»), а не конкретный пост.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Поисковая фраза: ключевые слова (2–4).' },
    },
    required: ['query'],
  },
  exec: async (args) => {
    const q = str(args.query, 120)
    if (!q) return { ok: false, data: 'Ошибка: пустой запрос.' }
    const words = q.toLowerCase().split(/\s+/).filter((w) => w.length >= 3).slice(0, 4)
    if (words.length === 0) return { ok: true, data: 'Слишком короткий запрос — уточни ключевые слова.' }
    const rows = await db.channel.findMany({
      where: { status: 'active', id: { notIn: await getNsfwChannelIds() } },
      orderBy: { subscribersCount: 'desc' },
      take: 500,
      select: {
        title: true,
        username: true,
        description: true,
        subscribersCount: true,
        category: { select: { title: true } },
      },
    })
    const hits = rows.filter((c) => {
      const hay = `${c.title} ${c.username} ${c.description ?? ''} ${c.category?.title ?? ''}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
    const partial = hits.length === 0
      ? rows.filter((c) => {
          const hay = `${c.title} ${c.username} ${c.description ?? ''} ${c.category?.title ?? ''}`.toLowerCase()
          return words.some((w) => hay.includes(w))
        })
      : []
    const picked = (hits.length > 0 ? hits : partial).slice(0, 8)
    if (picked.length === 0) return { ok: true, data: 'Каналов по этой теме не нашлось. Попробуй другие слова.' }
    const data = picked
      .map(
        (c, i) =>
          `${i + 1}. ${c.title} (@${c.username})${c.category ? `, ${c.category.title}` : ''}, ${c.subscribersCount} подписчиков — ${(c.description ?? '').replace(/\s+/g, ' ').slice(0, 140) || 'без описания'}`,
      )
      .join('\n')
    return { ok: true, data }
  },
}

/* ============================ v5.73: ПАМЯТЬ, ВЕБ, ПРОФИЛЬ ============================ *
 *  Память: инструмент remember_fact пишет факт в AiMemory.userId — блок памяти
 *  подмешивается в системный промпт при КАЖДОМ запросе (ИИ помнит пользователя
 *  между сессиями). forget_memory стирает. Веб: web_search/read_web_page через
 *  z-ai-web-dev-sdk (web_search/page_reader). Плюс профиль/кошелёк/задания/розыгрыши.
 */

const MEMORY_MAX_CHARS = 2400

/** Компактный блок памяти для системного промпта ('' — памяти нет) */
export async function aiMemoryBlock(uid: string): Promise<string> {
  try {
    const row = await db.aiMemory.findUnique({ where: { userId: uid } })
    if (!row?.content?.trim()) return ''
    return `=== ЧТО ТЫ ПОМНИШЬ ОБ ЭТОМ ПОЛЬЗОВАТЕЛЕ (из прошлых разговоров) ===\n${row.content.trim().slice(0, MEMORY_MAX_CHARS)}\n=== конец памяти ===`
  } catch {
    return ''
  }
}

/**
 * ГЛОБАЛЬНАЯ ПАМЯТЬ ЧАТОВ (v5.74): последние сообщения из ДРУГИХ чатов этого
 * пользователя (все поверхности, кроме текущей сессии). Новый чат знает, о чём
 * говорили в прошлых, и может продолжить мысль без пересказа. Блок компактный:
 * 16 последних сообщений по 200 символов — заметный контекст без раздува промпта.
 */
export async function aiCrossChatBlock(uid: string, excludeSessionId?: string | null): Promise<string> {
  try {
    const msgs = await db.aiChatMessage.findMany({
      where: {
        userId: uid,
        ...(excludeSessionId ? { sessionId: { not: excludeSessionId } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 16,
      select: { role: true, content: true, sessionId: true },
    })
    if (msgs.length === 0) return ''
    const sessionIds = [...new Set(msgs.map((m) => m.sessionId).filter(Boolean))] as string[]
    const sessions =
      sessionIds.length > 0
        ? await db.aiChatSession.findMany({ where: { id: { in: sessionIds } }, select: { id: true, title: true } })
        : []
    const titleById = new Map(sessions.map((s) => [s.id, s.title]))
    const lines = msgs
      .reverse()
      .map((m) => {
        const chat = titleById.get(m.sessionId ?? '') ?? 'прошлый чат'
        return `[чат «${chat}»] ${m.role === 'user' ? 'Пользователь' : 'Ты'}: ${m.content.replace(/\s+/g, ' ').slice(0, 200)}`
      })
      .join('\n')
    return (
      '=== ЧТО ОБСУЖДАЛИ В ДРУГИХ ЧАТАХ С ЭТИМ ПОЛЬЗОВАТЕЛЕМ (недавнее; память сквозная — ' +
      'можешь продолжать прежнюю мысль, если он просит «продолжи»/«как договорились», без пересказа) ===\n' +
      lines.slice(0, 3200) +
      '\n=== конец других чатов ==='
    )
  } catch {
    return ''
  }
}

const rememberFactTool: ToolDef = {
  name: 'remember_fact',
  label: 'Запоминаю',
  description:
    'Сохраняет факт о пользователе в долговременную память (видна во всех будущих разговорах). Вызывай, когда пользователь сообщает что-то личное/полезное на будущее: предпочтения, ниша канала, тон, план, важные договорённости («запомни», «будем делать»). НЕ сохраняй мимолётное.',
  parameters: {
    type: 'object',
    properties: {
      fact: { type: 'string', description: 'Краткий факт одним предложением от третьего лица: «Ниша канала — криптовалютные обзоры»' },
    },
    required: ['fact'],
  },
  exec: async (args, ctx) => {
    const fact = str(args.fact, 300)
    if (!fact) return { ok: false, data: 'Пустой факт' }
    const row = await db.aiMemory.findUnique({ where: { userId: ctx.uid } })
    const prev = row?.content ?? ''
    const lines = prev.split('\n').filter(Boolean).filter((l) => l.toLowerCase() !== fact.toLowerCase())
    lines.push(fact)
    let next = lines.join('\n')
    if (next.length > MEMORY_MAX_CHARS) next = next.slice(next.length - MEMORY_MAX_CHARS)
    await db.aiMemory.upsert({
      where: { userId: ctx.uid },
      create: { userId: ctx.uid, content: next },
      update: { content: next },
    })
    return { ok: true, data: `Запомнено: ${fact}`, meta: { memorySaved: true } }
  },
}

const forgetMemoryTool: ToolDef = {
  name: 'forget_memory',
  label: 'Стираю память',
  description: 'Полностью стирает долговременную память о пользователе. Вызывай ТОЛЬКО по явной просьбе («забудь всё, что помнишь»).',
  parameters: { type: 'object', properties: {} },
  exec: async (_args, ctx) => {
    await db.aiMemory.deleteMany({ where: { userId: ctx.uid } })
    return { ok: true, data: 'Память о пользователе полностью стёрта.' }
  },
}

const webSearchTool: ToolDef = {
  name: 'web_search',
  label: 'Ищу в интернете',
  description: 'Поиск в интернете (актуальные новости, факты, события). Используй для вопросов о том, чего НЕТ в ленте и базе знаний: «что случилось…», «когда выходит…». Возвращай краткие находки с источниками.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Поисковый запрос (лучше на языке оригинала темы)' },
    },
    required: ['query'],
  },
  exec: async (args) => {
    const query = str(args.query, 300)
    if (!query) return { ok: false, data: 'Пустой запрос' }
    try {
      const zai = await import('z-ai-web-dev-sdk').then((m) => m.default.create())
      const res = await zai.functions.invoke('web_search', { query, count: 6 } as never)
      const items = ((res as { results?: Array<{ caption?: string; source?: string; original_url?: string }> }).results ?? [])
      if (items.length === 0) return { ok: true, data: `По запросу «${query}» ничего не найдено.` }
      const lines = items.slice(0, 6).map((it, i) => `${i + 1}. ${it.caption ?? '(без описания)'}${it.source ? ` — ${it.source}` : it.original_url ? ` (${it.original_url})` : ''}`)
      return { ok: true, data: `Результаты поиска «${query}»:\n${lines.join('\n')}` }
    } catch (e) {
      return { ok: false, data: `Поиск недоступен: ${(e as Error).message?.slice(0, 120) || 'ошибка'}` }
    }
  },
}

const readWebPageTool: ToolDef = {
  name: 'read_web_page',
  label: 'Читаю страницу',
  description: 'Открывает и читает текст веб-страницы по URL. Используй после web_search для деталей или когда пользователь даёт ссылку.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Полный https-URL страницы' },
    },
    required: ['url'],
  },
  exec: async (args) => {
    const url = str(args.url, 500)
    if (!/^https:\/\//i.test(url)) return { ok: false, data: 'Нужен https-URL' }
    try {
      const zai = await import('z-ai-web-dev-sdk').then((m) => m.default.create())
      const res = await zai.functions.invoke('page_reader', { url } as never)
      const html = ((res as { html?: string }).html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      if (!html) return { ok: false, data: 'Страница пустая или не читается' }
      return { ok: true, data: `Текст страницы ${url}:\n${html.slice(0, 3000)}` }
    } catch (e) {
      return { ok: false, data: `Не удалось прочитать: ${(e as Error).message?.slice(0, 120) || 'ошибка'}` }
    }
  },
}

const myProfileTool: ToolDef = {
  name: 'get_my_profile',
  label: 'Смотрю профиль',
  description: 'Профиль текущего пользователя: имя, username, тариф, дата регистрации.',
  parameters: { type: 'object', properties: {} },
  exec: async (_args, ctx) => {
    const u = await db.user.findUnique({
      where: { id: ctx.uid },
      select: { username: true, firstName: true, lastName: true, createdAt: true },
    })
    if (!u) return { ok: false, data: 'Пользователь не найден' }
    return {
      ok: true,
      data: `Профиль: ${[u.firstName, u.lastName].filter(Boolean).join(' ') || '(без имени)'}${u.username ? ` (@${u.username})` : ''}; с нами с ${u.createdAt.toISOString().slice(0, 10)}.`,
    }
  },
}

const walletRecentTool: ToolDef = {
  name: 'get_wallet_recent',
  label: 'Смотрю кошелёк',
  description: 'Последние операции по балансу (пополнения, списания, конвертации, награды) — до 10 записей.',
  parameters: { type: 'object', properties: {} },
  exec: async (_args, ctx) => {
    const logs = await db.balanceLog.findMany({
      where: { userId: ctx.uid },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { kind: true, currency: true, amount: true, note: true, createdAt: true },
    })
    if (logs.length === 0) return { ok: true, data: 'Операций пока нет.' }
    const lines = logs.map((l) => {
      const sign = l.amount >= 0 ? '+' : ''
      const val = l.currency === 'swp' ? `${sign}${l.amount} свайпов` : `${sign}${(l.amount / 100).toFixed(2)} ₽`
      return `${l.createdAt.toISOString().slice(0, 16).replace('T', ' ')} · ${val} · ${l.note ?? l.kind}`
    })
    return { ok: true, data: `Последние операции:\n${lines.join('\n')}` }
  },
}

const myQuestsTool: ToolDef = {
  name: 'get_my_quests',
  label: 'Смотрю задания',
  description: 'Список заданий пользователя и что уже выполнено (задания за свайпы: подписки, ежедневный вход, TikTok и др.).',
  parameters: { type: 'object', properties: {} },
  exec: async (_args, ctx) => {
    const [quests, done] = await Promise.all([
      db.quest.findMany({ where: { active: true }, orderBy: { sort: 'asc' }, select: { id: true, title: true, rewardSwp: true } }),
      db.questCompletion.findMany({ where: { userId: ctx.uid }, select: { questId: true, status: true } }),
    ])
    const doneMap = new Map(done.map((d) => [d.questId, d.status]))
    const lines = quests.map((q) => `- ${q.title} · +${q.rewardSwp} · ${doneMap.get(q.id) === 'done' ? 'ВЫПОЛНЕНО' : doneMap.get(q.id) === 'revoked' ? 'аннулировано' : 'не выполнено'}`)
    return { ok: true, data: `Задания:\n${lines.join('\n') || '(пусто)'}` }
  },
}

const giveawaysTool: ToolDef = {
  name: 'get_active_giveaways',
  label: 'Смотрю розыгрыши',
  description: 'Активные розыгрыши сервиса: призы, дедлайн, число участников, задания за билеты.',
  parameters: { type: 'object', properties: {} },
  exec: async () => {
    const gs = await db.giveaway.findMany({
      where: { status: 'active' },
      orderBy: { endAt: 'asc' },
      take: 5,
      select: { id: true, title: true, prizes: true, endAt: true, tasks: true, _count: { select: { entries: true } } },
    })
    if (gs.length === 0) return { ok: true, data: 'Активных розыгрышей сейчас нет.' }
    const lines = gs.map((g) => {
      const end = g.endAt ? `дедлайн ${g.endAt.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'без дедлайна'
      let prize = ''
      try {
        const p = JSON.parse(g.prizes ?? '[]') as Array<{ title?: string; winners?: number }>
        prize = p.map((x) => `${x.title ?? 'приз'}${x.winners ? ` (×${x.winners})` : ''}`).join('; ')
      } catch { prize = g.prizes ?? '' }
      return `- ${g.title} · участники: ${g._count.entries} · ${end}${prize ? ` · призы: ${prize}` : ''}`
    })
    return { ok: true, data: `Активные розыгрыши:\n${lines.join('\n')}` }
  },
}

const COMMON_USER_TOOLS = [
  rememberFactTool,
  forgetMemoryTool,
  webSearchTool,
  readWebPageTool,
  myProfileTool,
  walletRecentTool,
  myQuestsTool,
  giveawaysTool,
]

const SEARCH_TOOLS: ToolDef[] = [...COMMON_USER_TOOLS, getTrending, searchPosts, readPost, searchChannels, getServiceFacts]
const ASSISTANT_TOOLS: ToolDef[] = [
  ...COMMON_USER_TOOLS,
  // Аналитика
  getChannelStats,
  auditTelegramChannel, // v5.64: живой аудит из Telegram через бота
  getBestPostingTime, // v5.64: лучшее время публикаций
  getTrending,
  // Контент
  createPostDraft,
  generateImage,
  publishPost,
  schedulePost, // v5.64: отложенная публикация
  listScheduledPosts,
  cancelScheduledPost,
  listMyPosts,
  editPublishedPost, // v5.64: правка опубликованного
  deletePosts,
  pinPost, // v5.64: закрепление
  // Настройки канала
  updateChannelInfo,
  setTeaserMode, // v5.64
  setCtaButton, // v5.64
  createInviteLink, // v5.64
  revokeInviteLink,
  // Сервис
  analyzeStyleTool,
  getServiceFacts,
]


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
  /** Живые факты сервиса (v5.47): тарифы, курс, розыгрыши, статистика */
  knowledge?: string
  /** Долговременная память о пользователе (v5.73) */
  memory?: string
  /** Глобальная память чатов (v5.74): свежие сообщения из других чатов пользователя */
  crossChat?: string
}): string {
  const now = new Date()
  return [
    'Ты — Snap Search — умный поиск внутри Telegram Mini App «Tg Swipe» — умная лента Telegram-каналов.',
    'Ты помогаешь читателю находить посты и каналы, понимать, что происходит в ленте, и отвечать на вопросы о сервисе.',
    `Сегодня: ${now.toISOString().slice(0, 10)} (${WEEKDAYS_RU[now.getDay()]}), ${now.toISOString().slice(11, 16)} UTC. Пользователь: ${ctx.userName}, тариф: ${ctx.tier}.`,
    ctx.knowledge ?? '',
    ctx.memory ?? '',
    ctx.crossChat ?? '',
    '',
    'КАК РАБОТАТЬ:',
    '1. Для ЛЮБОГО вопроса о содержании постов сначала вызывай search_posts (вопрос → ключевые слова). Затем при необходимости read_post для деталей.',
    '2. Поиск КАНАЛОВ по теме («найди каналы про…», «какие есть каналы о…») → search_channels.',
    '3. Вопросы о САМОМ СЕРВИСЕ (тарифы, свайпы, розыгрыши, «сколько у вас каналов») → отвечай из фактов о сервисе в системном промпте; нужен свежий срез → get_service_facts.',
    '4. Отвечай ТОЛЬКО по найденным постам/фактам — не выдумывай. Если постов нет — честно скажи и предложи другую формулировку.',
    '5. Формат ответа (как в ChatGPT): markdown, 2-8 строк по делу — заголовки ### только при уместности, **жирный** для ключевых мыслей, списки «- », при сравнениях — таблицы. В конце перечисли источники строкой «Источники: @username, @username» (для вопросов о сервисе источники не нужны).',
    '6. Общие вопросы («как дела», «что ты умеешь») отвечай без инструментов, коротко и дружелюбно.',
    '7. Язык ответа = язык вопроса (по умолчанию русский).',
    '8. ПАМЯТЬ: пользователь сообщает что-то важное на будущее («запомни, что…», ниша, предпочтения) → вызови remember_fact. То, что ты помнишь, — в блоке памяти выше.',
  ].filter(Boolean).join('\n')
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
  /** Живые факты сервиса (v5.47): тарифы, курс, розыгрыши — ассистент знает весь сервис */
  knowledge?: string
  /** Долговременная память о пользователе (v5.73) */
  memory?: string
  /** Глобальная память чатов (v5.74): свежие сообщения из других чатов пользователя */
  crossChat?: string
}): string {
  const now = new Date()
  const age = ctx.createdAt
    ? `в ленте с ${ctx.createdAt.toISOString().slice(0, 10)}`
    : ''
  return [
    'Ты — Snap Ассистент — личный ИИ-управляющий Telegram-канала автора внутри Telegram Mini App «Tg Swipe».',
    'Ты помогаешь придумывать посты, рисовать картинки к ним, публиковать и откладывать посты, править и закреплять опубликованное, создавать пригласительные ссылки, менять название/описание/аватар/кнопки — и проводишь ЖИВОЙ АУДИТ канала по данным из самого Telegram через бота (реальные подписчики, просмотры, реакции, права бота), а не по ленте трендов.',
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
    ctx.knowledge ?? '',
    ctx.memory ?? '',
    ctx.crossChat ?? '',
    '',
    ctx.statsBlock
      ? `=== ДАННЫЕ КАНАЛА (уже собраны, вызывать get_channel_stats для базовых цифр НЕ нужно) ===\n${ctx.statsBlock}\n=== конец данных канала ===`
      : 'Статистика канала сейчас недоступна — при вопросах про цифры вызови get_channel_stats.',
    '',
    'КАК РАБОТАТЬ:',
    '1. Просьба «напиши пост…» → продумай текст в стиле автора и вызови create_post_draft (в text — готовый пост). Затем коротко скажи, что готово, и предложи доработки.',
    '2. Просьба про картинку/обложку/иллюстрацию → вызови generate_image с подробным английским промптом (сюжет, окружение, стиль, свет, палитра, композиция). Ссылку/путь на картинку в текст ответа НЕ вставляй — она показывается автору автоматически.',
    '3. Явная просьба «опубликуй» → если текст ещё не показан, покажи его в ответе и вызови publish_post. Просьба «опубликуй завтра в N» / «поставь в расписание» → подтверди текст и время (переведи в UTC, покажи оба), затем schedule_post. Расписание: list_scheduled_posts, отмена — cancel_scheduled_post после подтверждения.',
    '4. УДАЛЕНИЕ ПОСТОВ («удали пост/посты…») → ОБЯЗАТЕЛЬНО: сначала list_my_posts → покажи кандидатов списком (дата/просмотры/начало текста) → получи ЯВНОЕ подтверждение автора → только потом delete_posts. Никогда не удаляй без подтверждения.',
    '5. ПРАВКА ПОСТА («исправь/поменяй текст поста») → list_my_posts → покажи текущий текст → предложи новый → после подтверждения edit_published_post (postId + полный newText). Закрепление («закрепи пост») → уточни какой → pin_post (pin/unpin/unpin_all).',
    '6. ИЗМЕНЕНИЕ КАНАЛА («поменяй название/описание/аватар») → предложи конкретный вариант, получи подтверждение, вызови update_channel_info (title/description/avatarUrl — только запрошенные поля). Для аватара: сгенерируй картинку (generate_image) и передай её URL как avatarUrl. «Настрой кнопку в постах» → set_cta_button; «как показываются мои посты в ленте» → set_teaser_mode.',
    '7. ОЦЕНКА КАНАЛА («оцени канал», «дай аудит», «что улучшить», «как расти») → ОБЯЗАТЕЛЬНО вызови audit_telegram_channel: это живые данные ИЗ TELEGRAM через бота (реальные подписчики, просмотры, реакции, админы, права бота). Ответь структурно: оформление → контент-ритм → вовлечённость (ER к просмотрам TG) → 3-5 конкретных шагов. Вовлечённость из приложения (лайки/просмотры ленты) — второстепенный сигнал, основной — реальный Telegram.',
    '8. Вопросы про цифры → отвечай ИЗ данных канала выше; свежий срез/топ постов → get_channel_stats; «когда лучше постить» → get_best_posting_time (переведи UTC в пояс автора, обычно МСК); «что сейчас в тренде» → get_trending.',
    '9. Вопросы о СЕРВИСЕ (тарифы, свайпы, розыгрыши, лимиты, возможности приложения) → отвечай из базы знаний в системном промпте; самый свежий срез → get_service_facts.',
    '10. Обычное общение — без инструментов, дружелюбно и кратко. Пиши по-русски (или на языке автора).',
    '11. Формат ответов КАК В CHATGPT: markdown с заголовками ##/### при уместности, **жирный**, списки «- », нумерованные шаги, таблицы для сравнений, ```блоки кода``` для кода. Уместно используй эмодзи (🎉🔥✨⚡💡) — они отображаются премиум-анимациями. Без выдуманных фактов и цифр.',
    '13. ПАМЯТЬ: автор сообщает что-то важное на будущее («запомни», ниша канала, тон, план) → вызови remember_fact; «забудь всё» → forget_memory. Известные тебе факты — в блоке памяти выше.',
    '12. ПРАВА БОТА: если инструмент вернул ошибку «нет прав» — объясни автору, какого права не хватает (публикация/удаление/правка/закрепление/смена инфо/инвайт-ссылки) и попроси выдать его боту в настройках канала. Не повторяй неудавшуюся попытку без изменений условий.',
  ].join('\n')
}
