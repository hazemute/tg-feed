import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { guardPublic } from '@/lib/guard'
import { cacheAside, famKey } from '@/lib/redis'
import { getNsfwChannelIds } from '@/lib/moderation'
import { channelAvatarUrl } from '@/lib/media'
import { jsonWithEtag } from '@/lib/etag'

export const dynamic = 'force-dynamic'

// Публичный каталог; сессия опциональна — от неё зависит только флаг subscribed.
const querySchema = z.object({
  category: z.string().max(64).regex(/^[a-z0-9_-]*$/).catch(''),
  q: z.string().trim().max(100).catch(''),
  // v5.76: сид ротации — одинаковый сид = одинаковый порядок, новый сид =
  // ГЛОБАЛЬНО новый порядок каналов (жалоба «при обновлении одни и те же»)
  rot: z.string().trim().max(64).regex(/^[a-zA-Z0-9_-]*$/).catch(''),
})

/** Детерминированный «хеш» строки → число (FNV-1a) */
function hashSeed(str: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

type ChannelItem = Omit<Awaited<ReturnType<typeof loadChannels>>[number], 'subscribed'> & {
  subscribed: boolean
}

/**
 * GET /api/channels?category=&q=
 * Каталог активных каналов (для вкладки «Категории»).
 * Без сессии — анонимный просмотр: subscribed = false у всех.
 * Redis: список каналов (глобальная часть, нейтральные флаги) кэшируется
 * на 60с при пустом q; флаг subscribed накладывается после кэша.
 */
export async function GET(request: Request) {
  const g = guardPublic(request, { limit: 120, windowMs: 60_000, bucket: 'channels' })
  if (!g.ok) return g.res
  const userId = g.uid // string | null

  try {
    const { searchParams } = new URL(request.url)
    const parsed = querySchema.safeParse(Object.fromEntries(searchParams))
    const category = parsed.success ? parsed.data.category : ''
    const q = parsed.success ? parsed.data.q : ''

    let items: ChannelItem[]
    const rot = parsed.success ? parsed.data.rot : ''
    if (q) {
      items = await loadChannels(category, q)
    } else {
      items = await cacheAside({
        key: await famKey('ch', `${category || 'all'}|rot:${rot}`),
        ttlSec: rot ? 300 : 60,
        memoryTtlMs: rot ? 30_000 : 10_000,
        fetcher: () => loadChannels(category, ''),
      })
    }

    // v5.76: ротация — детерминированное перемешивание по сиду (премиум-буст
    // сохраняем частично: премиум не выкидываем из первой половины списка)
    if (rot) {
      items = rotateChannels(items, rot)
    }

    // Персонализация поверх кэша
    if (userId && items.length > 0) {
      const subs = await db.subscription.findMany({
        where: { userId, channelId: { in: items.map((c) => c.id) } },
        select: { channelId: true },
      })
      const subSet = new Set(subs.map((s) => s.channelId))
      items = items.map((c) => ({ ...c, subscribed: subSet.has(c.id) }))
    }

    // v5.49: ETag/304 — каталог каналов рендерится из локального кэша
    return jsonWithEtag(request, { items })
  } catch (e) {
    console.error('[channels]', e)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}

/**
 * v5.76: детерминированная ротация каталога по сиду.
 * Сортировка по hash(seed + channelId) — каждый новый сид даёт полностью
 * другой порядок (но один и тот же сид всегда даёт один и тот же список —
 * пагинация/фильтры стабильны). Премиум-каналы остаются в первых 60% —
 * монетизация не ломается, но внутри премиум/обычных групп порядок крутится.
 */
function rotateChannels(items: ChannelItem[], rot: string): ChannelItem[] {
  const scored = items.map((c) => ({ c, h: hashSeed(`${rot}:${c.id}`) }))
  scored.sort((a, b) => a.h - b.h)
  const shuffled = scored.map((x) => x.c)
  const premiumFirst = shuffled.filter((c) => c.isPremium)
  const rest = shuffled.filter((c) => !c.isPremium)
  const premiumCap = Math.max(3, Math.ceil(items.length * 0.6) - premiumFirst.length)
  if (premiumFirst.length === 0 || premiumCap <= 0) return shuffled
  const head = [...premiumFirst, ...rest.slice(0, premiumCap)]
  const tail = rest.slice(premiumCap)
  // детерминированно вращаем голову, чтобы премиум не всегда был самым первым
  const shift = hashSeed(`shift:${rot}`) % Math.max(1, head.length)
  return [...head.slice(shift), ...head.slice(0, shift), ...tail]
}

async function loadChannels(category: string, q: string) {
  // NSFW-каналы не попадают в каталог ни при каком поиске
  const channels = await db.channel.findMany({
    where: {
      status: 'active',
      id: { notIn: await getNsfwChannelIds() },
      ...(category ? { category: { slug: category } } : {}),
      ...(q ? { OR: [{ title: { contains: q } }, { username: { contains: q } }] } : {}),
    },
    // egress (11-a): select вместо include — styleProfile/avatarVideoUrl и пр.
    // (тяжёлые служебные колонки) из каталога не отдаются
    select: {
      id: true,
      title: true,
      username: true,
      description: true,
      avatarColor: true,
      avatarUrl: true,
      photoFileId: true,
      membersCount: true,
      subscribersCount: true,
      isPremium: true,
      status: true,
      category: { select: { slug: true, title: true } },
      _count: { select: { posts: true } },
    },
    // сначала каналы с известным реальным числом подписчиков (Bot API), потом без
    orderBy: [
      { isPremium: 'desc' },
      { membersCount: { sort: 'desc', nulls: 'last' } },
      { subscribersCount: 'desc' },
    ],
    take: 100,
  })

  return channels.map((c) => ({
    id: c.id,
    title: c.title,
    username: c.username,
    description: c.description?.replace(/\s+/g, ' ').trim() ?? null,
    avatarColor: c.avatarColor,
    // v5.56: единый хелпер — мёртвые supabase-ссылки → Bot API-фолбэк,
    // прямые ссылки Telegram CDN → /api/media (Vercel CDN кэширует)
    avatarUrl: channelAvatarUrl(c.avatarUrl, c.photoFileId, c.id),
    subscribersCount: c.membersCount ?? c.subscribersCount,
    isPremium: c.isPremium,
    status: c.status,
    categorySlug: c.category?.slug ?? null,
    categoryTitle: c.category?.title ?? null,
    postsCount: c._count.posts,
    subscribed: false as const,
  }))
}
