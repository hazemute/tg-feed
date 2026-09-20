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

/* ==================== УЧЁТ ТОКЕНОВ (v5.39) ==================== *
 * Все вызовы просят у OpenRouter usage: { include: true } — в ответе приходят
 * prompt_tokens (входные) и completion_tokens (выходные). Наверху по стеку
 * (lib/wallet.ts) по ним считается стоимость запроса в свайпах — тяжёлые
 * запросы списывают больше, лёгкие меньше. onUsage-колбэк не обязателен:
 * если вызывающему коду тарификация не нужна — он его просто не передаёт.
 */
export type AiUsage = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  model?: string
}

type ApiUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }

function usageOf(u: ApiUsage | undefined, model: string): AiUsage | null {
  const p = Math.max(0, Math.floor(u?.prompt_tokens ?? 0))
  const c = Math.max(0, Math.floor(u?.completion_tokens ?? 0))
  if (p === 0 && c === 0) return null // модель не отдала usage
  return { promptTokens: p, completionTokens: c, totalTokens: u?.total_tokens ?? p + c, model }
}

/** Приоритет бесплатных моделей: первая живая отвечает. Только :free — ноль рублей.
 *  Переопределяется env OPENROUTER_MODELS.
 *  v5.35: z-ai/glm-5.3-flash:free ИСЧЕЗ из каталога OpenRouter (2026-09) —
 *  каждый запрос начинался с 404, а фолбэки упирались в лимиты. Слоты :free
 *  на OpenRouter появляются/исчезают, поэтому: (1) держим glm-5.3-flash:free
 *  первой — живая дискавери (ниже) вернёт её в цепочку автоматически,
 *  (2) сегодня фактически отвечает glm-5.2:free (та же GLM, бесплатно). */
const PREFERRED_FREE = [
  'z-ai/glm-5.3-flash:free', // вернётся в каталог — снова станет первой (решение владельца)
  'z-ai/glm-5.2:free', // сегодня: единственный бесплатный GLM — фактический основной
  'google/gemma-4-26b-a4b-it:free',
  'google/gemma-4-31b-it:free',
  'deepseek/deepseek-v4-flash-0731:free',
  'inclusionai/ling-3.0-flash-vl:free',
]

const DEFAULT_MODELS = PREFERRED_FREE

/** Цепочка для СТРИМИНГА (перевод/саммари) — та же бесплатная шестёрка */
const SPEED_MODELS = PREFERRED_FREE

/* ==================== ЖИВАЯ ДИСКАВЕРИ МОДЕЛЕЙ (v5.35) ====================
 * Раз в час в фоне спрашиваем публичный GET /models и строим цепочку только
 * из ЖИВЫХ бесплатных моделей. Горячий путь НИКОГДА не ждёт дискавери:
 * холодный старт идёт по статичной цепочке, кэш догоняет в фоне. */

const MODELS_URL = 'https://openrouter.ai/api/v1/models'
const MODELS_TTL_MS = 60 * 60 * 1000

type LiveModels = { ids: Set<string>; at: number }

function liveStore(): { __orLiveModels?: LiveModels; __orLiveFetching?: boolean } {
  return globalThis as unknown as { __orLiveModels?: LiveModels; __orLiveFetching?: boolean }
}

/** Синхронно: последний кэш живых id моделей (без сети) */
function cachedLiveIds(): Set<string> | null {
  return liveStore().__orLiveModels?.ids ?? null
}

