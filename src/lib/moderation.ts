import { db } from '@/lib/db'
import { IS_SQLITE } from '@/lib/server'

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
  // Турецкий беттинг-промо в названиях/профилях: SKOR BET, VIP ORAN (KOD ZAMANI DUYURU и клоны)
  /skor\s?bet|vip\s?oran|iddaa\s?kupon|bahis\s?kodu/i,
  // Китайскоязычные гемблинг-сети ЮВА: 【2028体育】, 东南亚曝光/悬赏, 影视导航 и клоны
  /体育.{0,6}(?:平台|台)|玩家首选|信誉平台|娱乐城|博彩|老虎机|六合彩|足彩|棋牌游艺/i,
  /东南亚.{0,12}(?:曝光|悬赏|博彩|娱乐|大事件)/,
  /影视导航|网址导航|导航喵/,
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
  // Турецкий беттинг-промо в постах: «SKOR BET — VIP ORAN 20», купоны
  /skor\s?bet|vip\s?oran|iddaa|bahis\s?kupon/i,
  // Китайскоязычный гемблинг-спам: 玩家首选, 信誉平台, 娱乐城, 六合彩 и т.п.
  /玩家首选|信誉平台|全网最大信誉|娱乐城|博彩|老虎机|六合彩|足彩|棋牌|线上娱乐|体育.{0,4}投/i,
  // Подавляюще китайский текст (10+ иероглифов подряд) — сети ЮВА; в ру-ленте таких легитимных нет
  /[一-鿿「」『』。，！？]{10,}/,
]

/* ------------------------- JS-проверки (дёшево) ------------------------- */

const EMPTY_TEXT = ''

/** SQLite (локальная песочница) не поддерживает mode:'insensitive' в contains */
const IS_SQLITE_LOCAL = IS_SQLITE

/** insensitive-фрагмент contains, совместимый и с Postgres, и с SQLite */
function ci(value: string): Record<string, unknown> {
  return IS_SQLITE_LOCAL
    ? { contains: value }
    : { contains: value, mode: 'insensitive' as const }
}

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
  'skor bet',
  'vip oran',
  'iddaa',
  // китайскоязычный гемблинг (ЮВА-сети)
  '玩家首选',
  '信誉平台',
  '娱乐城',
  '博彩',
  '老虎机',
  '六合彩',
  '棋牌',
  '线上娱乐',
  // HYIP-пирамиды (уже опубликованные посты не должны показываться)
  'guaranteed returns',
  'investment packages',
  'forex investment',
  'daily payouts',
] as const

/** Ключевые слова для ПОИСКА КАНДИДАТОВ-КАНАЛОВ (шире постовых — «кизлар»
 *  («девушки») в названии канала практически всегда эскорт/спам). */
const CHANNEL_DB_KEYWORDS = [...NSFW_DB_KEYWORDS, 'кизлар', 'qizlar'] as const

/** Prisma-фрагмент для Post.findMany: текст поста не содержит ни одно ключевое слово.
 *  Через логический NOT — вложенный `not: { contains, mode }` mode не принимает. */
