/**
 * Ранжирование ленты Tg Swipe — двухуровневая модель.
 *
 * УРОВЕНЬ 1 (глобальный, кэшируется для всех): качество поста.
 *   engagement = лайки ×10 + реакции TG ×6 + закладки ×15 + просмотры ×0.3
 *   weight = engagement / (часы + 2)^1.5
 *          + плоский бонус проверенному каналу (+350, без мультипликатора —
 *            раньше ×1000×3 задавил органический топ нулевыми постами)
 *          + вклад «температуры» (дочитали/лайк/репост ПРЯМО СЕЙЧАС)
 *          + бонус свежести (48 − часы) × 2 в первые двое суток
 *          − возрастное затухание после 7 суток (лента жива настоящим).
 *
 * УРОВЕНЬ 2 (персональный, применяется на каждом запросе): аффинити.
 *   + канал, с которым пользователь взаимодействовал (лайки/закладки/просмотры)
 *   + категория, которую он читает чаще других
 *   + подписки, микро-открытия новых категорий
 *   − уже просмотренные посты уходят в самый хвост.
 * Плюс гарантия разнообразия: cooldown между постами одного канала.
 */

export type RankPost = {
  likesCount: number
  reactionsTg?: number // реакции исходного поста (t.me/s) — сильный сигнал качества
  bookmarksCount?: number
  viewsCount?: number
  publishedAt: Date | string
  premium: boolean
  /** «Температура» поста: -1 просмотр, +3 дочитали 5с+, +10 лайк, +20 репост */
  hotScore?: number
  /** Промо-пост (Snap Pro «Продвинуть в ленте»): время продвижения —
   *  в первые 48 часов после него пост получает огромный буст веса */
  promotedAt?: Date | string | null
}

/** Плоский бонус проверенному (премиум) каналу — участие, не автопобеда */
const PREMIUM_BONUS = 350
/** Промо-пост (Snap Pro «Продвинуть в ленте»): плачу — значит в первых рядах.
 *  Буст на порядок выше премиального и гаснет линейно за 48 часов,
 *  пробивая и премиум-топ, и персональные бусты аффинити. */
const PROMO_BONUS = 2600
const PROMO_WINDOW_H = 48
/** Возрастная точка начала затухания и минимум множителя */
const AGE_DECAY_AFTER_H = 168 // 7 суток
const AGE_DECAY_MIN = 0.12

export function computeWeight(post: RankPost): number {
  const published =
    typeof post.publishedAt === 'string' ? new Date(post.publishedAt) : post.publishedAt
  const hours = Math.max(0, (Date.now() - published.getTime()) / 3_600_000)

  const engagement =
    post.likesCount * 10 +
    (post.reactionsTg ?? 0) * 6 +
    (post.bookmarksCount ?? 0) * 15 +
    (post.viewsCount ?? 0) * 0.3
  let weight = engagement / Math.pow(hours + 2, 1.5)

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

  if (post.premium) weight += PREMIUM_BONUS
  if (hours < 48) weight += (48 - hours) * 2

  /*
   * Промо (Snap Pro): автор заплатил за продвижение — пост в первых рядах
   * в ЛЮБОЙ категории/разрезе ленты. Буст гаснет линейно: свежий промо —
   * гарантированный топ, 24ч — половина, 48ч — как обычный пост.
   */
  if (post.promotedAt) {
    const promoted =
      typeof post.promotedAt === 'string' ? new Date(post.promotedAt) : post.promotedAt
    const promoHours = Math.max(0, (Date.now() - promoted.getTime()) / 3_600_000)
    if (promoHours < PROMO_WINDOW_H) {
      weight += PROMO_BONUS * (1 - promoHours / PROMO_WINDOW_H)
    }
  }

  /*
   * Возрастное затухание: постам старше 7 суток всё труднее конкурировать со
   * свежими (лента — про «что происходит сейчас», а не архив). Затухание
   * плавное: 7сут → ×1.0, 17сут → ×0.5, 27сут+ → ×0.12, чтобы ниша с малым
   * числом постов не пустела — старые просто тонут, но не исчезают.
   */
  if (hours > AGE_DECAY_AFTER_H) {
    weight *= Math.max(AGE_DECAY_MIN, 1 - (hours - AGE_DECAY_AFTER_H) / 240)
  }

  return weight
}