/** Фоновая дискавери: не блокирует запрос */
function kickModelDiscovery(): void {
  const g = liveStore()
  if (g.__orLiveModels && Date.now() - g.__orLiveModels.at < MODELS_TTL_MS) return
  if (g.__orLiveFetching) return
  g.__orLiveFetching = true
  fetch(MODELS_URL, { signal: AbortSignal.timeout(8000) })
    .then((r) => (r.ok ? r.json() : null))
    .then((d: { data?: Array<{ id?: string }> } | null) => {
      const ids = new Set((d?.data ?? []).map((m) => m.id ?? '').filter(Boolean))
      if (ids.size > 0) g.__orLiveModels = { ids, at: Date.now() }
    })
    .catch(() => {})
    .finally(() => {
      g.__orLiveFetching = false
    })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/* ===================== МЁРТВЫЕ СЛОТЫ + ЖИВАЯ ЦЕПОЧКА (v5.56) =====================
 * Слоты :free на OpenRouter исчезают (404) и получают 429 — каждый запрос к
 * мёртвому слоту — лишний RTT перед живой моделью (на холодном пути
 * фолбэков это секунды). Держим негативный кэш 404-слотов (10 мин) и
 * прогоняем цепочку через дискавери: живые — вперёд, неизвестные — следом.
 */

const DEAD_SLOT_MS = 10 * 60_000

function deadSlotStore(): { __orDeadSlots?: Map<string, number> } {
  return globalThis as unknown as { __orDeadSlots?: Map<string, number> }
}

function deadSlots(): Map<string, number> {
  const g = deadSlotStore()
  return (g.__orDeadSlots ??= new Map())
}

/** Модель отдала 404 (исчезла из каталога) — не дёргаем 10 минут */
function markDeadSlot(model: string): void {
  const m = deadSlots()
  m.set(model, Date.now())
  if (m.size > 40) {
    const now = Date.now()
    for (const [k, t] of m) {
      if (now - t > DEAD_SLOT_MS) m.delete(k)
    }
  }
}

function isDeadSlot(model: string): boolean {
  const t = deadSlots().get(model)
  return !!t && Date.now() - t < DEAD_SLOT_MS
}

/** Цепочка без мёртвых слотов: по тёплой дискавери — только живые, иначе все не-404 */
function liveChain(chain: string[]): string[] {
  const live = cachedLiveIds()
  const out: string[] = []
  for (const m of chain) {
    if (isDeadSlot(m)) continue
    if (live && !live.has(m)) continue
    out.push(m)
  }
  // дискавери отсеяла всё (сбой каталога) — хотя бы без мёртвых 404
  return out.length > 0 ? out : chain.filter((m) => !isDeadSlot(m))
}

/** POST /chat/completions с ОДНИМ ретраем на 429 (минутные лимиты free-слотов:
 *  ретрай через ~1.5с почти всегда проходит, не переключая модель). */
async function postWith429Retry(body: Record<string, unknown>, timeoutMs: number): Promise<Response> {
  const key = process.env.OPENROUTER_API_KEY ?? ''
  const headers = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': process.env.APP_URL ?? 'https://tg-swipe.vercel.app',
    'X-Title': 'Tg Swipe',
  }
  const send = () =>
    fetch(API_URL, {
      method: 'POST',
      headers,
      // usage: { include: true } — OpenRouter возвращает token-usage запроса (v5.39)
      body: JSON.stringify({ usage: { include: true }, ...body }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  let res = await send()
  if (res.status === 429) {
    await sleep(1100 + Math.floor(Math.random() * 800))
    res = await send()
  }
  return res
}

/** Человеческое сообщение об ошибке OpenRouter (для SSE 'error' и JSON-ответов) */
export function openRouterErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (/HTTP 429|rate\s*limit/i.test(msg))
    return 'Бесплатная нейросеть перегружена (лимит запросов) — подождите минуту и попробуйте снова'
  if (/HTTP 402|credits/i.test(msg))
    return 'Суточный лимит бесплатной нейросети исчерпан — попробуйте завтра'
  if (/timeout|time\s*out|abort/i.test(msg))
    return 'Нейросеть отвечала слишком долго — попробуйте ещё раз'
  if (/HTTP 40[134]/.test(msg))
    return 'Нейросеть временно недоступна — попробуйте ещё раз через минуту'
  return 'Нейросеть не ответила — попробуйте ещё раз'
}

export function openRouterEnabled(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY)
}

function models(): string[] {
  const custom = (process.env.OPENROUTER_MODELS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (custom.length > 0) return custom
  const live = cachedLiveIds()
  if (live && live.size > 0) {
    const alive = PREFERRED_FREE.filter((m) => live.has(m))
    if (alive.length > 0) return alive
  }
  return DEFAULT_MODELS
}

/** Динамическая бесплатная цепочка для модулей со своими списками (ai-moderate) */
export function freeModelChain(): string[] {
  return models()
}

/**
 * Полноценный вызов с историей (мульти-turn: чат поддержки и др.).
 * opts.models — переопределение цепочки моделей (например, только :free
 * для бесплатной ИИ-модерации, см. ai-moderate.ts).
 * Бросает ошибку, если ни одна модель не ответила.
 */
export async function chatMessages(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  opts?: {
    maxTokens?: number
    timeoutMs?: number
    temperature?: number
    models?: string[]
    /** Реальный token-usage успешного вызова (для тарификации в свайпах) */
    onUsage?: (u: AiUsage) => void
  },
): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error('OPENROUTER_API_KEY не задан')
  const maxTokens = opts?.maxTokens ?? 800
  const timeoutMs = opts?.timeoutMs ?? 25_000
  const temperature = opts?.temperature ?? 0.2
  const chain = opts?.models ?? models()
  kickModelDiscovery()

  let lastError: unknown = null
  for (const model of chain) {
    if (opts?.models === undefined && isDeadSlot(model)) continue // v5.56: не тратим RTT на исчезнувшие слоты
    try {
      const res = await postWith429Retry({ model, max_tokens: maxTokens, temperature, messages }, timeoutMs)
      if (!res.ok) {
        if (res.status === 404) markDeadSlot(model) // v5.56: слот исчез из каталога
        lastError = new Error(`OpenRouter ${model}: HTTP ${res.status}`)
        continue
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
        usage?: ApiUsage
      }
      const content = data.choices?.[0]?.message?.content?.trim()
      if (content) {
        const u = usageOf(data.usage, model)
        if (u) opts?.onUsage?.(u)
        return content
      }
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
    /** Реальный token-usage успешного вызова (приходит в последнем чанке потока) */
    onUsage?: (u: AiUsage) => void
  },
): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error('OPENROUTER_API_KEY не задан')
  const chain = opts?.models?.length ? opts.models : SPEED_MODELS
  const maxTokens = opts?.maxTokens ?? 1100
  const timeoutMs = opts?.timeoutMs ?? 30_000
  const temperature = opts?.temperature ?? 0.2
  const firstTokenMs = opts?.firstTokenMs ?? 6_000

  kickModelDiscovery()
  let lastError: unknown = null
  for (const model of chain) {
    if (!opts?.models?.length && isDeadSlot(model)) continue // v5.56: не тратим RTT на исчезнувшие слоты
    let accumulated = ''
    try {
      const res = await postWith429Retry(
        {
          model,
          max_tokens: maxTokens,
          temperature,
          stream: true,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        },
        timeoutMs,
      )
      if (!res.ok || !res.body) {
        if (res.status === 404) markDeadSlot(model) // v5.56: слот исчез из каталога
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
                usage?: ApiUsage
                error?: { message?: string }
              }
              if (json.error?.message) throw new Error(json.error.message)
              // Usage приходит в финальном чанке (choices пустой) — запоминаем
              const u = usageOf(json.usage, model)
              if (u) opts?.onUsage?.(u)
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

/* ===================== ГОНКА МОДЕЛЕЙ (v5.56) =====================
 * Последовательный перебор цепочки на холодном пути = первый токен через
 * 5-15с (мёртвый слот 404 + ретраи 429 + медленные модели). ГОНКА: первые
 * N моделей стартуют ПАРАЛЛЕЛЬНО со сдвигом; выигрывает та, что первой
 * выдала токен, остальные немедленно обрываются. Первый токен = самый
 * быстрый из N вместо суммы задержек цепочки.
 */

/** Один гонщик: свой AbortController, дельты проходят только после захвата лидерства */
function raceAttempt(args: {
  model: string
  ac: AbortController
  system: string
  user: string
  maxTokens: number
  temperature: number
  timeoutMs: number
  firstTokenMs: number
  onDelta?: (chunk: string) => void
  onUsage?: (u: AiUsage) => void
  claim: (model: string, ac: AbortController) => boolean
}): Promise<string> {
  const { model, ac, claim, ...rest } = args
  let accumulated = ''
  let claimed = false
  return new Promise<string>((resolve, reject) => {
    void (async () => {
      try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ''}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': process.env.APP_URL ?? 'https://tg-swipe.vercel.app',
            'X-Title': 'Tg Swipe',
          },
          body: JSON.stringify({
            model,
            max_tokens: rest.maxTokens,
            temperature: rest.temperature,
            stream: true,
            messages: [
              { role: 'system', content: rest.system },
              { role: 'user', content: rest.user },
            ],
          }),
          signal: ac.signal,
          cache: 'no-store',
        })
        if (!res.ok || !res.body) {
          if (res.status === 404) markDeadSlot(model)
          reject(new Error(`OpenRouter ${model}: HTTP ${res.status}`))
          return
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let firstTokenTimer: ReturnType<typeof setTimeout> | null = setTimeout(
          () => ac.abort(),
          rest.firstTokenMs,
        )
        const dropTimer = () => {
          if (firstTokenTimer) {
            clearTimeout(firstTokenTimer)
            firstTokenTimer = null
          }
        }
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) continue
              const payload = trimmed.slice(5).trim()
              if (payload === '[DONE]') continue
              try {
                const json = JSON.parse(payload) as {
                  choices?: Array<{ delta?: { content?: string } }>
                  usage?: ApiUsage
                  error?: { message?: string }
                }
                if (json.error?.message) throw new Error(json.error.message)
                const u = usageOf(json.usage, model)
                if (u) rest.onUsage?.(u)
                const piece = json.choices?.[0]?.delta?.content ?? ''
                if (piece) {
                  dropTimer()
                  if (!claimed) {
                    // первый токен: захватываем лидерство (проигравших обрывает claim)
                    if (!claim(model, ac)) {
                      reject(new Error(`OpenRouter ${model}: проиграл гонку`))
                      return
                    }
                    claimed = true
                  }
                  accumulated += piece
                  rest.onDelta?.(piece)
                }
              } catch (e) {
                if (e instanceof Error && e.message && !/JSON/i.test(e.message)) throw e
              }
            }
          }
        } finally {
          dropTimer()
          reader.cancel().catch(() => {})
        }
        if (accumulated.trim().length > 0) resolve(accumulated)
        else reject(new Error(`OpenRouter ${model}: пустой поток`))
      } catch (e) {
        // abort проигравшего гонщика — тихий отказ; обрыв победителя с куском —
        // отдаём как есть (частичный текст лучше пустоты)
        if (claimed && accumulated.trim().length >= 40) {
          resolve(accumulated)
          return
        }
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })()
  })
}

