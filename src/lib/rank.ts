/**
 * Ранжирование ленты Tg Swipe — v6 (Task 5-c, полная переработка рекомендаций).
 *
 * МОДЕЛЬ СКОРИНГА (каждый пост):
 *
 *   score = КАЧЕСТВО × возрастноеЗатухание
 *         + СВЕЖЕСТЬ (экспонента, полураспад 36ч)
 *         + премиум/промо/«температура»
 *         − глобальные штрафы (жалобы, антиреклама)
 *
 *   КАЧЕСТВО — лог-шкала по каждому сигналу (жалоба «рекомендации баганные»:
 *   прежние линейные просмотры×0.3 превращали 10k views в ~3000 очков и
 *   давили ВСЁ остальное; лог бо́льшие числа растут медленно — 10 лайков
 *   значат много, разница между 10k и 20k просмотров — почти ничего):
 *     60·ln(1+лайки) + 45·ln(1+комментарии) + 50·ln(1+закладки)
 *     + 25·ln(1+реакцииTG) + 16·ln(1+просмотры)
 *
 *   СВЕЖЕСТЬ = 420 · 0.5^(часы/36) — полураспад 36 часов по ТЗ: пост первых
 *   двух часов стоит ~330-420, сутки — 210, трое суток — 66, неделя — 17.
 *
 *   КАЧЕСТВО затухает медленнее (полураспад 10 суток): вирусный пост остаётся
 *   «хорошим ответом» и после того, как остыл как новость, но к месячной
 *   давности теряет ~85% веса.
 *
 * ПЕРСОНАЛЬНЫЙ СЛОЙ (personalScoreParts) считается на каждом запросе поверх
 * кэшируемого глобального веса: аффинити к каналам/категориям (история
 * просмотров/лайков/закладок/источников), буст подписок, штрафы за
 * просмотренное/«не интересно»/скрытые тематики. Разделение boost/penalty
 * нужно для языкового множителя: ×0.35 для нерусских постов применяется к
 * положительной части скора, но НЕ смягчает штрафы.
 *
 * РАЗНООБРАЗИЕ (diversify) — round-robin по каналам с cooldown, чтобы канал
 * не шёл подряд и не занимал больше ~2 слотов на страницу.
 */

export type RankPost = {
  likesCount: number
  reactionsTg?: number // реакции исходного поста (t.me/s) — сильный сигнал качества
  bookmarksCount?: number
  commentsCount?: number
  viewsCount?: number
  publishedAt: Date | string
  premium: boolean
  /** «Температура» поста: -1 просмотр, +3 дочитали 5с+, +10 лайк, +20 репост */
  hotScore?: number
  /** Промо-пост (Snap Pro «Продвинуть в ленте»): время продвижения —
   *  в первые 48 часов после него пост получает огромный буст веса */
  promotedAt?: Date | string | null
}

// ------------------------- Глобальный вес (качество + свежесть) -------------------------

/** Вес лог-шкалы качества: множители подобраны так, чтобы
 *  «10 лайков + пара комментариев» ≈ свежий пост без вовлечения,
 *  а каждый следующий порядок величины давал всё меньший вклад */
const Q_LIKE = 60
const Q_COMMENT = 45
const Q_BOOKMARK = 50
const Q_REACTION = 25
const Q_VIEW = 16

/** Свежесть: базовый вес нового поста и полураспад 36ч (ТЗ Task 5-c) */
const FRESH_BASE = 420
const FRESH_HALF_LIFE_H = 36

/** Качество остывает медленнее свежести (полураспад 10 суток) */
const QUALITY_HALF_LIFE_H = 240

/** Плоский бонус проверенному (премиум) каналу — участие, не автопобеда */
const PREMIUM_BONUS = 350
/** Промо-пост (Snap Pro «Продвинуть в ленте»): плачу — значит в первых рядах.
 *  Буст на порядок выше премиального и гаснет линейно за 48 часов,
 *  пробивая и премиум-топ, и персональные бусты аффинити. */
const PROMO_BONUS = 2600
const PROMO_WINDOW_H = 48
/** Кап вклада «температуры» (реальные действия людей прямо сейчас) */
const HOT_CAP = 240

