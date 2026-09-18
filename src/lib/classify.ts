import { chatSimple } from '@/lib/openrouter'

/**
 * Классификация каналов по темам.
 *
 * История: раньше работал keyword-регэксп по названию/описанию — он ставил
 * «Юмор» медиахолдингам («мем» в описании) и «Еду» любому каналу со слогом
 * «ед» («победа», «медведь»). Лента по категориям превращалась в случайную
 * выборку. Теперь категорию определяет LLM (gemini-2.5-flash-lite — копейки),
 * регэксп остался фолбэком на случай недоступности API.
 */

export interface ClassifiableChannel {
  id: string
  title: string
  username: string
  description: string | null
  /** Пример свежих постов (сильнейший сигнал тематики — названия часто врут) */
  sample?: string
}

/** Фолбэк-классификатор (узкие паттерны: слово целиком или явные тематики) */
const FALLBACK_HINTS: Array<{ slug: string; re: RegExp }> = [
  { slug: 'crypto', re: /крипт|биткоин|\bbtc\b|ethereum|\beth\b|альткоин|трейд|блокчейн|\bdefi\b|\bcoin\b/i },
  { slug: 'it', re: /\bIT\b|разработ(ка|чик)|программист|\bPython\b|\bJavaScript\b|frontend|backend|нейросет|\bAI\b|\bGPT\b|веб-разраб|хакер|дата-сайнс/i },
  { slug: 'humor', re: /юмор|\bмем\w*|шутк|прикол|сарказм|смешн|\bhumor\b|\bmemes\b/i },
  { slug: 'sport', re: /спорт|футбол|хоккей|баскетбол|волейбол|теннис|матч|олимпиад|чемпионат|\bUCL\b|\bFIFA\b|\bUFC\b|бокс/i },
  { slug: 'travel', re: /путешеств|туризм|\btravel\b|отель|авиабилет|страновед/i },
  { slug: 'food', re: /рецепт|кулинар|готовим|\bfood\b|гурман|кофейн/i },
  { slug: 'business', re: /бизнес|финанс|инвестиц|экономик|маркетинг|стартап|предпринимат|вакансии|карьера/i },
  { slug: 'news', re: /новост|\bnews\b|срочн|breaking|агентств|газет|журнал/i },
]

export function fallbackCategory(text: string): string {
  for (const h of FALLBACK_HINTS) if (h.re.test(text)) return h.slug
  return 'other'
}

function buildPrompt(
  slugs: Array<{ slug: string; title: string }>,
  channels: ClassifiableChannel[],
): string {
  const themes = slugs.map((s) => `"${s.slug}" (${s.title})`).join(', ')
  const list = channels
    .map((c, i) => {
      const sample = (c.sample ?? '').slice(0, 300).replace(/"/g, "'").replace(/\s+/g, ' ').trim()
      return (
        `${i + 1}. id="${c.id}" название="${c.title}" юзернейм="${c.username}" описание="${(c.description ?? '').slice(0, 200).replace(/"/g, "'")}"` +
        (sample ? ` посты="${sample}"` : '')
      )
    })
    .join('\n')
  return `Определи тематику каждого Telegram-канала. Выбери ОДНУ тему из списка: ${themes}.

Правила:
- Главная улика — ТЕКСТЫ ПОСТОВ (если есть): они точнее названия. Название/юзернейм часто врут или ни о чём не говорят.
- Эстетика, цитаты, настроения, «сохраняй себе», фото без темы → "other" (это не юмор и не новости).
- Юмор = шутки, мемы, приколы, сарказм В ПОСТАХ, а не просто «смешное» название.
- Новости общего содержания → "news". Финансы/крипта без новостного уклона → "crypto" или "business" по сути.
- Не угадывай из одного случайного слова: «победа» не про еду, «медведь» не про еду.
- Если тематика непонятна или не подходит ни под одну тему → "other".

Каналы:
${list}

Ответь ТОЛЬКО JSON-массивом без пояснений: [{"id":"...","slug":"..."}]`
}

function parseReply(raw: string): Array<{ id: string; slug: string }> {
  // Модели любят оборачивать JSON в ```json — срезаем обвязку
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start === -1 || end <= start) return []
  try {
    const arr = JSON.parse(raw.slice(start, end + 1)) as Array<{ id?: string; slug?: string }>
    return arr.filter((x) => typeof x.id === 'string' && typeof x.slug === 'string') as Array<{
      id: string
      slug: string
    }>
  } catch {
    return []
  }
}

/**
 * Классификация пачки каналов одной LLM-вызовом (~20 каналов ≈ 800 токенов
 * входа — доли цента). Каналы, по которым ответ не пришёл, получают fallback
 * по регэкспу (вызывающая сторона).
 */
export async function classifyChannelsBatch(
  channels: ClassifiableChannel[],
  slugs: Array<{ slug: string; title: string }>,
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  if (channels.length === 0) return result

  const allowed = new Set(slugs.map((s) => s.slug))
  try {
    const raw = await chatSimple(
      'Ты — редактор каталога Telegram-каналов. Отвечай строго JSON-массивом, без markdown-обвязки и пояснений.',
      buildPrompt(slugs, channels),
      { maxTokens: 900, timeoutMs: 45_000, temperature: 0.1 },
    )
    for (const item of parseReply(raw)) {
      if (allowed.has(item.slug)) result.set(item.id, item.slug)
    }
  } catch {
    // LLM недоступна — вызывающая сторона уйдёт в fallbackCategory
  }

  // Каналы без ответа — фолбэк-регэксп, чтобы пустых категорий не было
  for (const c of channels) {
    if (!result.has(c.id)) {
      result.set(c.id, fallbackCategory(`${c.title} ${c.username} ${c.description ?? ''}`))
    }
  }
  return result
}
