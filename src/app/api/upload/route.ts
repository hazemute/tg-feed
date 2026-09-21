import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * POST /api/upload (v5.65) — загрузка картинки (dataURL) → постоянная ссылка.
 *
 * Хранилище — таблица Upload в БД (base64): внешних бакетов больше нет
 * (Supabase Storage лежит), а серверless-файловая система не persists.
 * Раздача — GET /api/upload/<id> с immutable-кэшем.
 *
 * Потребители:
 *  - Живой канал: скрепка → картинка поста → sendPhoto ботом (ссылку
 *    делаем абсолютной через SITE_URL — Telegram должен скачать файл);
 *  - чат поддержки / предложки (SupportChat уже звал этот роут);
 *  - смена аватара канала (botSetChatPhoto мультипартом).
 *
 * Клиент сжимает картинку заранее (lib/upload.ts → WebP ≤350КБ).
 */

const MAX_BASE64_LEN = 480_000 // ~350КБ бинарных = ~466К символов base64
const ALLOWED_RE = /^data:(image\/(?:webp|jpeg|png|gif));base64,([A-Za-z0-9+/=]+)$/

export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 20, windowMs: 5 * 60_000, bucket: 'upload' })
  if (!g.ok) return g.res

  try {
    const body = (await readJson(request)) as { data?: unknown }
    const raw = typeof body.data === 'string' ? body.data : ''
    const m = raw.match(ALLOWED_RE)
    if (!m) return err('Ожидается dataURL картинки (webp/jpeg/png/gif)')
    const mime = m[1]
    const b64 = m[2]
    if (b64.length > MAX_BASE64_LEN) return err('Картинка слишком большая (лимит ~350 КБ)')

    // Декодируем для честного размера (и отсечения мусора)
    const buf = Buffer.from(b64, 'base64')
    if (buf.length < 64) return err('Файл повреждён или пуст')

    const up = await db.upload.create({
      data: { ownerId: g.uid, mime, data: b64, bytes: buf.length },
      select: { id: true },
    })

    return NextResponse.json({ ok: true, url: `/api/upload/${up.id}`, bytes: buf.length })
  } catch (e) {
    console.error('[upload:post]', e)
    return err('Ошибка загрузки', 500)
  }
}
