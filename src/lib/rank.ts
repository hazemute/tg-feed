/**
 * Алгоритм ранжирования ленты Tg Swipe (MVP, без ИИ).
 *
 * Weight = (Премиум * 1000) + (Лайки * 10) / (Часы_с_публикации + 2)^1.5
 *  - premium-каналы дополнительно усиливаются ×3 («вылетают в 3 раза чаще»)
 *  - свежие посты (до 48 часов) получают бонус (48 - часы) * 2
 */
export function computeWeight(post: {
  likesCount: number
  publishedAt: Date | string
  premium: boolean
}): number {
  const published =
    typeof post.publishedAt === 'string' ? new Date(post.publishedAt) : post.publishedAt
  const hours = Math.max(0, (Date.now() - published.getTime()) / 3_600_000)

  const base = (post.likesCount * 10) / Math.pow(hours + 2, 1.5)
  let weight = (post.premium ? 1000 : 0) + base

  if (post.premium) weight *= 3
  if (hours < 48) weight += (48 - hours) * 2

  return weight
}

/** Небольшой детерминированный «шум» для разнообразия ленты между постами с близким весом */
export function rankJitter(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h % 15
}
