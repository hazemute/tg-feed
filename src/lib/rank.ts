/**
 * Ранжирование ленты Tg Swipe — двухуровневая модель.
 *
 * УРОВЕНЬ 1 (глобальный, кэшируется для всех): качество поста.
 *   weight = (премиум ×1000 ×3)
 *          + (лайки ×10 + закладки ×15 + просмотры ×0.3) / (часы + 2)^1.5
 *          + бонус свежести (48 − часы) × 2 в первые двое суток.
 *
 * УРОВЕНЬ 2 (персональный, применяется на каждом запросе): аффинити.
 *   + канал, с которым пользователь взаимодействовал (лайки/закладки/просмотры)
 *   + категория, которую он читает чаще других
 *   + подписки
 *   − уже просмотренные посты уходят в самый хвост (лента не показывает
 *     одно и то же, пока есть новое).
 * Плюс гарантия разнообразия: не более трёх постов одного канала подряд.
 */

export type RankPost = {
  likesCount: number
  bookmarksCount?: number
  viewsCount?: number
  publishedAt: Date | string
  premium: boolean
}

export function computeWeight(post: RankPost): number {
  const published =
    typeof post.publishedAt === 'string' ? new Date(post.publishedAt) : post.publishedAt
  const hours = Math.max(0, (Date.now() - published.getTime()) / 3_600_000)

  const engagement =
    post.likesCount * 10 + (post.bookmarksCount ?? 0) * 15 + (post.viewsCount ?? 0) * 0.3
  let weight = (post.premium ? 1000 : 0) + engagement / Math.pow(hours + 2, 1.5)

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

/** Шум перемешивания: при непустом сиде даёт 0..NOISE веса — обновление ленты
 *  показывает посты в новом порядке. Пустой сид → 0 (стабильный порядок внутри сессии). */
const SHUFFLE_NOISE = 240

export function shuffleNoise(seed: string): number {
  if (!seed) return 0
  let h = 2166136261 >>> 0
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return (h % 10000) / 10000 * SHUFFLE_NOISE
}

/** Аффинити пользователя: счётчики взаимодействий на канал и на категорию */
export type AffinityMap = {
  channels: Map<string, number>
  categories: Map<string, number>
}

const CHANNEL_BOOST = 22
const CATEGORY_BOOST = 10
const SUBSCRIBED_BOOST = 12
const VIEWED_PENALTY = 5000 // гарантированно вниз, но пост не теряется совсем

/**
 * Персональная прибавка к глобальному весу поста.
 * affinity.categories ключуется по ID категории (null — нейтрально).
 */
export function personalBoost(opts: {
  channelId: string
  categoryId: string | null
  subscribed: boolean
  viewed: boolean
  affinity: AffinityMap
}): number {
  const channelAff = opts.affinity.channels.get(opts.channelId) ?? 0
  // логарифм: 1-е взаимодействия важны, 100-й просмотр того же канала не должен
  // вытеснить весь остальной контент
  const channelScore = Math.log1p(channelAff) * CHANNEL_BOOST
  const categoryScore = opts.categoryId
    ? Math.log1p(opts.affinity.categories.get(opts.categoryId) ?? 0) * CATEGORY_BOOST
    : 0
  const subScore = opts.subscribed ? SUBSCRIBED_BOOST : 0
  const viewedPenalty = opts.viewed ? VIEWED_PENALTY : 0
  return channelScore + categoryScore + subScore - viewedPenalty
}

/**
 * Разнообразие ленты: не более MAX_IN_A_ROW постов одного канала подряд.
 * Жадный выбор из отсортированного списка: если текущая серия достигла
 * лимита — берём первый пост другого канала (каналы-многострочники
 * чередуются, а не вытесняют друг друга). Полностью однородный список
 * возвращается как есть (лимит снимается, иначе лента пуста).
 */
const MAX_IN_A_ROW = 1

export function diversify<T>(items: T[], channelIdOf: (item: T) => string): T[] {
  const rest = [...items]
  const out: T[] = []
  let runChannel: string | null = null
  let runLen = 0

  while (rest.length > 0) {
    let idx = rest.findIndex((it) => {
      const ch = channelIdOf(it)
      return !(ch === runChannel && runLen >= MAX_IN_A_ROW)
    })
    if (idx === -1) idx = 0 // весь остаток — один канал: лимит снимаем
    const [item] = rest.splice(idx, 1)
    const ch = channelIdOf(item)
    if (ch === runChannel) runLen++
    else {
      runChannel = ch
      runLen = 1
    }
    out.push(item)
  }
  return out
}
