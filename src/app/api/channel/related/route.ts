import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { guardPublic } from '@/lib/guard'
import { getNsfwChannelIds } from '@/lib/moderation'
import type { RelatedChannelDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

// Публичный рельс «Похожие каналы»; сессия опциональна — от неё зависит
// только исключение уже подписанных каналов. userId из query игнорируется.
const querySchema = z.object({
  username: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(10).catch(5),
})

/**
 * GET /api/channel/related?username=...&limit=5
 * «Похожие каналы» на экране канала: до limit АКТИВНЫХ каналов той же категории,
 * что и текущий канал. Исключаем сам канал и каналы, на которые юзер уже подписан.
 * Сортировка: премиум первыми, затем по числу подписчиков.
 * Форма ответа повторяет компактный DTO рельсов (как у /api/channels, но без id).
 */
export async function GET(request: Request) {
  const g = guardPublic(request, { limit: 120, windowMs: 60_000, bucket: 'related' })
  if (!g.ok) return g.res
  const userId = g.uid // string | null

  try {
    const { searchParams } = new URL(request.url)
    const parsed = querySchema.safeParse(Object.fromEntries(searchParams))
    if (!parsed.success) return err('username required')

    // Как в /api/channel: без @, в нижнем регистре (в БД username хранится в lowercase)
    const username = parsed.data.username.replace(/^@/, '').toLowerCase()
    if (!username) return err('username required')
    const limit = parsed.data.limit

    const channel = await db.channel.findFirst({
      where: { username },
      select: { id: true, categoryId: true },
    })
    if (!channel) return err('channel not found', 404)

    // Пул кандидатов с запасом: после фильтрации уже подписанных останется до limit
    const candidates = await db.channel.findMany({
      where: {
        status: 'active',
        categoryId: channel.categoryId,
        id: { not: channel.id, notIn: await getNsfwChannelIds() },
      },
      // каналы с известным реальным числом подписчиков — первыми
      orderBy: [
        { isPremium: 'desc' },
        { membersCount: { sort: 'desc', nulls: 'last' } },
        { subscribersCount: 'desc' },
      ],
      take: limit * 4,
      select: {
        id: true,
        title: true,
        username: true,
        avatarColor: true,
        photoFileId: true,
        avatarUrl: true,
        isPremium: true,
        verified: true,
        subscribersCount: true,
        membersCount: true,
        category: { select: { slug: true } },
      },
    })

    // Подписки юзера среди кандидатов (исключаем их из выдачи); у анонима их нет
    let subscribedIds = new Set<string>()
    if (userId && candidates.length > 0) {
      const subs = await db.subscription.findMany({
        where: { userId, channelId: { in: candidates.map((c) => c.id) } },
        select: { channelId: true },
      })
      subscribedIds = new Set(subs.map((s) => s.channelId))
    }

    const items: RelatedChannelDTO[] = candidates
      .filter((c) => !subscribedIds.has(c.id))
      .slice(0, limit)
      .map((c) => ({
        username: c.username,
        title: c.title,
        subscribers: c.membersCount ?? c.subscribersCount,
        isPremium: c.isPremium,
        verified: c.verified,
        avatarColor: c.avatarColor,
        avatarUrl: c.avatarUrl ?? (c.photoFileId ? `/api/avatar/c_${c.id}` : null),
        categorySlug: c.category?.slug ?? null,
        // После фильтрации всегда false (поле — для честного DTO и будущих переиспользований)
        subscribed: subscribedIds.has(c.id),
      }))

    return NextResponse.json({ items })
  } catch (e) {
    console.error('[channel/related]', e)
    return err('related failed', 500)
  }
}