/**
 * Стриминговый вызов ГОНКОЙ: system + user → дельты + полный текст.
 * Параллельно стартуют до raceSize моделей цепочки (по умолчанию 3) со
 * сдвигом 350мс; первая, выдавшая токен, забирает поток, остальные рвутся.
 * Все гонщики умерли → фолбэк на последовательный chatStream (полная цепочка).
 */
export async function chatStreamRace(
  system: string,
  user: string,
  opts?: {
    maxTokens?: number
    timeoutMs?: number
    temperature?: number
    models?: string[]
    firstTokenMs?: number
    /** Сколько моделей стартуют параллельно (по умолчанию 3) */
    raceSize?: number
    onDelta?: (chunk: string) => void
    onUsage?: (u: AiUsage) => void
  },
): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error('OPENROUTER_API_KEY не задан')
  const base = opts?.models?.length ? opts.models : SPEED_MODELS
  const chain = liveChain(base)
  const maxTokens = opts?.maxTokens ?? 1100
  const timeoutMs = opts?.timeoutMs ?? 30_000
  const temperature = opts?.temperature ?? 0.2
  const firstTokenMs = opts?.firstTokenMs ?? 6_000
  const raceSize = Math.max(1, Math.min(opts?.raceSize ?? 3, chain.length))

  kickModelDiscovery()

  let claimed: string | null = null
  const controllers = new Set<AbortController>()
  const claim = (model: string, ac: AbortController): boolean => {
    if (claimed) return claimed === model
    claimed = model
    for (const c of controllers) {
      if (c !== ac) c.abort() // проигравшие гонщики обрываются немедленно
    }
    return true
  }

  const runners = chain.slice(0, raceSize).map((model, i) => {
    const ac = new AbortController()
    controllers.add(ac)
    // сдвиг старта: выигравшая (обычно первая живая) модель успевает отменить
    // лишние запросы до их отправки — экономим лимиты free-слотов
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        raceAttempt({
          model,
          ac,
          system,
          user,
          maxTokens,
          temperature,
          timeoutMs,
          firstTokenMs,
          onDelta: opts?.onDelta,
          onUsage: opts?.onUsage,
          claim,
        }).then(resolve, reject)
      }, i * 350)
      ac.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          if (!claimed) reject(new Error(`OpenRouter ${model}: отменён (гонку выиграл другой)`))
        },
        { once: true },
      )
    })
  })

  try {
    return await Promise.any(runners)
  } catch {
    // Все гонщики умерли одновременно (например, минутные 429) — прежний
    // последовательный путь переберёт ВСЮ цепочку (включая хвост за raceSize)
    return chatStream(system, user, {
      maxTokens,
      timeoutMs,
      temperature,
      models: chain,
      firstTokenMs,
      onDelta: opts?.onDelta ?? (() => {}),
      onUsage: opts?.onUsage,
    })
  } finally {
    for (const c of controllers) c.abort() // страховка: не оставляем висящих соединений
  }
}

