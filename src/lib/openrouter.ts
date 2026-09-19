/**
 * Клиент OpenRouter — ЕДИНАЯ модель сервиса: z-ai/glm-5.3-flash:free.
 * Ключ — в env OPENROUTER_API_KEY.
 *
 * Принцип НУЛЕВОЙ стоимости (решение владельца, v5.33):
 *  - ВСЕ цепочки (обычные, стриминговые, tool-calling, модерация) начинаются
 *    с z-ai/glm-5.3-flash:free — платных моделей в цепочках больше НЕТ;
 *  - фолбэки — только другие бесплатные (:free) модели, на случай лимитов;
 *  - ответы кэшируются выше по стеку (Post.translations), LLM вызывается
 *    один раз на пост и язык.
 *
 * СКОРОСТЬ: перевод/саммари стримятся в UI (chatStream) — пользователь видит
 * первый токен через ~0.5–1с, а не весь ответ через 5–15с.
 */

const API_URL = 'https://openrouter.ai/api/v1/chat/completions'

/** Цепочка моделей: первая доступная отвечает. Только :free — ноль рублей.
 *  Переопределяется env OPENROUTER_MODELS */
const FREE_CHAIN = [
  'z-ai/glm-5.3-flash:free', // ЕДИНАЯ модель сервиса (решение владельца) — везде первая
  'z-ai/glm-5.2:free', // фолбэк на случай исчерпания лимитов GLM Flash
  'google/gemma-4-26b-a4b-it:free', // последний бесплатный фолбэк
]

const DEFAULT_MODELS = FREE_CHAIN

/** Цепочка для СТРИМИНГА (перевод/саммари) — та же бесплатная тройка */
const SPEED_MODELS = FREE_CHAIN

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
  opts?: { maxTokens?: number; timeoutMs?: number; temperature?: number; models?: string[] },
): Promise<string> {
  return chatMessages(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    opts,
  )
}

/* ============================ ИНСТРУМЕНТЫ (v5.21) ============================ *
 *  Нативный function-calling OpenRouter + текстовый фолбэк для моделей без
 *  поддержки tools (JSON-блок в ответе). Единая точка для ИИ-ассистента и
 *  ИИ-поиска: модель сама решает, какой инструмент вызвать и с какими
 *  аргументами — никаких скриптовых команд в тексте пользователя.
 */

export type ToolCall = { id: string; name: string; args: string }

export type ChatMsg = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Для role='assistant': вызванные инструменты (эхо в историю) */
  toolCalls?: ToolCall[]
  /** Для role='tool': id вызова, на который отвечает это сообщение */
  toolCallId?: string
  /** Для role='tool': имя инструмента (некоторые провайдеры требуют) */
  name?: string
}

export type ToolSchema = {
  type: 'function'
  function: {
    name: string
    description: string
    /** JSON Schema аргументов */
    parameters: Record<string, unknown>
  }
}

/** Цепочка для tool-calling: та же бесплатная тройка (без tools — текстовый
 *  JSON-протокол, см. parseToolJsonBlock, работает на любой модели) */
const TOOL_MODELS = FREE_CHAIN

type RawToolCall = { id?: { name?: string } | string; function?: { name?: string; arguments?: string } }
type ToolResponseChoice = {
  message?: {
    content?: string | null
    tool_calls?: RawToolCall[]
  }
}

/** Нормализация tool_call из ответа провайдера (форматы id различаются) */
function normalizeToolCalls(raw: RawToolCall[] | undefined): ToolCall[] {
  if (!raw?.length) return []
  const out: ToolCall[] = []
  raw.forEach((tc, i) => {
    const fn = tc.function
    if (!fn?.name) return
    const id =
      typeof tc.id === 'string' && tc.id
        ? tc.id
        : ((tc.id as { name?: string } | undefined)?.name ?? `call_${i}`)
    out.push({ id, name: fn.name, args: fn.arguments ?? '{}' })
  })
  return out
}

/**
 * Текстовый фолбэк: модель без tools-поддержки отвечает JSON-блоком
 * ```json {"tool":"...","arguments":{...}}``` — парсим и превращаем в tool call.
 * Работает на ЛЮБОЙ модели — «нейронка не зависима от скриптовых команд».
 */
export function parseToolJsonBlock(content: string): { call: ToolCall; rest: string } | null {
  if (!content) return null
  // Фенс ```json ... ``` или сырой {"tool": ...} в начале/конце
  const fence = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i)
  const candidate = fence?.[1] ?? (content.trim().startsWith('{') ? content.trim() : null)
  if (!candidate) return null
  try {
    const obj = JSON.parse(candidate) as { tool?: string; arguments?: unknown; args?: unknown }
    if (typeof obj.tool !== 'string' || !obj.tool) return null
    const args = (obj.arguments ?? obj.args ?? {}) as Record<string, unknown>
    const rest = fence ? content.replace(fence[0], '').trim() : ''
    return {
      call: { id: `text_${obj.tool}_${Date.now()}`, name: obj.tool, args: JSON.stringify(args) },
      rest,
    }
  } catch {
    return null
  }
}

