import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { guardPublic } from '@/lib/guard'
import { cacheAside } from '@/lib/redis'

export const dynamic = 'force-dynamic'

/**
 * GET /api/channels/similar?channelId=<id> — «Похожие каналы» (v5.93).
 *
 * Показывается под постом в полном экране: 3 канала ТАМОЙ ЖЕ категории,
 * живые (active), по убыванию подписчиков. Данные каналов глобальны —
 * кэшируются cacheAside (L0 память → Redis 10 мин → БД); персональный
 * флаг subscribed (если сессия есть) накладывается поверх кэша.
 *
 * Это «глубина сессии», а не реклама: только каналы из каталога ленты.
 */

const CACHE_TTL_SEC = 600

type SimilarLite = {
  id: string
  title: string
  username: string
  avatarColor: string
  avatarUrl: string | null
  subscribersCount: number
  verified: boolean
}

/** Глобальная часть: до 8 кандидатов одной категории (в роуте оставим 3) */
async function loadSimilar(channelId: string): Promise<SimilarLite[]> {
  const cur = await db.channel.findUnique({
    where: { id: channelId },
    select: { categoryId: true, status: true },
  })
  if (!cur || cur.status !== 'active') return []
  const rows = await db.channel.findMany({
    where: { categoryId: cur.categoryId, status: 'active', id: { not: channelId } },
    orderBy: { subscribersCount: 'desc' },
    take: 8,
    select: {
      id: true,
      title: true,
      username: true,
      avatarColor: true,
      avatarUrl: true,
      subscribersCount: true,
      verified: true,
    },
  })
  return rows
}

export async function GET(request: Request) {
  const g = guardPublic(request, { limit: 120, windowMs: 60_000, bucket: 'similar' })
  if (!g.ok) return g.res

  const url = new URL(request.url)
  const channelId = (url.searchParams.get('channelId') ?? '').trim()
  if (!channelId || channelId.length > 40) return err('channelId required')

  try {
    const all = await cacheAside<SimilarLite[]>({
      key: `similar:${channelId}`,
      ttlSec: CACHE_TTL_SEC,
      fetcher: () => loadSimilar(channelId),
    })

    // Поверх кэша — персональный флаг подписки (один индексный запрос)
    let subscribedIds = new Set<string>()
    if (g.uid && all.length > 0) {
      const subs = await db.subscription
        .findMany({ where: { userId: g.uid, channelId: { in: all.map((c) => c.id) } }, select: { channelId: true } })
        .catch(() => [])
      subscribedIds = new Set(subs.map((s) => s.channelId))
    }

    const similar = all.slice(0, 3).map((c) => ({ ...c, subscribed: subscribedIds.has(c.id) }))
    return NextResponse.json({ similar })
  } catch (e) {
    console.error('[channels/similar]', e)
    return err('similar failed', 500)
  }
}
