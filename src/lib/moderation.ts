import { db } from '@/lib/db'

/**
 * Модерация контента: NSFW-фильтр (эскорт-реклама, порно, слив 18+ и прочий
 * мусор, который просачивается в ленту из открытых TG-каналов).
 *
 * Принцип: ничего не удаляем из БД (данные не трогаем), но НЕ показываем
 * в пользовательских поверхностях:
 *  • каналы с явным NSFW-профилем (название/юзернейм/описание) — целиком;
 *  • посты с явным NSFW-текстом (спам-посты обычных каналов).
 *
 * Фильтр применяется на уровнях:
 *  • скоуп ленты (buildFeedScope) — каналы;
 *  • индекс ленты / fresh / поиск / спонсорские посты — тексты постов (SQL);
 *  • тренды/каталог/related — каналы + посты (JS-проверка после выборки).
 */

/* ------------------------------- Паттерны ------------------------------- */

/**
 * Жёсткие паттерны КАНАЛА (название/юзернейм/описание). Совпадение любого
 * = канал целиком скрыт из пользовательских поверхностей.
 * Специально без «sex»/«интим» одиночных — слишком много ложных.
 */
const NSFW_CHANNEL_RE: RegExp[] = [
  /x{3,}/i, // xxx и длиннее (user_xxx, XXXfeed) — «XXL» (две x) не задеваем
  /порно|\bporn/i,
  /\b18\s?\+/,
  /эскорт|\besco?rt/i,
  /индивидуалк|проститут|путан[аы]|шлюх/i,
  /onlyfans|fanvue|brazzers|stripchat|chaturbate|bongacams/i,
  /интим[- ]?(?:досуг|услуги|знакомств|салон|массаж)/i,
  /секс[- ]?(?:досуг|знакомств|видео|по\s?телефону)/i,
  /\bnsfw\b|\bnudes?\b|bdsm|femdom/i,
  /стриптиз|приватк|сливы?\s?18/i,
  // Узбекские эскорт-объявления: «ДАМ ОЛИШГА КИЗЛАР» (продажа девушек)
  /олишга|olishga|[\s№]кизлар|qizlar\b/i,
  // Казино/беттинг-спам (турецкий и ру): KOD ZAMANI, SOSYAL CASINO, HARLEY и т.п.
  /casino|казино|vavada|joycasino|mostbet|1xb(?:e|x)et|melbet|parimatch|fonbet|betting/i,
  /deneme\s?bonusu|bahis\s?siteleri|slot\s?siteleri|kod\s?zaman|güncel\s?giriş|bonus\s?kodları/i,
]

/** Пост-паттерны: спам-текст эскорт/18+ рекламы внутри поста. */
const NSFW_TEXT_RE: RegExp[] = [
  /эскорт|escort[- ]?service/i,
  /индивидуалк|проститутк|путан[аы]\b|шлюх/i,
  /интим[- ]?(?:досуг|услуги|знакомств|салон|массаж|за\s?деньги)/i,
  /секс[- ]?(?:досуг|знакомств|видео\s?чат|по\s?телефону)/i,
  /onlyfans|brazzers|stripchat|chaturbate|bongacams/i,
  /\b18\+\s?(?:контент|слив|подписк)/i,
  /порно\s?(?:видео|ролик|канал|чат|бот)/i,
  /\bxxx\s?(?:видео|контент|канал)/i,
  /девушки\s?за\s?(?:деньги|донат)|содержанк/i,
  /горячие\s?знакомства|взрослые\s?знакомства/i,
  // Узбекская эскорт-реклама в текстах: «2 Та Киз Ишледи», «дам олишга»
  /(?:киз|qiz|kiz)\s*ишл|(?:ишледи|ishledi)/i,
  /дам\s*олишга|dam\s*olishga/i,
  // Казино/беттинг-реклама в постах (в т.ч. легальные каналы, публикующие спам-посты)
  /(?:онлайн\s?)?казино|casino|mostbet|1xb(?:e|x)et|melbet|vavada|pin-?up\s?(?:casino|bet)/i,
  /deneme\s?bonusu|bahis\s?siteleri|slot\s?siteleri|güncel\s?giriş/i,
]

/* ------------------------- JS-проверки (дёшево) ------------------------- */

const EMPTY_TEXT = ''

