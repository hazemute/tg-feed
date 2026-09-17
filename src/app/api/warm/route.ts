import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { cronAuthorized } from '@/lib/guard'
import { generateTts, ttsPlainOf } from '@/lib/tts'
import { summarizePostCached, translatePostCached } from '@/lib/ai'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/warm — предпрогрев «тяжёлых» функций ленты (вызывается движком 24/7).
 *
 * После каждого тика парсинга движок просит приложение заранее подготовить для
 * свежих постов:
 *  - озвучку (Post.ttsAudio) — 2 поста;
 *  - переводы на русский для нерусских (Post.translations) — 4 поста;
 *  - краткое содержание для длинных (Post.aiSummary) — 2 поста.
 *
 * Всё кэшируется в общей БД — пользователь на любом окружении получает
 * перевод/саммари/озвучку мгновенно, без ожидания генерации.
 * Авторизация: Authorization: Bearer $CRON_SECRET.
 */
export async function POST(request: Request) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const since = new Date(Date.now() - 3 * 24 * 3600_000)

  try {
    let tts = 0
    let translated = 0
    let summarized = 0

    /* ---------- Озвучка: 2 свежих поста без аудио ---------- */
    const ttsPosts = await db.post.findMany({
      where: { ttsAudio: null, text: { not: '' }, publishedAt: { gte: since } },
      select: { id: true, text: true },
      orderBy: { publishedAt: 'desc' },
      take: 6,
    })
    for (const post of ttsPosts) {
      if (tts >= 2) break
      if (ttsPlainOf(post.text).length < 12) continue
      try {
        const audio = await generateTts(post.text)
        if (!audio) continue
        await db.post
          .update({
            where: { id: post.id },
            data: { ttsAudio: audio.toString('base64'), ttsAt: new Date() },
          })
          .catch(() => {})
        tts++
      } catch {
        // один неудачный пост не роняет прогрев
      }
    }

    /* ---------- Переводы: 4 нерусских свежих поста ---------- */
    const foreignPosts = await db.post.findMany({
      where: {
        translations: null,
        text: { not: '' },
        publishedAt: { gte: since },
      },
      select: { id: true, text: true },
      orderBy: { publishedAt: 'desc' },
      take: 14,
    })
    for (const post of foreignPosts) {
      if (translated >= 4) break
      try {
        const r = await translatePostCached(post.id, 'ru')
        if (r.ok && !r.cached) translated++
      } catch {
        // LLM недоступна/пустой ответ — попробуем на следующем тике
      }
    }

    /* ---------- Саммари: 2 длинных свежих поста без кэша ---------- */
    const longPosts = await db.post.findMany({
      where: {
        aiSummary: null,
        publishedAt: { gte: since },
      },
      select: { id: true, text: true },
      orderBy: { publishedAt: 'desc' },
      take: 10,
    })
    for (const post of longPosts) {
      if (summarized >= 2) break
      if (post.text.trim().length < 200) continue
      try {
        const r = await summarizePostCached(post.id)
        if (r && !r.cached && r.items.length > 0) summarized++
      } catch {
        // попробуем позже
      }
    }

    if (tts + translated + summarized > 0) {
      console.log(`[warm] tts:+${tts} translate:+${translated} summary:+${summarized}`)
    }
    return NextResponse.json({ ok: true, tts, translated, summarized })
  } catch (e) {
    console.error('[warm]', e)
    return NextResponse.json({ error: 'warm failed' }, { status: 500 })
  }
}