/**
 * Простой текстовый вызов: system + user → string.
 * Бросает ошибку, если ни одна модель не ответила.
 */
export async function chatSimple(
  system: string,
  user: string,
  opts?: {
    maxTokens?: number
    timeoutMs?: number
    temperature?: number
    models?: string[]
    /** Реальный token-usage успешного вызова (для тарификации в свайпах) */
    onUsage?: (u: AiUsage) => void
  },
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

/** Цепочка для tool-calling: та же бесплатная шестёрка (без tools — текстовый
 *  JSON-протокол, см. parseToolJsonBlock, работает на любой модели) */
const TOOL_MODELS = PREFERRED_FREE

type RawToolCall = { id?: { name?: string } | string; function?: { name?: string; arguments?: string } }
type ToolResponseChoice = {
  finish_reason?: string
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
    /** Реальный token-usage успешного вызова (для тарификации в свайпах) */
    onUsage?: (u: AiUsage) => void
  },
): Promise<{ content: string; toolCalls: ToolCall[]; model?: string; finishReason?: string }> {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error('OPENROUTER_API_KEY не задан')
  const maxTokens = opts?.maxTokens ?? 1200
  const timeoutMs = opts?.timeoutMs ?? 45_000
  const temperature = opts?.temperature ?? 0.5
  const chain = opts?.models?.length ? opts.models : TOOL_MODELS
  kickModelDiscovery()

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
      const res = await postWith429Retry(
        {
          model,
          max_tokens: maxTokens,
          temperature,
          messages: encode(true),
          tools,
          tool_choice: 'auto',
        },
        timeoutMs,
      )
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
            body: JSON.stringify({
              model,
              max_tokens: maxTokens,
              temperature,
              messages: encode(false),
              usage: { include: true },
            }),
            signal: AbortSignal.timeout(timeoutMs),
          })
          if (t.ok) {
            const td = (await t.json()) as {
              choices?: Array<{ message?: { content?: string } }>
              usage?: ApiUsage
            }
            const content = td.choices?.[0]?.message?.content?.trim()
            if (content) {
              const u = usageOf(td.usage, model)
              if (u) opts?.onUsage?.(u)
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
      const data = (await res.json()) as { choices?: ToolResponseChoice[]; usage?: ApiUsage }
      const choice = data.choices?.[0]
      const msg = choice?.message
      const finishReason = choice?.finish_reason
      const content = (typeof msg?.content === 'string' ? msg.content.trim() : '') ?? ''
      const toolCalls = normalizeToolCalls(msg?.tool_calls)
      if (toolCalls.length > 0) {
        const u = usageOf(data.usage, model)
        if (u) opts?.onUsage?.(u)
        return { content, toolCalls, model, finishReason }
      }
      if (content) {
        const u = usageOf(data.usage, model)
        if (u) opts?.onUsage?.(u)
        // Текст-фолбэк: некоторые модели отвечают JSON-блоком даже с tools
        const parsed = parseToolJsonBlock(content)
        if (parsed) return { content: parsed.rest, toolCalls: [parsed.call], model, finishReason }
        return { content, toolCalls: [], model, finishReason }
      }
      lastError = new Error(`OpenRouter ${model}: пустой ответ`)
    } catch (e) {
      lastError = e
    }
  }
  throw lastError instanceof Error ? lastError : new Error('OpenRouter недоступен')
}