const toMs = (d: Date | string): Date => (typeof d === 'string' ? new Date(d) : d)

/** Экспоненциальное затухание: value × 0.5^(ageH/halfLifeH) */
function expDecay(value: number, ageH: number, halfLifeH: number): number {
  return value * Math.pow(0.5, ageH / halfLifeH)
}

/**
 * Глобальный вес поста (УРОВЕНЬ 1 — кэшируется для всех пользователей).
 * Персональные сигналы применяются ОТДЕЛЬНО (personalScoreParts) — уже после
 * кэша, на каждом запросе. См. шапку файла.
 */
export function computeWeight(post: RankPost): number {
  const published = toMs(post.publishedAt)
  const ageH = Math.max(0, (Date.now() - published.getTime()) / 3_600_000)

  // Лог-шкала качества (см. шапку): каждый сигнал по своему логарифму
  const quality =
    Q_LIKE * Math.log1p(Math.max(0, post.likesCount)) +
    Q_COMMENT * Math.log1p(Math.max(0, post.commentsCount ?? 0)) +
    Q_BOOKMARK * Math.log1p(Math.max(0, post.bookmarksCount ?? 0)) +
    Q_REACTION * Math.log1p(Math.max(0, post.reactionsTg ?? 0)) +
    Q_VIEW * Math.log1p(Math.max(0, post.viewsCount ?? 0) / 8)

  let weight = expDecay(quality, ageH, QUALITY_HALF_LIFE_H) + expDecay(FRESH_BASE, ageH, FRESH_HALF_LIFE_H)

  /*
   * «Температура» поста: реальные действия людей ПРЯМО СЕЙЧАС поднимают пост
   * в ленте: дочитали 5с+ (+3), лайк (+10), репост (+20); простой просмотр
   * остужает (-1). Вклад гаснет с той же свежестной экспонентой (36ч) —
   * «горячее» — это то, что интересно читателям именно сегодня.
   */
  const hot = post.hotScore ?? 0
  if (hot > 0) {
    weight += Math.min(HOT_CAP, hot * 2.2) * Math.pow(0.5, ageH / FRESH_HALF_LIFE_H)
  }

  if (post.premium) weight += PREMIUM_BONUS

  /*
   * Промо (Snap Pro): автор заплатил за продвижение — пост в первых рядах
   * в ЛЮБОЙ категории/разрезе ленты. Буст гаснет линейно: свежий промо —
   * гарантированный топ, 24ч — половина, 48ч — как обычный пост.
   */
  if (post.promotedAt) {
    const promoHours = Math.max(0, (Date.now() - toMs(post.promotedAt).getTime()) / 3_600_000)
    if (promoHours < PROMO_WINDOW_H) {
      weight += PROMO_BONUS * (1 - promoHours / PROMO_WINDOW_H)
    }
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
 *   (стабильный порядок внутри сессии).
 *
 * Task 5-c: в сид ДОЛЖЕН входить userId (роут подмешивает его) — тогда даже
 * два пользователя с пустой историей и одинаковым refresh-сидом получают
 * РАЗНЫе сигнатуры рекомендаций.
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

/**
 * v5.95: УСИЛЕННЫЙ шум ротации для ПРОСМОТРЕННЫХ постов.
 *
 * Жалоба владельца: «чтобы каждый раз новые посты были при заходе». Когда
 * почти весь пул уже просмотрен (маленький каталог), все посты несут один и
 * тот же −5000 и стоят по глобальному весу — базовый шум ≤900 не может
 * повернуть верх. Просмотренные получают ДОПОЛНИТЕЛЬНЫЙ сид-шум до 2600
 * (×0.5 веса): следующий заход поднимает ДРУГИЕ старые посты, а
 * непросмотренные ранжируются чисто. Детерминированно (сид внутри сессии
 * тот же → снапшот/пагинация стабильны). Соль хеша отлична от shuffleNoise —
 * корреляции с базовым шумом нет.
 */
export function viewedShuffleNoise(seed: string, weight = 0): number {
  if (!seed) return 0
  let h = (2166136261 ^ 0x9e3779b9) >>> 0
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  const unit = (h % 10000) / 10000
  return unit * Math.min(2600, Math.max(300, weight * 0.5))
}

// ------------------------- Языковой приоритет (Task 5-c) -------------------------

/**
 * Приоритет русскоязычного контента (ТЗ Task 5-c): нерусский пост в
 * рекомендациях получает множитель ×0.35 к ПОЛОЖИТЕЛЬНОЙ части скора
 * (качество + свежесть + персональные бусты), если пользователь НЕ
 * взаимодействовал с каналом. Иностранные посты не удаляются — просто
 * уходят под русские при прочих равных.
 */
export const FOREIGN_LANG_MULTIPLIER = 0.35
/**
 * Мем-посты без букв из нерусских каналов: язык неизвестен (прятать их
 * нельзя — медиа-лента пустела бы), но лёгкое понижение оправдано.
 */
export const UNDETECTED_FROM_FOREIGN_CHANNEL_MULTIPLIER = 0.6

/** Нужен ли посту языковой множитель (l — язык поста, cl — язык канала) */
export function isForeignForRanking(l: 'ru' | 'foreign' | 'und', cl: 'ru' | 'foreign' | 'und'): boolean {
  return l === 'foreign' || (l === 'und' && cl === 'foreign')
}

// ------------------------- Персональный слой -------------------------

/** Аффинити пользователя: счётчики взаимодействий на канал и на категорию */
export type AffinityMap = {
  channels: Map<string, number>
  categories: Map<string, number>
}

const CHANNEL_BOOST = 30
const CATEGORY_BOOST = 22
/** Подписка — декларативный сигнал: буст должен быть Заметным (Task 5-c),
 *  но не пробивать промо/жёсткие штрафы */
const SUBSCRIBED_BOOST = 140
/** Свежепросмотренный пост (≤48ч) — гарантированно вниз, но не теряется совсем */
const VIEWED_PENALTY = 5000
/** Просмотренное 2-7 суток назад — заметно вниз, но способно вернуться */
const VIEWED_PENALTY_MID = 2200
/** Давнопросмотренное (>7 суток) — мягкий штраф: пост снова «новый» через неделю,
 *  иначе у активного читателя лента выгорая до хвостового мусора (жалоба
 *  «рекомендации не работают» — при плоском штрафе 5000 почти весь индекс
 *  из 400 постов уходил в низ и лента показывала только остатки) */
const VIEWED_PENALTY_SOFT = 900
/**
 * «Не интересно» у канала. Владелец (v5.10): «если я нажал не интересно то
 * очевидно посты с этого канала не должны показываться либо редко» — раньше
 * штраф 900 пробивали премиум-топы и канал продолжал лезть в ленту. С Task 5-c
 * замьютнутые каналы ИСКЛЮЧАЮТСЯ из рекомендаций целиком (фильтр в /api/feed),
 * константа остаётся для совместимости и редких путей (fresh/поиск).
 */
export const NOT_INTERESTED_PENALTY = 2400
/**
 * v5.68 «Не интересно» на ПОСТ: категория скрытого поста получает отрицательный
 * сигнал — похожие посты (та же тематика) понижаются в персональной ленте,
 * но КАНАЛ остаётся (фундаментальное отличие от мьюта канала). Лог-скейлинг:
 * 1 скрытие ≈ −970, 3 ≈ −1900, 8 ≈ −3200 — одна случайная жалоба не убивает
 * всю тематику, но серия «мне это не интересно» заметно вытесняет её.
 */
export const DISLIKE_CATEGORY_PENALTY = 1400
/**
 * v5.68 антиреклама: канал, чьи посты собирают жалобы («Пожаловаться»),
 * понижается ГЛОБАЛЬНО для всех: distinct-жалобы × 220, кап 4000 (≈ полтора
 * премиум-бонуса — забаненный рекламный канал уходит глубоко, но не исчезает:
 * решение о полном удалении — за людьми).
 */
export const REPORT_PENALTY_PER = 220
export const REPORT_PENALTY_CAP = 4000
const EXPLORATION_BONUS = 18 // неизведанная категория — шанс пробиться в ленту (микро-открытия)
const UNSEEN_CHANNEL_BONUS = 10 // канал, с которым ещё не было взаимодействий — мягкое «открывашка» каналов

/**
 * Прогрессивный штраф за просмотренное (v5.27):
 * только что посмотрел (≤48ч) — жёсткий 5000 (не показывать одно и то же),
 * 2-7 суток — средний, старше недели — мягкий: пост за неделю «остывает»
 * и может честно вернуться в ленту (пересечение с новым трафиком не обнуляет историю).
 */
export function viewedPenalty(viewedAtMs?: number): number {
  if (!viewedAtMs) return VIEWED_PENALTY_SOFT
  const ageH = Math.max(0, (Date.now() - viewedAtMs) / 3_600_000)
  if (ageH <= 48) return VIEWED_PENALTY
  if (ageH <= 24 * 7) return VIEWED_PENALTY_MID
  return VIEWED_PENALTY_SOFT
}

export type PersonalBoostOpts = {
  channelId: string
  categoryId: string | null
  subscribed: boolean
  viewed: boolean
  affinity: AffinityMap
  notInterested?: boolean
  /** v5.68: сколько постов этой категории юзер уже скрыл («Не интересно») */
  dislikes?: number
  /** Когда пост был просмотрен (мс) — для прогрессивного штрафа; нет данных — плоский мягкий */
  viewedAtMs?: number
}

/**
 * Персональный слой скора, разделённый на boost/penalty (Task 5-c).
 *
 * Разделение нужно языковому множителю: ×0.35 применяется к положительной
 * части (глобальный вес + бусты), а штрафы (просмотрено/не интересно/дизлайк
 * тематики) НЕ смягчаются — нерусский пост, который юзер уже видел, остаётся внизу.
 *
 * Аффинити: каналы/категории из истории (просмотры ×1, лайки/закладки ×3,
 * источники «читаю каждый день» ×12 — см. loadPersonalSignals), логарифм —
 * 1-е взаимодействия важны, 100-й просмотр того же канала не должен
 * вытеснить весь остальной контент.
 *
 * Exploration: категория, с которой НЕ было взаимодействий, получает небольшой
 * бонус — лента периодически приносит что-то новое вместо замыкания на
 * привычных каналах (эффект «открывашки» TikTok/Дзена, но мягче).
 */
export function personalScoreParts(opts: PersonalBoostOpts): { boost: number; penalty: number } {
  const channelAff = opts.affinity.channels.get(opts.channelId) ?? 0
  const channelScore = Math.log1p(channelAff) * CHANNEL_BOOST
  const categoryAff = opts.categoryId
    ? (opts.affinity.categories.get(opts.categoryId) ?? 0)
    : 0
  const categoryScore = Math.log1p(categoryAff) * CATEGORY_BOOST
  const subScore = opts.subscribed ? SUBSCRIBED_BOOST : 0
  const viewedPenaltyScore = opts.viewed ? viewedPenalty(opts.viewedAtMs) : 0
  const notInterestedPenalty = opts.notInterested ? NOT_INTERESTED_PENALTY : 0
  // v5.68: «Не интересно» на пост = понижение ПРИОРИТЕТА ТЕМАТИКИ (канал живёт)
  const dislikePenalty =
    opts.dislikes && opts.dislikes > 0
      ? Math.round(DISLIKE_CATEGORY_PENALTY * Math.log1p(opts.dislikes))
      : 0
  // Бонус открытия действует, только когда у пользователя уже есть история:
  // у новорождённого аккаунта все категории «неизведанные» — бонус не нужен
  const hasHistory = opts.affinity.channels.size > 0 || opts.affinity.categories.size > 0
  const exploration =
    hasHistory && !opts.viewed && categoryAff === 0 && opts.categoryId !== null
      ? EXPLORATION_BONUS
      : 0
  // «Открывашка» каналов: знакомые категории, но нетронутый канал — шанс найти нового автора
  const unseenChannel =
    hasHistory && !opts.viewed && channelAff === 0 ? UNSEEN_CHANNEL_BONUS : 0
  return {
    boost: channelScore + categoryScore + subScore + exploration + unseenChannel,
    penalty: viewedPenaltyScore + notInterestedPenalty + dislikePenalty,
  }
}

/** Персональная прибавка (совместимая обёртка над personalScoreParts) */
export function personalBoost(opts: PersonalBoostOpts): number {
  const parts = personalScoreParts(opts)
  return parts.boost - parts.penalty
}

/**
 * Разнообразие ленты: один канал — НЕ подряд и ВИДНО РЕЖЕ, чем он «орёт».
 *
 * Жалоба пользователя: «ОДИН и ТОТ ЖЕ канал не повторялся в подряд ПОСТАМИ» —
 * прежнего «не более 1 подряд» мало: канал, заливший серию из 10 постов,
 * шёл через один (A B A B A) и забивал ленту. Теперь у канала — cooldown
 * (сколько ЧУЖИХ постов должны пройти между его постами), растущий с числом
 * его постов в окне: 2 поста → пауза 2, 3-4 → 3, 5-9 → 4, 10-19 → 6, 20+ → 8.
 * Вместе с капом 5 постов/канал в индексе (MAX_PER_CHANNEL в feed.ts) это
 * даёт ≤2 поста одного канала на страницу из 6 (ТЗ Task 5-c).
 *
 * Выбор жадный по порядку входа (вход отсортирован по весу — порядок качества
 * сохраняется): берём первый пост канала, у которого cooldown истёк. Если ВСЕ
 * каналы на cooldown (мало каналов / короткое окно) — берём пост самого
 * «забытого» канала (наибольшая пауза с последней выдачи), чтобы не деградировать.
 * Однородный список (один канал) возвращается как есть.
 *
 * recent (Task 6-c audit): каналы, ЧЬИ ПОСТЫ уже стоят в голове потока
 * (промо/спонсоры пиннятся ДО diversify). Они получают «виртуальную выдачу» на
 * позиции 0 — их органические посты не встанут вплотную к пинам и не дадут
 * «два подряд» на границе головы (аудит 6-c: промо QA-канала на позиции 0 и
 * первый органический пост того же канала шли подряд).
 */
export function diversify<T>(
  items: T[],
  channelIdOf: (item: T) => string,
  recent?: Iterable<string>,
): T[] {
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
  // Пины головы считаются «только что выданными» — органика этих каналов
  // соблюдает тот же cooldown, как будто пин стоит на позиции 0
  if (recent) for (const ch of recent) lastAt.set(ch, 0)

  while (rest.length > 0) {
    let picked = -1
    // 1) первый по порядку (по весу) канал с истёкшим cooldown. Для out.length=0
    //    условие то же: у не-pinned каналов last undefined → берётся самый
    //    тяжёлый пост (прежнее поведение), у pinned-каналов cooldown «запущен» —
    //    их органика не открывает поток вплотную к собственному пину (Task 6-c)
    for (let i = 0; i < rest.length; i++) {
      const ch = channelIdOf(rest[i])
      const last = lastAt.get(ch)
      if (last === undefined || out.length - last > cooldownOf(ch)) {
        picked = i
        break
      }
    }
    // 2) все на cooldown — самый забытый канал (максимум паузы; при равенстве — выше по весу).
    //    v5.97: из кандидатов ИСКЛЮЧАЕТСЯ канал предыдущего поста — иначе в хвосте
    //    (мало каналов, всё на cooldown) фолбэк ставил один канал два раза подряд.
    if (picked === -1) {
      const lastCh = out.length > 0 ? channelIdOf(out[out.length - 1]) : null
      let bestAge = -1
      for (let i = 0; i < rest.length; i++) {
        const ch = channelIdOf(rest[i])
        if (ch === lastCh && rest.length > 1) continue
        const age = out.length - (lastAt.get(ch) ?? 0)
        if (age > bestAge) {
          bestAge = age
          picked = i
        }
      }
      // единственный оставшийся канал — брать его (иначе цикл зависнет)
      if (picked === -1) {
        let bestAge2 = -1
        for (let i = 0; i < rest.length; i++) {
          const ch = channelIdOf(rest[i])
          const age = out.length - (lastAt.get(ch) ?? 0)
          if (age > bestAge2) {
            bestAge2 = age
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
