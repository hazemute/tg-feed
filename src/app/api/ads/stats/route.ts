import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { guardPublic } from '@/lib/guard'
import { cacheAside, famKey, shortHash } from '@/lib/redis'

export const dynamic = 'force-dynamic'

export type AdsPlatformStats = {
  /** Активных каналов в ленте */
  channels: number
  /** Постов в базе (реальный контент) */
  posts: number
  /** Пользователей миниаппа */
  users: number
  /** Просмотров постов за 24 часа */
  views24h: number
  /** Активных рекламных кампаний сейчас */
  adsActive: number
}

/**
 * GET /api/ads/stats — живая статистика площадки для шита «Продвинуть канал».
 * Рекламодатель до покупки видит реальный охват: сколько каналов, пользователей
 * и просмотров за сутки. Кэш 60с — счётчики не молотят БД на каждый запрос.
 */
export async function GET(request: Request) {
  const g = guardPublic(request, { limit: 60, windowMs: 60_000, bucket: 'ads-stats' })
  if (!g.ok) return g.res

  try {
    const load = async (): Promise<AdsPlatformStats> => {
      const since = new Date(Date.now() - 24 * 60 * 60_000)
      const [channels, posts, users, views24h, adsActive] = await db.$transaction([
        db.channel.count({ where: { status: 'active' } }),
        db.post.count(),
        db.user.count(),
        db.postView.count({ where: { createdAt: { gte: since } } }),
        db.ad.count({ where: { isActive: true } }),
      ])
      return { channels, posts, users, views24h, adsActive }
    }

    const key = await famKey('ct', 'ads:stats:v2')
    const data = await cacheAside({ key, ttlSec: 60, memoryTtlMs: 15_000, fetcher: load })
    return NextResponse.json(data)
  } catch (e) {
    console.error('[ads/stats]', e)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
