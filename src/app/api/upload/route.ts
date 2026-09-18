import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/**
 * POST /api/upload { data: dataURL, width?, height? } — картинка для чатов
 * (поддержка / предложка). Клиент СЖИМАЕТ (canvas → WebP/JPEG, максимум
 * ~1280px, ≤350КБ) — по приказу владельца картинки летят лёгкими, сервер
 * вторично не обрабатывает. Хранение — base64 в Postgres (объёмы крошечные,
 * отдельный сторадж не нужен). Выдача — публичный GET /api/upload/{id}
 * (некугадарный cuid, только чатовые картинки, без метаданных пользователя).
 */
const ALLOWED = new Set(['image/webp', 'image/jpeg', 'image/png'])
const MAX_BYTES = 350_000

const bodySchema = z.object({
  data: z
    .string()
    .min(30)
    .max(500_000)
    .regex(/^data:(image\/(?:webp|jpeg|png));base64,[A-Za-z0-9+/=]+$/),
  width: z.number().int().min(0).max(20000).optional(),
  height: z.number().int().min(0).max(20000).optional(),
})

export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 20, windowMs: 600_000, bucket: 'upload' })
  if (!g.ok) return g.res

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('invalid image (webp/jpeg/png ≤350KB)')
    const mime = parsed.data.data.slice(5, parsed.data.data.indexOf(';'))
    if (!ALLOWED.has(mime)) return err('unsupported mime')
    const base64 = parsed.data.data.slice(parsed.data.data.indexOf(',') + 1)
    const bytes = Math.floor((base64.length * 3) / 4)
    if (bytes > MAX_BYTES) return err('too large (≤350KB)')

    const row = await db.upload.create({
      data: {
        ownerId: g.uid,
        mime,
        data: base64,
        bytes,
        width: parsed.data.width ?? 0,
        height: parsed.data.height ?? 0,
      },
      select: { id: true },
    })
    return NextResponse.json({ ok: true, id: row.id, url: `/api/upload/${row.id}`, bytes })
  } catch (e) {
    console.error('[upload]', e)
    return err('upload failed', 500)
  }
}
