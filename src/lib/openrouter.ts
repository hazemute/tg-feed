/**
 * Клиент OpenRouter — самая дешёвая модель для служебных задач
 * (перевод постов). Ключ — в env OPENROUTER_API_KEY.
 *
 * Принцип экономии:
 *  - по умолчанию бесплатные микро-модели (суффикс :free) в порядке надёжности;
 *  - каждая следующая модель — фолбэк, если предыдущая недоступна/лимит;
 *  - ответы кэшируются выше по стеку (Post.translations), LLM вызывается
 *    один раз на пост и язык.
 *
 * СКОРОСТЬ: перевод/саммари стримятся в UI (chatStream) — пользователь видит
 * первый токен через ~0.5–1с, а не весь ответ через 5–15с. Для стриминга
 * используется цепочка SPEED_MODELS — модели с самым быстрым первым токеном.
 */

const API_URL = 'https://openrouter.ai/api/v1/chat/completions'

/** Цепочка моделей: первая доступная отвечает. Приоритет — СКОРОСТЬ при копеечной цене.
 *  Переопределяется env OPENROUTER_MODELS */
const DEFAULT_MODELS = [
  'z-ai/glm-5.2:free', // GLM (бесплатная): классификация/поддержка/реклама-фильтр без затрат
  'z-ai/glm-5.3-flash', // исчерпали лимиты бесплатной → сверхдешёвая GLM Flash ($0.09/M)
  'google/gemini-2.5-flash-lite', // проверенный дешёвый фолбэк (~$0.1/M)
  'mistralai/mistral-nemo', // 12B, предельно дешёвая ($0.019/M) — фолбэк
  'google/gemma-4-26b-a4b-it:free', // бесплатный фолбэк на случай исчерпания кредита
]

/** Цепочка для СТРИМИНГА (перевод/саммари): модели с самым быстрым первым токеном.
 *  Замеры (TTFB): glm-5.3-flash ~1.6с и доступна везде; gemini-2.5-flash-lite
 *  гео-блокируется из ряда регионов (403 «not available in your region») —
 *  только вторым слотом; бесплатные GLM regularly 429 по лимитам. */
const SPEED_MODELS = [
  'z-ai/glm-5.3-flash',
  'google/gemini-2.5-flash-lite',
  'z-ai/glm-5.2:free',
  'mistralai/mistral-nemo',
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
 * Полноценный вызов с историей (мульти-turn: чат поддержки и др.).
 * opts.models — переопределение цепочки моделей (например, только :free
 * для бесплатной ИИ-модерации, см. ai-moderate.ts).
 * Бросает ошибку, если ни одна модель не ответила.
 */
export async function chatMessages(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  opts?: { maxTokens?: number; timeoutMs?: number; temperature?: number; models?: string[] },
): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error('OPENROUTER_API_KEY не задан')
  const maxTokens = opts?.maxTokens ?? 800
  const timeoutMs = opts?.timeoutMs ?? 25_000
  const temperature = opts?.temperature ?? 0.2
  const chain = opts?.models ?? models()

  let lastError: unknown = null
  for (const model of chain) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.APP_URL ?? 'https://tg-swipe.vercel.app',
          'X-Title': 'Tg Swipe',
        },
        body: JSON.stringify({ model, max_tokens: maxTokens, temperature, messages }),
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

/**
 * СТРИМИНГОВЫЙ вызов: system + user → поток дельт через onDelta + полный текст.
 *
 * Перебирает модели из opts.models (по умолчанию SPEED_MODELS): берём ту,
 * что выдала первый токен быстрее всех прочих попыток (первая успешная).
 * Если модель молчит дольше firstTokenMs — переключаемся на следующую.
 * Если поток оборвался после содержательного куска — возвращаем то, что есть
 * (частичный перевод лучше пустоты; выше по стеку текст провалидируется).
 * Бросает ошибку только если НИ ОДНА модель не дала ни токена.
 */
export async function chatStream(
  system: string,
  user: string,
  opts?: {
    maxTokens?: number
    timeoutMs?: number
    temperature?: number
    models?: string[]
    /** Сколько ждать первого токена до переключения на следующую модель */
    firstTokenMs?: number
    onDelta: (chunk: string) => void
  },
): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error('OPENROUTER_API_KEY не задан')
  const chain = opts?.models?.length ? opts.models : SPEED_MODELS
  const maxTokens = opts?.maxTokens ?? 1100
  const timeoutMs = opts?.timeoutMs ?? 30_000
  const temperature = opts?.temperature ?? 0.2
  const firstTokenMs = opts?.firstTokenMs ?? 6_000

  let lastError: unknown = null
  for (const model of chain) {
    let accumulated = ''
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.APP_URL ?? 'https://tg-swipe.vercel.app',
          'X-Title': 'Tg Swipe',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature,
          stream: true,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok || !res.body) {
        lastError = new Error(`OpenRouter ${model}: HTTP ${res.status}`)
        continue
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let firstTokenTimer: ReturnType<typeof setTimeout> | null = null

      const dropFirstTokenTimer = () => {
        if (firstTokenTimer) {
          clearTimeout(firstTokenTimer)
          firstTokenTimer = null
        }
      }
      // Первый токен не пришёл вовремя — рвём соединение, пробуем следующую модель
      firstTokenTimer = setTimeout(() => reader.cancel().catch(() => {}), firstTokenMs)

      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith(':')) continue // keep-alive комментарии
            if (!trimmed.startsWith('data:')) continue
            const payload = trimmed.slice(5).trim()
            if (payload === '[DONE]') continue
            try {
              const json = JSON.parse(payload) as {
                choices?: Array<{ delta?: { content?: string } }>
                error?: { message?: string }
              }
              if (json.error?.message) throw new Error(json.error.message)
              const piece = json.choices?.[0]?.delta?.content ?? ''
              if (piece) {
                dropFirstTokenTimer()
                accumulated += piece
                opts?.onDelta(piece)
              }
            } catch (e) {
              // битый chunk не роняет поток; ошибка API — наружу
              if (e instanceof Error && e.message && !/JSON/i.test(e.message)) throw e
            }
          }
        }
      } finally {
        dropFirstTokenTimer()
        reader.cancel().catch(() => {})
      }

      if (accumulated.trim().length > 0) return accumulated
      lastError = new Error(`OpenRouter ${model}: пустой поток`)
    } catch (e) {
      lastError = e
      // Поток умер с содержательным куском — отдаём как есть (лучше, чем ничего)
      if (accumulated.trim().length >= 40) return accumulated
    }
  }
  throw lastError instanceof Error ? lastError : new Error('OpenRouter недоступен')
}

/**
 * Простой текстовый вызов: system + user → string.
 * Бросает ошибку, если ни одна модель не ответила.
 */
export async function chatSimple(
  system: string,
  user: string,
  opts?: { maxTokens?: number; timeoutMs?: number; temperature?: number },
): Promise<string> {
  return chatMessages(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    opts,
  )
}
