import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'

export const dynamic = 'force-dynamic'

const linkField = z
  .string()
  .trim()
  .max(512)
  .refine((v) => /^https?:\/\//i.test(v), 'ссылка должна начинаться с http(s)://')

const createSchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(600),
  ctaLabel: z.string().trim().max(40).optional(),
  link: linkField,
  imageUrl: z.string().trim().max(512).optional().nullable(),
})

const patchSchema = z.object({
  id: z.string().min(1).max(64),
  isActive: z.boolean().optional(),
  title: z.string().trim().min(1).max(120).optional(),
  body: z.string().trim().min(1).max(600).optional(),
  ctaLabel: z.string().trim().max(40).optional(),
  link: linkField.optional(),
  imageUrl: z.string().trim().max(512).optional().nullable(),
})

function serialize(
  ad: {
    id: string
    title: string
    body: string
    ctaLabel: string
    link: string
    imageUrl: string | null
    isActive: boolean
    createdAt: Date
    impressions?: number
    clicks?: number
  },
  extra?: { impressions24h: number; clicks24h: number },
) {
  return {
    id: ad.id,
    title: ad.title,
    body: ad.body,
    ctaLabel: ad.ctaLabel,
    link: ad.link,
    imageUrl: ad.imageUrl,
    isActive: ad.isActive,
    createdAt: ad.createdAt.toISOString(),
    impressions: ad.impressions ?? 0,
    clicks: ad.clicks ?? 0,
    impressions24h: extra?.impressions24h ?? 0,
    clicks24h: extra?.clicks24h ?? 0,
  }
}

/**
 * GET /api/panel/ads — список рекламных записей. Доступ: x-admin-key. 120/мин/IP.
 */
export async function GET(request: Request) {
  const g = guardAdmin(request, { limit: 120, windowMs: 60_000, bucket: 'panel-ads' })
  if (!g.ok) return g.res

  try {
    const ads = await db.ad.findMany({ orderBy: { createdAt: 'desc' } })

    // Суточные суммы одним запросом: день (UTC) сегодня + вчера
    const since = new Date(Date.now() - 24 * 60 * 60_000)
    const days = [...new Set([dayKey(since), dayKey(new Date())])]
    const stats = await db.adStat.groupBy({
      by: ['adId'],
      where: { day: { in: days } },
      _sum: { impressions: true, clicks: true },
    })
    const byAd = new Map(stats.map((s) => [s.adId, s._sum]))

    return NextResponse.json({
      items: ads.map((ad) =>
        serialize(ad, {
          impressions24h: byAd.get(ad.id)?.impressions ?? 0,
          clicks24h: byAd.get(ad.id)?.clicks ?? 0,
        }),
      ),
    })
  } catch (e) {
    console.error('[panel/ads GET]', e)
    return err('ads failed', 500)
  }
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * POST /api/panel/ads { title, body, ctaLabel?, link, imageUrl? } — создать рекламу.
 * Лимит 30/мин/IP.
 */
export async function POST(request: Request) {
  const g = guardAdmin(request, { limit: 30, windowMs: 60_000, bucket: 'panel-ads-post' })
  if (!g.ok) return g.res

  try {
    const parsed = createSchema.safeParse(await readJson(request))
    if (!parsed.success) return err('title, body и link (http/https) обязательны')

    const ad = await db.ad.create({
      data: {
        title: parsed.data.title,
        body: parsed.data.body,
        ctaLabel: parsed.data.ctaLabel || 'Перейти',
        link: parsed.data.link,
        imageUrl: parsed.data.imageUrl || null,
      },
    })

    return NextResponse.json({
      ok: true,
      ad: serialize(ad, { impressions24h: 0, clicks24h: 0 }),
    })
  } catch (e) {
    console.error('[panel/ads POST]', e)
    return err('create failed', 500)
  }
}

/**
 * PATCH /api/panel/ads { id, isActive?, ...поля } — изменить рекламу.
 * Лимит 60/мин/IP.
 */
export async function PATCH(request: Request) {
  const g = guardAdmin(request, { limit: 60, windowMs: 60_000, bucket: 'panel-ads-patch' })
  if (!g.ok) return g.res

  try {
    const parsed = patchSchema.safeParse(await readJson(request))
    if (!parsed.success) return err('некорректные поля рекламы')
    const { id, ...fields } = parsed.data

    const data: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) data[k] = k === 'imageUrl' ? v || null : v
    }
    if (Object.keys(data).length === 0) return err('нужен хотя бы один изменяемый столбец')

    const ad = await db.ad.update({ where: { id }, data })
    return NextResponse.json({ ok: true, ad: serialize(ad, { impressions24h: 0, clicks24h: 0 }) })
  } catch (e) {
    console.error('[panel/ads PATCH]', e)
    return err('ad not found', 404)
  }
}

/**
 * DELETE /api/panel/ads?id=<adId> — удалить рекламу. Лимит 30/мин/IP.
 */
export async function DELETE(request: Request) {
  const g = guardAdmin(request, { limit: 30, windowMs: 60_000, bucket: 'panel-ads-del' })
  if (!g.ok) return g.res

  try {
    const id = (new URL(request.url).searchParams.get('id') ?? '').trim()
    if (!id || id.length > 64) return err('id required')

    await db.ad.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[panel/ads DELETE]', e)
    return err('ad not found', 404)
  }
}