export function isNsfwText(text: string | null | undefined): boolean {
  const t = text ?? EMPTY_TEXT
  if (t.length === 0) return false
  for (const re of NSFW_TEXT_RE) if (re.test(t)) return true
  return false
}

export function isNsfwChannelProfile(c: {
  title?: string | null
  username?: string | null
  description?: string | null
}): boolean {
  const hay = `${c.title ?? ''} ${c.username ?? ''} ${c.description ?? ''}`
  if (hay.trim().length === 0) return false
  for (const re of NSFW_CHANNEL_RE) if (re.test(hay)) return true
  return false
}

/**
 * SQL-подобные ключевые слова для фильтра на уровне БД (Prisma contains,
 * insensitive). Дешевле, чем тянуть все посты и фильтровать в JS; JS-паттерны
 * применяются вторым ходом поверх выборки при необходимости.
 */
export const NSFW_DB_KEYWORDS = [
  'эскорт',
  'escort',
  'индивидуалк',
  'проститут',
  'шлюх',
  'onlyfans',
  'brazzers',
  'stripchat',
  'chaturbate',
  'bongacams',
  'порно',
  'xxx',
  // узбекская эскорт-реклама
  'олишга',
  'olishga',
  'ишледи',
  'ishledi',
  // казино/беттинг-спам
  'casino',
  'казино',
  'mostbet',
  '1xbet',
  'vavada',
  'deneme bonusu',
  'bahis siteleri',
] as const

/** Ключевые слова для ПОИСКА КАНДИДАТОВ-КАНАЛОВ (шире постовых — «кизлар»
 *  («девушки») в названии канала практически всегда эскорт/спам). */
const CHANNEL_DB_KEYWORDS = [...NSFW_DB_KEYWORDS, 'кизлар', 'qizlar'] as const

/** Prisma-фрагмент для Post.findMany: текст поста не содержит ни одно ключевое слово.
 *  Через логический NOT — вложенный `not: { contains, mode }` mode не принимает. */
export function nsfwPostNotIn(): Array<Record<string, unknown>> {
  return NSFW_DB_KEYWORDS.map((kw) => ({
    NOT: { text: { contains: kw, mode: 'insensitive' as const } },
  }))
}

/* --------------------- Кэш NSFW-каналов (in-memory) --------------------- */
/**
 * Идентификаторы NSFW-каналов. Запрос лёгкий (фильтр по ключевым словам,
 * кандидатов единицы), кэш в памяти процесса на 10 минут: новые мусорные
 * каналы появляются с парсингом, лаг 10 минут неощутим.
 */
let nsfwIdsCache: { ids: string[]; exp: number } | null = null
const NSFW_IDS_TTL_MS = 10 * 60_000

export async function getNsfwChannelIds(): Promise<string[]> {
  if (nsfwIdsCache && nsfwIdsCache.exp > Date.now()) return nsfwIdsCache.ids

  try {
    const candidates = await db.channel.findMany({
      where: {
        OR: CHANNEL_DB_KEYWORDS.flatMap((kw) => [
          { title: { contains: kw, mode: 'insensitive' } },
          { username: { contains: kw, mode: 'insensitive' } },
          { description: { contains: kw, mode: 'insensitive' } },
        ]),
      },
      select: { id: true, title: true, username: true, description: true },
      take: 400,
    })
    const ids = candidates.filter((c) => isNsfwChannelProfile(c)).map((c) => c.id)
    nsfwIdsCache = { ids, exp: Date.now() + NSFW_IDS_TTL_MS }
    return ids
  } catch {
    // Деградация: при недоступной БД не блокируем ленту вовсе
    nsfwIdsCache = { ids: [], exp: Date.now() + 60_000 }
    return []
  }
}

/** Инвалидация кэша (например, после добавления нового канала парсером). */
export function invalidateNsfwCache(): void {
  nsfwIdsCache = null
}

/* -------------------- Фрагмент скоупа ленты (каналы) -------------------- */

/**
 * Дополнение к channel-части where ленты: исключить NSFW-каналы.
 * Возвращает channelId-список, который склеивается со скрытыми каналами
 * пользователя (один notIn вместо двух).
 */
export async function nsfwChannelIdFilter(): Promise<string[]> {
  return getNsfwChannelIds()
}