/* ==================== СТРИМИНГОВЫЙ TOOL-CALLING (v5.40) ==================== *
 *  Тот же протокол, что chatWithTools, но с stream:true: дельты текста
 *  уезжают наверх через onDelta сразу (realtime-печать в чате ИИ), дельты
 *  tool_calls аккумулируются по index и в конце склеиваются в ToolCall[].
 *  Если модель не умеет tools (400/404/422) — фолбэк на текстовый JSON-протокол
 *  без стрима. Если ни одна модель не дала токен — бросаем.
 */
export async function chatWithToolsStream(
  messages: ChatMsg[],
  tools: ToolSchema[],
  opts?: {
    maxTokens?: number
    timeoutMs?: number
    temperature?: number
    models?: string[]
    /** Сколько ждать первого токена до переключения модели */
    firstTokenMs?: number
    /** Реальный token-usage успешного вызова (для тарификации в свайпах) */
    onUsage?: (u: AiUsage) => void
    /** Дельта финального текста (realtime-стриминг в миниапп) */
    onDelta?: (chunk: string) => void
  },
): Promise<{ content: string; toolCalls: ToolCall[]; model?: string; finishReason?: string }> {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error('OPENROUTER_API_KEY не задан')
  const maxTokens = opts?.maxTokens ?? 1200
  const timeoutMs = opts?.timeoutMs ?? 60_000
  const temperature = opts?.temperature ?? 0.5
  const chain = opts?.models?.length ? opts.models : TOOL_MODELS
  const firstTokenMs = opts?.firstTokenMs ?? 12_000
  kickModelDiscovery()

  // Провайдерам без role:'tool' — совместимая история (как в chatWithTools.encode)
  const wire = messages.map((m) => {
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

  let lastError: unknown = null
  for (const model of chain) {
    let content = ''
    let sawAnyToken = false
    // finish_reason потока ('stop' | 'length' | ...) — length = ответ ОБРЕЗАН лимитом
    let finishReason: string | undefined
    try {
      const body: Record<string, unknown> = {
        model,
        max_tokens: maxTokens,
        temperature,
        stream: true,
        messages: wire,
      }
      // Пустой tools-массив некоторые провайдеры встречают 400 — шлём только когда есть
      if (tools.length > 0) {
        body.tools = tools
        body.tool_choice = 'auto'
      }
      const res = await postWith429Retry(body, timeoutMs)
      if (!res.ok || !res.body) {
        // Модель не умеет tools — фолбэк на текстовый JSON-протокол (не стримим:
        // JSON-блок юзеру показывать нельзя), дальше по цепочке не идём
        if (res.status === 400 || res.status === 404 || res.status === 422) {
          const plain = await chatWithTools(messages, tools, {
            maxTokens,
            timeoutMs,
            temperature,
            models: [model],
            onUsage: opts?.onUsage,
          })
          if (plain.content) {
            opts?.onDelta?.(plain.content)
            return plain
          }
        }
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
      firstTokenTimer = setTimeout(() => reader.cancel().catch(() => {}), firstTokenMs)

      // tool_calls по частям: index → { id, name, args }
      const tcAcc = new Map<number, { id: string; name: string; args: string }>()

      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith(':')) continue
            if (!trimmed.startsWith('data:')) continue
            const payload = trimmed.slice(5).trim()
            if (payload === '[DONE]') continue
            try {
              const json = JSON.parse(payload) as {
                choices?: Array<{
                  finish_reason?: string
                  delta?: {
                    content?: string
                    tool_calls?: Array<{
                      index?: number
                      id?: string
                      function?: { name?: string; arguments?: string }
                    }>
                  }
                }>
                usage?: ApiUsage
                error?: { message?: string }
              }
              if (json.error?.message) throw new Error(json.error.message)
              const u = usageOf(json.usage, model)
              if (u) opts?.onUsage?.(u)
              const chunkFinish = json.choices?.[0]?.finish_reason
              if (chunkFinish) finishReason = chunkFinish
              const delta = json.choices?.[0]?.delta
              const piece = delta?.content ?? ''
              if (piece) {
                sawAnyToken = true
                dropFirstTokenTimer()
                content += piece
                opts?.onDelta?.(piece)
              }
              for (const tc of delta?.tool_calls ?? []) {
                sawAnyToken = true
                dropFirstTokenTimer()
                const idx = tc.index ?? 0
                const cur = tcAcc.get(idx) ?? { id: '', name: '', args: '' }
                if (tc.id) cur.id = tc.id
                if (tc.function?.name) cur.name = tc.function.name
                if (tc.function?.arguments) cur.args += tc.function.arguments
                tcAcc.set(idx, cur)
              }
            } catch (e) {
              if (e instanceof Error && e.message && !/JSON/i.test(e.message)) throw e
            }
          }
        }
      } finally {
        dropFirstTokenTimer()
        reader.cancel().catch(() => {})
      }

      const toolCalls: ToolCall[] = [...tcAcc.values()]
        .filter((tc) => tc.name)
        .map((tc, i) => ({
          id: tc.id || `call_${i}`,
          name: tc.name,
          args: tc.args || '{}',
        }))
      if (toolCalls.length > 0) {
        return { content: content.trim(), toolCalls, model, finishReason }
      }
      if (content.trim().length > 0) {
        // Текст без tools — некоторые модели отвечают JSON-блоком даже со stream
        const parsed = parseToolJsonBlock(content)
        if (parsed) return { content: parsed.rest, toolCalls: [parsed.call], model, finishReason }
        return { content: content.trim(), toolCalls: [], model, finishReason }
      }
      lastError = new Error(`OpenRouter ${model}: пустой поток`)
    } catch (e) {
      lastError = e
      // Поток умер с содержательным куском — отдаём как есть (лучше, чем ничего);
      // помечаем length: текст реально оборван → вызывающий допишет продолжением
      if (sawAnyToken && content.trim().length >= 40) {
        return { content: content.trim(), toolCalls: [], model, finishReason: finishReason ?? 'length' }
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('OpenRouter недоступен')
}

/* ============================ ГЕНЕРАЦИЯ КАРТИНОК ============================ *
 *  v5.33: только бесплатный pollinations.ai (flux) — платные image-модели
 *  OpenRouter удалены (ноль рублей, см. src/lib/ai-image.ts).
 */
