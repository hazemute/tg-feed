import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { cronAuthorized } from '@/lib/guard'
import { generateTts, ttsPlainOf } from '@/lib/tts'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/tts/prewarm — предпрогрев озвучки (вызывается движком 24/7).
 *
 * 24/7-движок живёт в песочнице, где доступен z-ai SDK: после каждого тика
 * он дёргает этот эндпоинт, и 2 свежих поста без озвучки генерируются заранее.
 * В итоге кэш Post.ttsAudio в общей БД тёплый — пользователи прода попадают
 * в кэш мгновенно и не ждут генерации (и не зависят от доступности движков
 * на Vercel). Авторизация: Authorization: Bearer $CRON_SECRET.
 */
export async function POST(request: Request) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const candidates = await db.post.findMany({
      where: {
        ttsAudio: null,
        text: { not: '' },
        publishedAt: { gte: new Date(Date.now() - 3 * 24 * 3600_000) },
      },
      select: { id: true, text: true },
      orderBy: { publishedAt: 'desc' },
      take: 6,
    })

    let generated = 0
    for (const post of candidates) {
      if (generated >= 2) break
      const plain = ttsPlainOf(post.text)
      if (plain.length < 12) continue
      try {
        const audio = await generateTts(post.text)
        if (!audio) continue
        await db.post
          .update({ where: { id: post.id }, data: { ttsAudio: audio.toString('base64'), ttsAt: new Date() } })
          .catch(() => {})
        generated++
      } catch {
        // один неудачный пост не роняет прогрев
      }
    }

    return NextResponse.json({ ok: true, generated })
  } catch (e) {
    console.error('[tts:prewarm]', e)
    return NextResponse.json({ error: 'prewarm failed' }, { status: 500 })
  }
}