/**
 * Вызов с инструментами: message history (system/user/assistant/tool) +
 * список tools → { content, toolCalls }. Перебирает TOOL_MODELS; для моделей
 * без нативного tools — фолбэк на текстовый JSON-протокол.
 * opts.onStatus — текстовый статус («думаю»/«вызываю инструмент X»).
 */
export async function chatWithTools(
  messages: ChatMsg[],
  tools: ToolSchema[],
  opts?: {
    maxTokens?: number
    timeoutMs?: number
    temperature?: number
    models?: string[]
  },
): Promise<{ content: string; toolCalls: ToolCall[]; model?: string }> {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error('OPENROUTER_API_KEY не задан')
  const maxTokens = opts?.maxTokens ?? 1200
  const timeoutMs = opts?.timeoutMs ?? 45_000
  const temperature = opts?.temperature ?? 0.5
  const chain = opts?.models?.length ? opts.models : TOOL_MODELS

  // Провайдерам, не понимающим role:'tool', превращаем историю в совместимую:
  // tool-сообщения склеиваем в user-текст «[результат инструмента N]: ...»
  const encode = (forTools: boolean) => {
    if (forTools) {
      return messages.map((m) => {
        if (m.role === 'assistant' && m.toolCalls?.length) {
          return {
            role: 'assistant' as const,
            content: m.content || '',
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.args },
            })),
          }
        }
        if (m.role === 'tool') {
          return { role: 'tool' as const, tool_call_id: m.toolCallId ?? '', content: m.content }
        }
        return { role: m.role, content: m.content }
      })
    }
    // Текстовый режим: инструменты описываем в system-хвосте, tool-результаты — user
    const toolGuide =
      `\n\nДОСТУПНЫЕ ИНСТРУМЕНТЫ (JSON-протокол): чтобы вызвать инструмент, ответь ТОЛЬКО json-блоком вида ` +
      '```json\n{"tool":"<имя>","arguments":{...}}\n```\n' +
      'без другого текста. После результата инструмент вернётся тебе как сообщение пользователя в формате [инструмент <имя> →].\n' +
      tools.map((t) => `- ${t.function.name}: ${t.function.description}`).join('\n')
    return messages.map((m, i) => {
      if (m.role === 'tool') {
        return { role: 'user' as const, content: `[инструмент ${m.name ?? ''} → результат]: ${m.content}` }
      }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        const calls = m.toolCalls.map((tc) => `{"tool":"${tc.name}","arguments":${tc.args}}`).join('\n')
        return { role: 'assistant' as const, content: `\`\`\`json\n${calls}\n\`\`\`` }
      }
      if (m.role === 'system' && i === 0) {
        return { role: 'system' as const, content: m.content + toolGuide }
      }
      return { role: m.role, content: m.content }
    })
  }

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
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature,
          messages: encode(true),
          tools,
          tool_choice: 'auto',
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) {
        // Модель не поддерживает tools (400/404) — сразу пробуем текстовый протокол
        if (res.status === 400 || res.status === 404 || res.status === 422) {
          const t = await fetch(API_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${key}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': process.env.APP_URL ?? 'https://tg-swipe.vercel.app',
              'X-Title': 'Tg Swipe',
            },
            body: JSON.stringify({ model, max_tokens: maxTokens, temperature, messages: encode(false) }),
            signal: AbortSignal.timeout(timeoutMs),
          })
          if (t.ok) {
            const td = (await t.json()) as { choices?: Array<{ message?: { content?: string } }> }
            const content = td.choices?.[0]?.message?.content?.trim()
            if (content) {
              const parsed = parseToolJsonBlock(content)
              if (parsed) return { content: parsed.rest, toolCalls: [parsed.call], model }
              return { content, toolCalls: [], model }
            }
          }
          lastError = new Error(`OpenRouter ${model}: tools+fallback HTTP ${t.status}/${res.status}`)
          continue
        }
        lastError = new Error(`OpenRouter ${model}: HTTP ${res.status}`)
        continue
      }
      const data = (await res.json()) as { choices?: ToolResponseChoice[] }
      const msg = data.choices?.[0]?.message
      const content = (typeof msg?.content === 'string' ? msg.content.trim() : '') ?? ''
      const toolCalls = normalizeToolCalls(msg?.tool_calls)
      if (toolCalls.length > 0) return { content, toolCalls, model }
      if (content) {
        // Текст-фолбэк: некоторые модели отвечают JSON-блоком даже с tools
        const parsed = parseToolJsonBlock(content)
        if (parsed) return { content: parsed.rest, toolCalls: [parsed.call], model }
        return { content, toolCalls: [], model }
      }
      lastError = new Error(`OpenRouter ${model}: пустой ответ`)
    } catch (e) {
      lastError = e
    }
  }
  throw lastError instanceof Error ? lastError : new Error('OpenRouter недоступен')
}

/* ============================ ГЕНЕРАЦИЯ КАРТИНОК ============================ *
 *  v5.33: только бесплатный pollinations.ai (flux) — платные image-модели
 *  OpenRouter удалены (ноль рублей, см. src/lib/ai-image.ts).
 */
