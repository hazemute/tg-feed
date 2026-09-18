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
  /** «Температура» поста: -1 просмотр, +3 дочитали 5с+, +10 лайк, +20 репост */
  hotScore?: number
}

export function computeWeight(post: RankPost): number {
  const published =
    typeof post.publishedAt === 'string' ? new Date(post.publishedAt) : post.publishedAt
  const hours = Math.max(0, (Date.now() - published.getTime()) / 3_600_000)

  const engagement =
    post.likesCount * 10 + (post.bookmarksCount ?? 0) * 15 + (post.viewsCount ?? 0) * 0.3
  let weight = (post.premium ? 1000 : 0) + engagement / Math.pow(hours + 2, 1.5)

  /*
   * «Температура» поста (Redis-ранг из ТЗ, в нашей реализации — счётчик в Postgres):
   * реальные действия людей ПРЯМО СЕЙЧАС поднимают пост в ленте: дочитали 5с+ (+3),
   * лайк (+10), репост (+20); простой просмотр остужает (-1). Вклад гаснет со
   * временем (возраст поста в знаменателе) — «горячее» — это то, что интересно
   * другим читателям именно сегодня, эффект залипательной ленты.
   */
  const hot = post.hotScore ?? 0
  if (hot > 0) {
    weight += Math.min(260, hot * 2.4 / Math.pow(hours + 2, 1.1))
  }

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
 * Разнообразие ленты: один канал — НЕ подряд и ВИДНО РЕЖЕ, чем он «орёт».
 *
 * Жалоба пользователя: «ОДИН и ТОТ ЖЕ канал не повторялся в подряд ПОСТАМИ» —
 * прежнего «не более 1 подряд» мало: канал, заливший серию из 10 постов,
 * шёл через один (A B A B A) и забивал ленту. Теперь у канала — cooldown
 * (сколько ЧУЖИХ постов должны пройти между его постами), растущий с числом
 * его постов в окне: 2 поста → пауза 2, 3-4 → 3, 5-9 → 4, 10-19 → 6, 20+ → 8.
 *
 * Выбор жадный по порядку входа (вход отсортирован по весу — порядок качества
 * сохраняется): берём первый пост канала, у которого cooldown истёк. Если ВСЕ
 * каналы на cooldown (мало каналов / короткое окно) — берём пост самого
 * «забытого» канала (наибольшая пауза с последней выдачи), чтобы не деградировать.
 * Однородный список (один канал) возвращается как есть.
 */
export function diversify<T>(items: T[], channelIdOf: (item: T) => string): T[] {
  if (items.length < 3) return [...items]

  // Сколько постов канал имеет в окне → сколько чужих постов ждать между его постами
  const counts = new Map<string, number>()
  for (const it of items) {
    const ch = channelIdOf(it)
    counts.set(ch, (counts.get(ch) ?? 0) + 1)
  }
  const cooldownOf = (ch: string): number => {
    const n = counts.get(ch) ?? 1
    if (n <= 2) return 2
    if (n <= 4) return 3
    if (n <= 9) return 4
    if (n <= 19) return 6
    return 8
  }

  const rest = [...items]
  const out: T[] = []
  const lastAt = new Map<string, number>()

  while (rest.length > 0) {
    let picked = -1
    if (out.length === 0) {
      picked = 0 // самый тяжёлый пост открывает ленту
    } else {
      // 1) первый по порядку (по весу) канал с истёкшим cooldown
      for (let i = 0; i < rest.length; i++) {
        const ch = channelIdOf(rest[i])
        const last = lastAt.get(ch)
        if (last === undefined || out.length - last > cooldownOf(ch)) {
          picked = i
          break
        }
      }
      // 2) все на cooldown — самый забытый канал (максимум паузы; при равенстве — выше по весу)
      if (picked === -1) {
        let bestAge = -1
        for (let i = 0; i < rest.length; i++) {
          const ch = channelIdOf(rest[i])
          const age = out.length - (lastAt.get(ch) ?? 0)
          if (age > bestAge) {
            bestAge = age
            picked = i
          }
        }
      }
    }
    const [item] = rest.splice(picked, 1)
    lastAt.set(channelIdOf(item), out.length)
    out.push(item)
  }
  return out
}
