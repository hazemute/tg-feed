import { NextResponse } from 'next/server'
import { z } from 'zod'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { db } from '@/lib/db'
import { cyrillicRatio, translatePostCached } from '@/lib/ai'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  postId: z.string().min(1).max(64),
  /** Целевой язык (ISO 639-1). По умолчанию — родной язык пользователя, иначе русский */
  lang: z.string().min(2).max(5).optional(),
})

/**
 * POST /api/translate { postId, lang? }
 *
 * Перевод поста на родной язык читателя (как в Twitter: переведённый текст
 * замещает оригинал). Вызов самой быстрой дешёвой модели OpenRouter —
 * результат кэшируется в Post.translations ({lang: {text, at}}) и заранее
 * прогревается 24/7-движком для свежих постов. Лимит 12 запросов в минуту.
 */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 12, windowMs: 60_000, bucket: 'translate' })
  if (!g.ok) return g.res

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('postId required')
    const { postId } = parsed.data

    const post = await db.post.findUnique({ where: { id: postId }, select: { text: true } })
    if (!post) return err('post not found', 404)
    if (post.text.trim().length < 24) {
      return NextResponse.json({ ok: false, reason: 'short' }, { status: 200 })
    }
    if (cyrillicRatio(post.text) > 0.15) {
      return NextResponse.json({ ok: false, reason: 'russian' }, { status: 200 })
    }

    // Целевой язык: параметр → язык клиента Telegram → русский
    const user = await db.user.findUnique({ where: { id: g.uid } })
    const lang = (parsed.data.lang ?? user?.languageCode ?? 'ru').slice(0, 2).toLowerCase()

    const r = await translatePostCached(postId, lang)
    if (r.ok && r.text) {
      if (!r.cached) {
        // Журнал для анти-абьюза (раз в пост — не на каждый показ)
        db.translationLog
          .create({ data: { userId: g.uid, postId, srcLang: lang } })
          .catch(() => {})
      }
      return NextResponse.json({ ok: true, text: r.text, lang, cached: r.cached === true })
    }
    if (r.reason === 'russian') {
      return NextResponse.json({ ok: false, reason: 'russian' }, { status: 200 })
    }
    if (r.reason === 'short') {
      return NextResponse.json({ ok: false, reason: 'short' }, { status: 200 })
    }
    return err('перевод временно недоступен', 503)
  } catch (e) {
    console.error('[translate]', e)
    return err('перевод временно недоступен', 503)
  }
}
