/**
 * Клиент OpenRouter — самая дешёвая модель для служебных задач
 * (перевод постов). Ключ — в env OPENROUTER_API_KEY.
 *
 * Принцип экономии:
 *  - по умолчанию бесплатные микро-модели (суффикс :free) в порядке надёжности;
 *  - каждая следующая модель — фолбэк, если предыдущая недоступна/лимит;
 *  - ответы кэшируются выше по стеку (Post.translations), LLM вызывается
 *    один раз на пост и язык.
 */

const API_URL = 'https://openrouter.ai/api/v1/chat/completions'

/** Цепочка моделей: первая доступная отвечает. Переопределяется env OPENROUTER_MODELS */
const DEFAULT_MODELS = [
  'mistralai/mistral-nemo', // 12B — дешевле всех ($0.019/M): ~0.0002₽ за перевод поста
  'meta-llama/llama-3.1-8b-instruct', // платный фолбэк той же ценовой категории
  'google/gemma-4-26b-a4b-it:free', // бесплатный фолбэк на случай исчерпания кредита
]

export function openRouterEnabled(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY)
}

function models(): string[] {
  const custom = (process.env.OPENROUTER_MODELS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return custom.length > 0 ? custom : DEFAULT_MODELS
}

/**
 * Простой текстовый вызов: system + user → string.
 * Бросает ошибку, если ни одна модель не ответила.
 */
export async function chatSimple(
  system: string,
  user: string,
  opts?: { maxTokens?: number; timeoutMs?: number },
): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error('OPENROUTER_API_KEY не задан')
  const maxTokens = opts?.maxTokens ?? 1200
  const timeoutMs = opts?.timeoutMs ?? 25_000

  let lastError: unknown = null
  for (const model of models()) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          // OpenRouter просит атрибуцию приложения
          'HTTP-Referer': process.env.APP_URL ?? 'https://tg-feed.vercel.app',
          'X-Title': 'Tg Swipe',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature: 0.2, // служебные задачи — детерминированность важнее творчества
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) {
        lastError = new Error(`OpenRouter ${model}: HTTP ${res.status}`)
        continue
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const content = data.choices?.[0]?.message?.content?.trim()
      if (content) return content
      lastError = new Error(`OpenRouter ${model}: пустой ответ`)
    } catch (e) {
      lastError = e
    }
  }
  throw lastError instanceof Error ? lastError : new Error('OpenRouter недоступен')
}
