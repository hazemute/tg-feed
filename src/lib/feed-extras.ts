import { db } from '@/lib/db'
import { nsfwPostNotIn } from '@/lib/moderation'

/**
 * L0-кэш «экстрас» первой страницы ленты (память процесса, без Redis-команд).
 *
 * ЗАЧЕМ: страница 0 ленты — самый частый запрос приложения (каждое открытие,
 * каждый pull-to-refresh, каждая смена вкладки). Раньше она делала 2-3
 * ДОПОЛНИТЕЛЬНЫХ SQL-запроса на КАЖДЫЙ вызов:
 *   1) активные CPA-кампании (спонсорские channelId → campaignId);
 *   2) промо-посты (Snap Pro, окно 24ч, orderBy promotedAt);
 *   3) кандидаты спонсорских постов (последние посты спонсорских каналов).
 * Все три выборки ГЛОБАЛЬНЫЕ (персонализации внутри нет) — идеальные
 * кандидаты на короткий memo-кэш: lang-фильтр и «уже просмотренное»
 * накладываются поверх кэша на каждом запросе (см. /api/feed).
 *
 * Инвалидация: panel/ops и panel/ads (мутации кампаний) вызывают
 * clearFeedExtras() вместе с clearPageCache(). TTL 20с страхует остальное.
 */

const EXTRAS_TTL_MS = 20_000
/** Кандидатов спонсорских постов берём с запасом: персональный notIn
 *  (просмотренное/промо) вычитается в JS после кэша */
const SPONSOR_POOL = 18

type PostRef = { id: string; channelId: string; text: string }

type SponsorState = { map: Map<string, string>; exp: number }
type PoolState = { posts: PostRef[]; exp: number }

let sponsorState: SponsorState | null = null
let promoState: PoolState | null = null
const sponsorPoolState = new Map<string, PoolState>() // ключ — sorted channelIds

/** Активные CPA-кампании с бюджетом: channelId → campaignId */
export async function getSponsorChannelIds(): Promise<Map<string, string>> {
  if (sponsorState && sponsorState.exp > Date.now()) return sponsorState.map
  const rows = await db.adCampaign.findMany({
    where: { status: 'active', channelId: { not: null } },
    select: { id: true, channelId: true, budgetKop: true, spentKop: true },
  })
  const map = new Map<string, string>()
  for (const r of rows) {
    if (r.channelId && r.spentKop < r.budgetKop && !map.has(r.channelId)) {
      map.set(r.channelId, r.id)
    }
  }
  sponsorState = { map, exp: Date.now() + EXTRAS_TTL_MS }
  return map
}

/** Промо-посты (Snap Pro «Продвинуть»): окно 24ч, свежие сверху, ≤6 */
export async function getPromotedCandidates(): Promise<PostRef[]> {
  if (promoState && promoState.exp > Date.now()) return promoState.posts
  const posts = await db.post.findMany({
    where: {
      promotedAt: { gt: new Date(Date.now() - 24 * 3_600_000) },
      channel: { status: 'active' },
      AND: [
        ...nsfwPostNotIn(),
        { OR: [{ aiFlag: null }, { aiFlag: 'ok' }] },
      ],
    },
    orderBy: { promotedAt: 'desc' },
    take: 6,
    select: { id: true, channelId: true, text: true },
  })
  promoState = { posts, exp: Date.now() + EXTRAS_TTL_MS }
  return posts
}

/** Кандидаты спонсорских постов: последние посты каналов с активными кампаниями */
export async function getSponsorCandidates(channelIds: string[]): Promise<PostRef[]> {
  if (channelIds.length === 0) return []
  const key = [...channelIds].sort().join(',')
  const hit = sponsorPoolState.get(key)
  if (hit && hit.exp > Date.now()) return hit.posts

  const posts = await db.post.findMany({
    where: {
      channelId: { in: channelIds },
      AND: [
        ...nsfwPostNotIn(), // CPA-спам тоже проходит гигиену текста
        // ИИ-модерация: реклама не должна вести на junk/nsfw-посты
        { OR: [{ aiFlag: null }, { aiFlag: 'ok' }] },
      ],
    },
    orderBy: { publishedAt: 'desc' },
    take: SPONSOR_POOL,
    select: { id: true, channelId: true, text: true },
  })
  // карта пулов маленькая (≤ десяток комбинаций каналов) — чистим протухшие
  if (sponsorPoolState.size > 24) {
    const now = Date.now()
    for (const [k, v] of sponsorPoolState) if (v.exp <= now) sponsorPoolState.delete(k)
  }
  sponsorPoolState.set(key, { posts, exp: Date.now() + EXTRAS_TTL_MS })
  return posts
}

/** Сброс всех memo-кэшей экстрас (мутации кампаний/промо в админке) */
export function clearFeedExtras(): void {
  sponsorState = null
  promoState = null
  sponsorPoolState.clear()
}
