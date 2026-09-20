import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'

export const dynamic = 'force-dynamic'

const TAG_RE = /^[a-zа-яё0-9_]{1,32}$/i

/**
 * POST /api/hashtags/click { tag } — фиксация клика по #хэштегу.
 * Источник трендов «Сейчас обсуждают» (GET /api/hashtags/trending).
 * Лимит: 60 кликов/мин на пользователя.
 */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'tag-click' })
  if (!g.ok) return g.res

  try {
    // readJson: кап 64KB по content-length ДО чтения тела
    const body = await readJson<{ tag?: unknown }>(request)
    // Нормализация: снимаем решётку, режем пробелы, приводим к нижнему регистру
    const raw = typeof body?.tag === 'string' ? body.tag.trim().replace(/^#/, '') : ''
    if (!TAG_RE.test(raw)) return err('invalid tag')

    await db.hashtagClick.create({ data: { tag: raw.toLowerCase(), userId: g.uid } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[hashtags/click]', e)
    return err('click failed', 500)
  }
}