export function nsfwPostNotIn(): Array<Record<string, unknown>> {
  return NSFW_DB_KEYWORDS.map((kw) => ({
    NOT: { text: ci(kw) },
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
          { title: ci(kw) },
          { username: ci(kw) },
          { description: ci(kw) },
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

/* ------------------ Рекламные клише и кликбейт (ingest-фильтр) ------------------ */

/**
 * Пост-реклама по клише: «читать продолжение в источнике», «смотри закреп»,
 * «переходи в бота», платные промо с маркером erid и т.п. Такие посты НЕ
 * создаются парсером вообще (см. parse-engine) — лента остаётся чистой от
 * прогревочного и рекламного мусора. Список консервативный: только явные
 * маркеры, легальные посты («подробнее», «ссылка ниже») не задеваем.
 */
const AD_CLICHE_RE: RegExp[] = [
  /\berid\s*[:№]/i, // российский юридический маркер рекламы
  /#реклама\b|#ad\b|#промо\b|#[аa]дмин(?:_)?реклам/i,
  /на правах рекламы|размещено на правах|рекламодател/i,
  /по вопросам (?:рекламы|сотрудничества)|сотрудничество[:\s]*(?:@|\bt\.me\b|телеграм)/i,
  /читать(?:\s)?(?:продолжение|дальше|полностью)\s+(?:в|на)\s+(?:источнике|сайте|канале|боте)/i,
  /продолжение (?:в источнике|на сайте|по ссылке)/i,
  /смотри(?:те)? (?:закреп|первый комментарий|следующий пост)/i,
  /ответ (?:в закрепе|в первом комментарии)/i,
  /переходи?(?:те)?\s+(?:в\s+)?(?:нашего\s+)?бота/i,
  /пиши (?:боту|в бота)[^а-я]*@/i,
  /забирай(?:те)? (?:по ссылке|в боте|курс|гайд|чек-лист|методичку)\s*(?:по ссылке|в боте|бесплатно)/i,
  /промокод.{0,40}(?:скидк|бонус|бесплат|активир|введи)/i,
  /успей (?:получить|забрать|воспользоваться)/i,
  /старт(?:уй)? (?:заработок|зарабатывать)|начни зарабатывать|пассивный доход\s?\d|доход (?:до|от)\s?\d+\s?(?:000\s?)?(?:₽|руб|тыс)/i,
  /инвестируй (?:с|в|через)\s+(?:нами|нас|@|\bt\.me\b)/i,
  /подписывайся на (?:наш|нас)\s*(?:канал|бот)/i,
  /покупай (?:со )?скидк(?:ой|ой до)\s?\d{2,}%/i,
  // Гемблинг-промо любых языков — реклама по определению, в ленту не проходит:
  /casino|казино|mostbet|1xb(?:e|x)et|melbet|vavada|pin-?up\s?(?:casino|bet)|fonbet|parimatch/i,
  /deneme\s?bonusu|bahis\s?siteleri|skor\s?bet|vip\s?oran|iddaa/i,
  /玩家首选|信誉平台|娱乐城|博彩|老虎机|六合彩|线上娱乐/i,
  /[一-鿿「」『』。，！？]{10,}/,
  // HYIP-пирамиды: «Invest 10,000 Birr → Earn 180,000», «guaranteed returns»
  /invest\s+(?:from\s+)?[\d,]{3,}[^.\n]{0,60}(?:→|->|=>)\s*(?:earn|get|receive|profit)/i,
  /guaranteed\s+(?:returns?|profit|daily)/i,
  /earn(?:ing)?\s+(?:up\s+to\s+)?\d{3,}\s*%/i,
  /\bhyip\b|forex\s+investment|investment\s+(?:packages?|plans?\s+for\s+investors)/i,
  /daily\s+(?:payouts?|profits?\s+of)/i,
  /удво(?:ю|им|ить)\s+(?:твои|ваш)(?:и)?\s+деньги|быстрый\s+доход\s+без\s+вложений/i,
]

/**
 * Является ли пост рекламным клише-постом (реклама/кликбейт/прогрев).
 * Работает по первым 600 символам + по хвосту (рекламные дисклеймеры часто в конце).
 */
export function isAdCliche(text: string | null | undefined): boolean {
  if (!text) return false
  const t = text.length > 1200 ? text.slice(0, 600) + text.slice(-300) : text
  return AD_CLICHE_RE.some((re) => re.test(t))
}

/* ================= v5.68: АНТИРЕКЛАМА В КОММЕНТАРИЯХ (без ИИ) ================= */

/**
 * Умный эвристический скрипт для «чата под постом»: оценка 0..100 за признаки
 * рекламы/спама. Порог AUTO_HIDE_SCORE (45+) → комментарий создаётся скрытым
 * (Comment.hidden): автор видит свой коммент с плашкой, остальные — нет.
 * LLM не нужен: правила покрывают типовой спам за микросекунды; порог требует
 * НЕСКОЛЬКИХ признаков или явного спам-паттерна — обычные разговоры не задевает.
 */

export type AdVerdict = {
  score: number
  reasons: string[]
  hidden: boolean
}

/** Порог авто-скрытия комментария */
export const AUTO_HIDE_SCORE = 45

// Телефоны: +7 999 123-45-67, 8(999)1234567, +380...
// ВАЖНО: \b в JS определён по ASCII — с кириллицей НЕ работает, поэтому
// для русских слов используем подстрочные стемы без \b.
const COMMENT_PHONE_RE = /(?:\+?\d[\d\s\-()]{8,}\d)/
// Telegram-ссылки/упоминания: t.me/xxx, @username
const COMMENT_TME_RE = /(?:https?:\/\/)?t\.me\/[A-Za-z0-9_]{3,}/gi
const COMMENT_MENTION_RE = /@[a-zA-Z][a-zA-Z0-9_]{3,}/g
// Обычные URL
const COMMENT_URL_RE = /(?:https?:\/\/|www\.)[^\s]{4,}/gi
// Промо-лексика комментариев (стемы — без \b, кириллица)
const COMMENT_PROMO_PATTERNS: Array<[RegExp, number, string]> = [
  [/по\s?(?:всем\s)?вопросам\s?(?:реклам|сотрудничеств)/i, 22, 'призыв «по вопросам рекламы»'],
  [/(?:пиш\s?и\s?те|пиши|писать|напишите)\s?(?:мне\s)?(?:в\s|прямо\s)?(?:лс|личку|телеграм|личные)/i, 20, 'призыв «пишите в ЛС»'],
  [/(?:звоните|звони|наберите|по\s?телефону)/i, 8, 'призыв «звоните»'],
  [/(?:купить|заказать|продам|продаю|продажа|услуги|прайс|оплата|переводом|наличными)/i, 12, 'продажа/услуги'],
  [/(?:скидк|акци|промокод|купон|распродаж|бонус)/i, 10, 'акции/скидки/бонус'],
  [/(?:заработок|заработка|зарабатывать|заработать|пассивн|доход\s?от|доход\s?до)/i, 14, '«заработок»'],
  [/(?:сигналы?|сигналов|трейдинг|букмекер|аирдроп|airdrop|инвестируй)/i, 20, 'betting/crypto-спам'],
  [/(?:накрутк|подписчики\s?(?:за|от|дешево)|просмотры\s?(?:за|от)|реакции\s?(?:за|от)|боты\s?за)/i, 18, 'накрутка/услуги ботов'],
  [/(?:подписывайтесь|подписывайся|переходите?\s(?:в|на)\s(?:канал|бот)|переходи\s(?:в|на))/i, 16, 'призыв подписаться'],
  [/(?:onlyfans|приват(?:ы|ки)|эскорт|интим|casino|казино|mostbet|1xb(?:e|x)et|melbet|vavada|pin-?up)/i, 25, '18+/гемблинг-спам'],
]
const COMMENT_EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu

export function scanAd(text: string): AdVerdict {
  const t = (text ?? '').slice(0, 2000)
  const reasons: string[] = []
  let score = 0
  const add = (n: number, why: string) => {
    score += n
    reasons.push(why)
  }

  if (t.length < 4) return { score: 0, reasons, hidden: false }

  // Телефон: цифр много, букв мало
  if (COMMENT_PHONE_RE.test(t.replace(/[a-zA-Zа-яёА-ЯЁ]{3,}/g, ' '))) add(25, 'номер телефона')

  const tme = t.match(COMMENT_TME_RE) ?? []
  const mentions = t.match(COMMENT_MENTION_RE) ?? []
  const tgRefs = tme.length + mentions.length
  if (tme.length >= 1) add(14, 'ссылка t.me')
  if (mentions.length >= 1) add(10, 'упоминание @')
  if (tgRefs >= 2) add(16, `${tgRefs} телеграм-ссылки/упоминания`)

  const urls = t.match(COMMENT_URL_RE) ?? []
  if (urls.length >= 1 && tme.length === 0) add(urls.length >= 2 ? 18 : 10, 'внешняя ссылка')

  let promoHits = 0
  for (const [re, w, why] of COMMENT_PROMO_PATTERNS) {
    if (re.test(t)) {
      add(w, why)
      promoHits++
    }
  }
  // 3+ разных промо-паттерна — почти наверняка реклама
  if (promoHits >= 3) add(14, 'много промо-признаков')

  // СПАМ-КАПС: доля заглавных в «буквенной» части
  const letters = t.replace(/[^\p{L}]/gu, '')
  if (letters.length >= 24) {
    const upper = letters.replace(/[^\p{Lu}]/gu, '').length
    if (upper / letters.length > 0.6) add(14, 'СПАМ-КАПС')
  }

  // Эмодзи-лепестки
  const emojis = t.match(COMMENT_EMOJI_RE) ?? []
  if (emojis.length >= 8) add(8, 'эмодзи-спам')

  // «Текст = ссылка»: содержательных слов нет, только ссылки/упоминания
  const words = t
    .replace(COMMENT_TME_RE, ' ')
    .replace(COMMENT_URL_RE, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1).length
  if (tgRefs + urls.length >= 1 && words <= 2) add(32, 'текст = ссылка')
  else if (tgRefs + urls.length >= 1 && words <= 4) add(18, 'почти без текста')

  score = Math.min(100, score)
  return { score, reasons, hidden: score >= AUTO_HIDE_SCORE }
}

/** Бонус за флуд: тот же текст, что у предыдущего коммента этого юзера под постом */
export function scanFloodBonus(sameTextBefore: boolean): number {
  return sameTextBefore ? 40 : 0
}

/** Человекочитаемая сводка вердикта (для логов/админки) */
export function verdictSummary(v: AdVerdict): string {
  return `${v.score}${v.hidden ? ' (скрыт)' : ''}: ${v.reasons.join(', ') || 'чисто'}`
}
