import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { chatSimple, openRouterEnabled } from '@/lib/openrouter'
import { pollinationsImageUrl, verifyImageUrl } from '@/lib/ai-image'
import { botPublishToChannel } from '@/lib/tg-bot'
import { tierAtLeast, tierOfUser } from '@/lib/tiers'
import { stripMarkdown } from '@/lib/markdown'

export const dynamic = 'force-dynamic'

/**
 * АВТОНОМНЫЙ ИИ-АССИСТЕНТ канала (Snap Pro, v5.17).
 *
 * Личный ИИ-контентщик: читает последние 30 постов канала и запоминает стиль
 * (Tone of Voice), смотрит свежие тренды ленты, пишет готовый пост в стиле
 * автора и рисует к нему картинку (pollinations, бесплатно). По кнопке
 * «Одобрить» пост улетает в РЕАЛЬНЫЙ Telegram-канал через Bot API.
 *
 * POST { action }:
 *  - 'style'    { channelId }              → проанализировать стиль (30 постов)
 *  - 'generate' { channelId, prompt? }     → черновик: текст + картинка
 *  - 'publish'  { channelId, text, imageUrl? } → опубликовать в TG-канал
 *
 * Требует тир Snap Pro у владельца канала (402 pro_required иначе).
 */

const bodySchema = z.discriminatedUnion('action', [
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

type StyleProfile = {
  tone: string
  topics: string
  style: string
  at: string
}

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
    // Постов мало — нейтральный слепок, ассистент всё равно работает
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

/** Тренды ленты: топ-10 свежих постов за 3 дня по вовлечённости */
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

    /* ---------- Анализ стиля ---------- */
    if (d.action === 'style') {
      const profile = await analyzeStyle(channel.id, channel.username)
      await db.channel.update({
        where: { id: channel.id },
        data: { styleProfile: JSON.stringify(profile), styleAt: new Date() },
      })
      return NextResponse.json({ ok: true, profile })
    }

    /* ---------- Генерация черновика ---------- */
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

      // Картинка: промпт из сути поста (минимализм), URL бесплатный, проверяем отдачу
      const imgPrompt = `clean minimal editorial illustration, telegram post cover, about: ${clean.slice(0, 160)}`
      const imageUrl = pollinationsImageUrl(imgPrompt)
      const imageOk = await verifyImageUrl(imageUrl).catch(() => false)

      return NextResponse.json({
        text: clean,
        imageUrl: imageOk ? imageUrl : imageUrl, // URL детерминирован — публикация повторно проверит
        imagePending: !imageOk,
        styleAnalyzed,
      })
    }

    /* ---------- Публикация в реальный канал ---------- */
    const imageUrl = d.imageUrl && /^https:\/\//i.test(d.imageUrl) ? d.imageUrl : null
    if (imageUrl) {
      const ok = await verifyImageUrl(imageUrl).catch(() => false)
      if (!ok) {
        // Картинка так и не сгенерировалась — публикуем без неё, текст важнее
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