/** Небольшой детерминированный «шум» для разнообразия ленты между постами с близким весом */
export function rankJitter(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h % 15
}

/**
 * Шум перемешивания, пропорциональный ВЕСУ поста (жалоба владельца:
 * «постоянно одно и то же показывает» — прежний плоский шум ≤240 не мог
 * сдвинуть премиум-топ ~3000, и первые ряды ленты были застыли).
 *
 * При непустом сиде: h(seed) ∈ [0,1) × min(900, max(120, w×0.22)) —
 *   топ-посты (премиум/горячие) вращаются заметно (~600-900), середина —
 *   умеренно, хвост не поднимается над качеством. Пустой сид → 0
 *   (стабильный порядок внутри сессии; сервер сам подставляет часовой
 *   сид-ротацию, см. /api/feed).
 */
export function shuffleNoise(seed: string, weight = 0): number {
  if (!seed) return 0
  let h = 2166136261 >>> 0
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  const unit = (h % 10000) / 10000
  return unit * Math.min(900, Math.max(120, weight * 0.22))
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
 * «Не интересно» у канала. Владелец (v5.10): «если я нажал не интересно то
 * очевидно посты с этого канала не должны показываться либо редко» — раньше
 * штраф 900 пробивали премиум-топы и канал продолжал лезть в ленту. Теперь
 * ЭТО НЕ ШТРАФ, А ФИЛЬТР: /api/feed исключает мьютнутые каналы из выдачи,
 * оставляя детерминированные редкие появления (~4% каналов в день, см. там),
 * чтобы лента не замыкалась наглухо. Константа остаётся для тех редких
 * «возвращенцев» — они идут глубоко в хвост.
 */
export const NOT_INTERESTED_PENALTY = 2400
const EXPLORATION_BONUS = 7 // неизведанная категория — шанс пробиться в ленту (микро-открытия)

/**
 * Персональная прибавка к глобальному весу поста.
 * affinity.categories ключуется по ID категории (null — нейтрально).
 *
 * notInterested — канал, который пользователь скрыл кнопкой «Не интересно»:
 * посты канала не удаляются из ленты совсем (иначе лента скукоживается),
 * но уходят в самый хвост и возвращаются только когда нового мало.
 *
 * Exploration: категория, с которой НЕ было взаимодействий, получает небольшой
 * бонус — лента периодически приносит что-то новое вместо замыкания на
 * привычных каналах (эффект «открывашки» TikTok/Дзена, но мягче).
 */
export function personalBoost(opts: {
  channelId: string
  categoryId: string | null
  subscribed: boolean
  viewed: boolean
  affinity: AffinityMap
  notInterested?: boolean
}): number {
  const channelAff = opts.affinity.channels.get(opts.channelId) ?? 0
  // логарифм: 1-е взаимодействия важны, 100-й просмотр того же канала не должен
  // вытеснить весь остальной контент
  const channelScore = Math.log1p(channelAff) * CHANNEL_BOOST
  const categoryAff = opts.categoryId
    ? (opts.affinity.categories.get(opts.categoryId) ?? 0)
    : 0
  const categoryScore = Math.log1p(categoryAff) * CATEGORY_BOOST
  const subScore = opts.subscribed ? SUBSCRIBED_BOOST : 0
  const viewedPenalty = opts.viewed ? VIEWED_PENALTY : 0
  const notInterestedPenalty = opts.notInterested ? NOT_INTERESTED_PENALTY : 0
  // Бонус открытия действует, только когда у пользователя уже есть история:
  // у новорождённого аккаунта все категории «неизведанные» — бонус не нужен
  const hasHistory = opts.affinity.channels.size > 0 || opts.affinity.categories.size > 0
  const exploration =
    hasHistory && !opts.viewed && categoryAff === 0 && opts.categoryId !== null
      ? EXPLORATION_BONUS
      : 0
  return (
    channelScore +
    categoryScore +
    subScore +
    exploration -
    viewedPenalty -
    notInterestedPenalty
  )
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
