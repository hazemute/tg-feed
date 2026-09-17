import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'

export const dynamic = 'force-dynamic'

const STATUSES = ['active', 'moderation', 'rejected'] as const
type ChannelStatus = (typeof STATUSES)[number]

const PAGE_SIZE = 20

function parsePage(value: string | null): number {
  const n = Number(value ?? '1')
  return Number.isFinite(n) && n >= 1 ? Math.min(500, Math.floor(n)) : 1
}

/**
 * GET /api/panel/channels?status=all|active|moderation|rejected&q=&page=1
 * Полный список каналов с фильтрами (только админ-ключ). Лимит 120/мин/IP.
 */
export async function GET(request: Request) {
  const g = guardAdmin(request, { limit: 120, windowMs: 60_000, bucket: 'panel-ch' })
  if (!g.ok) return g.res

  try {
    const url = new URL(request.url)
    const statusRaw = url.searchParams.get('status') ?? 'all'
    const status: ChannelStatus | 'all' = (STATUSES as readonly string[]).includes(statusRaw)
      ? (statusRaw as ChannelStatus)
      : 'all'
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 64)
    const page = parsePage(url.searchParams.get('page'))

    const where: Prisma.ChannelWhereInput = {}
    if (status !== 'all') where.status = status
    if (q) {
      const qLower = q.toLowerCase()
      where.OR = [
        { username: { contains: qLower } },
        { title: { contains: qLower } },
        { title: { contains: q } },
      ]
    }

    const [total, channels] = await Promise.all([
      db.channel.count({ where }),
      db.channel.findMany({
        where,
        include: {
          category: { select: { id: true, title: true } },
          _count: { select: { posts: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
    ])

    return NextResponse.json({
      items: channels.map((c) => ({
        id: c.id,
        title: c.title,
        username: c.username,
        description: c.description,
        avatarColor: c.avatarColor,
        status: c.status,
        isPremium: c.isPremium,
        categoryId: c.categoryId,
        categoryTitle: c.category?.title ?? null,
        subscribersCount: c.subscribersCount,
        clicksCount: c.clicksCount,
        postsCount: c._count.posts,
        createdAt: c.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize: PAGE_SIZE,
    })
  } catch (e) {
    console.error('[panel/channels GET]', e)
    return err('channels failed', 500)
  }
}

const patchSchema = z.object({
  id: z.string().min(1).max(64),
  status: z.enum(STATUSES).optional(),
  isPremium: z.boolean().optional(),
})

/**
 * PATCH /api/panel/channels { id, status?, isPremium? }
 * Изменить статус/премиум канала. Лимит 60/мин/IP.
 */
export async function PATCH(request: Request) {
  const g = guardAdmin(request, { limit: 60, windowMs: 60_000, bucket: 'panel-ch-patch' })
  if (!g.ok) return g.res

  try {
    const parsed = patchSchema.safeParse(await readJson(request))
    if (!parsed.success) return err('id и status/isPremium обязательны')
    const { id, status, isPremium } = parsed.data
    if (status === undefined && isPremium === undefined) {
      return err('нужно указать status или isPremium')
    }

    const channel = await db.channel.update({
      where: { id },
      data: {
        ...(status !== undefined ? { status } : {}),
        // премиум: на 14 дней вперёд при включении, сброс при выключении
        ...(isPremium !== undefined
          ? { isPremium, premiumUntil: isPremium ? new Date(Date.now() + 14 * 24 * 3600 * 1000) : null }
          : {}),
      },
      select: { id: true, status: true, isPremium: true },
    })

    return NextResponse.json({ ok: true, channel })
  } catch (e) {
    console.error('[panel/channels PATCH]', e)
    return err('channel not found or update failed', 404)
  }
}

/**
 * DELETE /api/panel/channels?id=<channelId>
 * Удалить канал вместе с постами/подписками (каскад). Лимит 30/мин/IP.
 */
export async function DELETE(request: Request) {
  const g = guardAdmin(request, { limit: 30, windowMs: 60_000, bucket: 'panel-ch-del' })
  if (!g.ok) return g.res

  try {
    const id = (new URL(request.url).searchParams.get('id') ?? '').trim()
    if (!id || id.length > 64) return err('id required')

    await db.channel.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[panel/channels DELETE]', e)
    return err('channel not found', 404)
  }
}
