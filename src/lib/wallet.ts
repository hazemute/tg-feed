import { db } from '@/lib/db'
import { invalidateBalance } from '@/lib/balance-cache'

/**
 * КОШЕЛЁК (v5.38–v5.39) — единая двухвалютная система.
 *
 *  • Рубли — balanceKop (копейки), пополняется картой/Stars/TON.
 *    Покупается ВСЁ: свайпы для нейросетей, тарифы Snap, рекламные кампании.
 *  • Свайпы — swipes. Валюта нейросетей (как кредиты в ChatGPT):
 *    списываются за запросы к ИИ ПО ТОКЕНАМ (v5.39), конвертируются в рубли.
 *    ЦЕНЫ ПО ТОКЕНАМ (v5.40): с курсом 500 свайпов/₽ те же AI_MTOK_*_SWP
 *    дают владельцу ×5 выручку в рублях за те же токены.
 *
 * КУРС (v5.40): 500 свайпов = 1 ₽ (1 свайп = 0,2 копейки, 1 копейка = 5 свайпов).
 *
 * Все операции атомарны (транзакции), ведутся в BalanceLog (журнал кошелька).
 * Инвариант: balanceKop ≥ 0, swipes ≥ 0 — условные декременты не дают уйти в минус.
 *
 * v5.61: КРИТИЧЕСКИЙ ФИКС — повсюду путались РУБЛИ и КОПЕЙКИ (×100 ошибка):
 * обмен 100 000 свайпов начислял 200 КОПЕЕК (2 ₽) вместо 200 ₽. Единая точка
 * правды — SWP_PER_KOP: все переводы валют идут только через kop↔swp хелперы.
 */

export const SWP_PER_RUB = 500
/** Свайпов в ОДНОЙ копейке: 500 свайпов/₽ ÷ 100 копеек = 5 свайпов за копейку */
export const SWP_PER_KOP = SWP_PER_RUB / 100
/** Минимум свайпов для конвертации в рубли */
export const SWP_CONVERT_MIN = SWP_PER_RUB

/* ===================== ТАРИФИКАЦИЯ ИИ (v5.39): по токенам ===================== *
 * Решение владельца: свайпы списываются не «за запрос», а по РЕАЛЬНО потраченным
 * токенам OpenRouter (usage.prompt_tokens / completion_tokens приходят в ответе
 * каждого вызова) — тяжёлые запросы стоят дороже, лёгкие дешевле.
 *
 * v5.74 (economy rebalance): цены ×4 — задание теперь даёт в 4 раза больше
 * свайпов (см. quests-seed), а запросы к ИИ ощутимее в кошельке:
 *   AI_MTOK_IN_SWP  — свайпов за 1 млн ВХОДНЫХ токенов (по умолчанию 4 000 = 40 ₽)
 *   AI_MTOK_OUT_SWP — свайпов за 1 млн ВЫХОДНЫХ токенов (по умолчанию 16 000 = 160 ₽)
 *   AI_IMAGE_SWP    — фикс за ОДНУ сгенерированную картинку (250 свайпов = 0,5 ₽),
 *                     списывается только при УСПЕШНОЙ генерации.
 * Типичный лёгкий запрос (≈2 000 входных + 300 выходных) ≈ 13 свайпов;
 * чат ассистента с инструментами и памятью ≈ 40–80 свайпов.
 *
 * ВАЖНО (v5.74): «ИИ не ответил — свайпы не снимаем». chargeAiUsage вызывается
 * ТОЛЬКО после успешного ответа (done); ветки ошибок/обрывов не тарифицируются.
 */
function envNum(v: string | undefined, dflt: number): number {
  if (!v || !v.trim()) return dflt // пустая/не заданная переменная — дефолт
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : dflt
}
export const AI_MTOK_IN_SWP = envNum(process.env.AI_MTOK_IN_SWP, 4000)
export const AI_MTOK_OUT_SWP = envNum(process.env.AI_MTOK_OUT_SWP, 16000)
/** Свайпов за одну успешную генерацию картинки (pollinations + скачивание + WebP) */
export const AI_IMAGE_SWP = envNum(process.env.AI_IMAGE_SWP, 250)

export type AiUsage = { promptTokens: number; completionTokens: number; model?: string }

/** Свайпы за реальный usage OpenRouter. Минимум 1 свайп за запрос к ИИ. */
export function swipesForUsage(u: AiUsage): number {
  const raw = ((u.promptTokens || 0) * AI_MTOK_IN_SWP + (u.completionTokens || 0) * AI_MTOK_OUT_SWP) / 1_000_000
  return Math.max(1, Math.ceil(raw))
}

/** Оценка числа токенов по символам промпта (кириллица ≈ 3.2 символа на токен) */
export function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 3.2))
}

/** Худший случай ДО вызова: вход по оценке символов + максимум выхода (max_tokens) */
export function estimateAiSwipes(inputChars: number, maxTokens: number): number {
  return swipesForUsage({ promptTokens: estimateTokens(inputChars), completionTokens: maxTokens })
}

export type Wallet = { balanceKop: number; swipes: number }

/** Свайпы → копейки: 500 свайпов = 100 копеек = 1 ₽ (округляем вверх, дробных копеек нет) */
export function swpToKop(swipes: number): number {
  return Math.ceil(swipes / SWP_PER_KOP) // 500 свайпов → 100 коп.
}
/** Копейки → свайпы: 1 копейка = 5 свайпов */
export function kopToSwp(kop: number): number {
  return Math.floor(kop * SWP_PER_KOP) // 100 коп. → 500 свайпов
}

/** Формат ₽ из копеек: 123456 → «1 234,56 ₽» (тонкий пробел-разделитель тысяч) */
export function fmtRub(kop: number): string {
  const sign = kop < 0 ? '−' : ''
  const v = Math.abs(kop) / 100
  const [int, frac] = v.toFixed(2).split('.')
  const intSpaced = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `${sign}${intSpaced},${frac} ₽`
}

// --------------------------------------------------------------------------- //
//  Внутренние проводки (всегда в транзакции вызывающего кода или своей)
// --------------------------------------------------------------------------- //

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0]

/** Журнал: +зачисление / −списание. currency 'rub' → amount в копейках, 'swp' → в свайпах. */
async function log(
  tx: Tx,
  userId: string,
  kind: 'topup' | 'convert' | 'ai_spend' | 'purchase' | 'ad_campaign' | 'refund' | 'admin',
  currency: 'rub' | 'swp',
  amount: number,
  note?: string,
): Promise<void> {
  await tx.balanceLog.create({ data: { userId, kind, currency, amount, note: note ?? null } })
}

/**
 * Списать свайпы. Если их не хватает — ДОКУПИТЬ недостающее с рублёвого баланса
 * (докупаем с запасом, кратным 500 свайпов, если хватает денег):
 * так «за рубли можно пользоваться всем сервисом, не оплачивая картой на месте».
 * Возвращает false, если и рублей не хватает.
 */
export async function spendSwipes(
  userId: string,
  cost: number,
  note?: string,
): Promise<boolean> {
  if (cost <= 0) return true
  // v5.54: Reject — «недостаточно средств/проиграна гонка» → откат всей транзакции.
  // Раньше ветка докупки делала безусловный decrement после read-then-write:
  // два параллельных списания читали один баланс и оба проходили → баланс в минус.
  class Reject extends Error {}
  try {
    await db.$transaction(async (tx) => {
      const u = await tx.user.findUnique({
        where: { id: userId },
        select: { swipes: true, balanceKop: true },
      })
      if (!u) throw new Reject()

      if (u.swipes >= cost) {
        // Условный декремент: WHERE swipes >= cost — БД не даст уйти в минус
        // даже если параллельный запрос уже списал свайпы после нашего чтения.
        const dec = await tx.user.updateMany({
          where: { id: userId, swipes: { gte: cost } },
          data: { swipes: { decrement: cost } },
        })
        if (dec.count === 0) throw new Reject()
        await log(tx, userId, 'ai_spend', 'swp', -cost, note)
        return
      }

      // Не хватает свайпов — докупаем с рублёвого баланса по курсу 500 свайпов = 1 ₽
      const deficit = cost - u.swipes
      // Пакет докупки: кратен 500, но не меньше дефицита; если денег впритык — берём ровно дефицит
      const buy = Math.max(
        deficit,
        Math.ceil(deficit / SWP_PER_RUB) * SWP_PER_RUB,
      ) // ≥ deficit, обычно круглыми пятисотками
      const buyKop = swpToKop(buy) // стоимость пакета в копейках (500 свайпов = 1 ₽)
      const deficitKop = swpToKop(deficit)
      const affordable = u.balanceKop >= buyKop ? buy : u.balanceKop >= deficitKop ? deficit : 0
      const payKop = swpToKop(affordable)
      if (affordable <= 0) throw new Reject()

      // Условный декремент рублей: WHERE balanceKop >= payKop
      const paid = await tx.user.updateMany({
        where: { id: userId, balanceKop: { gte: payKop } },
        data: { balanceKop: { decrement: payKop }, swipes: { increment: affordable } },
      })
      if (paid.count === 0) throw new Reject()
      await log(tx, userId, 'convert', 'rub', -payKop, 'авто-покупка свайпов с баланса')
      await log(tx, userId, 'convert', 'swp', affordable, 'авто-покупка свайпов с баланса')

      const dec2 = await tx.user.updateMany({
        where: { id: userId, swipes: { gte: cost } },
        data: { swipes: { decrement: cost } },
      })
      // Свайпы могли уйти параллельной трате между покупкой и списанием —
      // откатываем и покупку тоже (деньги не конвертируются «в никуда»).
      if (dec2.count === 0) throw new Reject()
      await log(tx, userId, 'ai_spend', 'swp', -cost, note)
    })
  } catch (e) {
    if (e instanceof Reject) return false
    throw e
  }
  await invalidateBalance(userId) // кэш баланса устарел — edge увидит свежие данные после перечита
  return true
}

/** Конвертация свайпы → рубли: 500 свайпов = 1 ₽. Остаток (<500) остаётся свайпами. */
export async function convertSwpToRub(
  userId: string,
  swipes: number,
): Promise<{ ok: boolean; error?: string; rubKop?: number; spentSwipes?: number }> {
  if (!Number.isInteger(swipes) || swipes < SWP_CONVERT_MIN) {
    return { ok: false, error: `Минимум ${SWP_CONVERT_MIN} свайпов` }
  }
  // v5.61 фикс ×100: rubKop — это КОПЕЙКИ. 100 000 свайпов = 20 000 коп. = 200 ₽.
  // Раньше здесь писали rubles-число в копеечное поле → юзер получал в 100 раз меньше.
  const rubKop = Math.floor(swipes / SWP_PER_KOP) // копейки: floor(100000/5)=20000
  const spentSwipes = rubKop * SWP_PER_KOP // списываем ровно столько свайпов, сколько начислили (остаток <500 остаётся)
  const res = await db.$transaction(async (tx) => {
    const updated = await tx.user.updateMany({
      where: { id: userId, swipes: { gte: spentSwipes } },
      data: { swipes: { decrement: spentSwipes }, balanceKop: { increment: rubKop } },
    })
    if (updated.count === 0) return { ok: false, error: 'Недостаточно свайпов' }
    await log(tx, userId, 'convert', 'swp', -spentSwipes, 'обмен в рубли')
    await log(tx, userId, 'convert', 'rub', rubKop, 'обмен из свайпов')
    return { ok: true, rubKop, spentSwipes }
  })
  if (res.ok) await invalidateBalance(userId)
  return res
}

/** Конвертация рубли → свайпы: 1 копейка = 5 свайпов (500 свайпов = 1 ₽). */
export async function convertRubToSwp(
  userId: string,
  kop: number,
): Promise<{ ok: boolean; error?: string; swipes?: number }> {
  if (!Number.isInteger(kop) || kop < 1) {
    return { ok: false, error: 'Минимум 0,01 ₽' }
  }
  const res = await db.$transaction(async (tx) => {
    const updated = await tx.user.updateMany({
      where: { id: userId, balanceKop: { gte: kop } },
      data: { balanceKop: { decrement: kop }, swipes: { increment: kopToSwp(kop) } },
    })
    if (updated.count === 0) return { ok: false, error: 'Недостаточно рублей на балансе' }
    await log(tx, userId, 'convert', 'rub', -kop, 'обмен в свайпы')
    await log(tx, userId, 'convert', 'swp', kopToSwp(kop), 'обмен из рублей')
    return { ok: true, swipes: kopToSwp(kop) }
  })
  if (res.ok) await invalidateBalance(userId)
  return res
}

/**
 * Оплата покупки с рублёвого баланса (тарифы, всё что есть в сервисе).
 * Атомарно: условный декремент не даст уйти в минус. Возвращает false — не хватает.
 */
export async function payWithBalance(
  userId: string,
  amountKop: number,
  note?: string,
): Promise<boolean> {
  if (amountKop <= 0) return true
  const ok = await db.$transaction(async (tx) => {
    const updated = await tx.user.updateMany({
      where: { id: userId, balanceKop: { gte: amountKop } },
      data: { balanceKop: { decrement: amountKop } },
    })
    if (updated.count === 0) return false
    await log(tx, userId, 'purchase', 'rub', -amountKop, note)
    return true
  })
  if (ok) await invalidateBalance(userId)
  return ok
}

/**
 * v5.54: вернуть списанное с баланса (компенсация сбоя после payWithBalance —
 * например покупка тира списала деньги, но тир не выдался). Атомарный increment.
 */
export async function refundToBalance(
  userId: string,
  amountKop: number,
  note?: string,
): Promise<void> {
  if (amountKop <= 0) return
  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { balanceKop: { increment: amountKop } },
    })
    await log(tx, userId, 'refund', 'rub', amountKop, note)
  })
  await invalidateBalance(userId)
}

/**
 * v5.69: купить пакет продвижений С БАЛАНСА — атомарно одной транзакцией:
 * условный декремент рублей (не уйдёт в минус) + начисление кредитов
 * (User.promoteCredits) + журнал 'purchase'. false — денег не хватает.
 * Оплата картой (полная/50/50) идёт через PendingPayment → creditPendingPayment.
 */
export async function buyPromotePackWithBalance(
  userId: string,
  priceKop: number,
  credits: number,
  note?: string,
): Promise<boolean> {
  if (priceKop <= 0 || credits <= 0) return false
  const ok = await db.$transaction(async (tx) => {
    const updated = await tx.user.updateMany({
      where: { id: userId, balanceKop: { gte: priceKop } },
      data: {
        balanceKop: { decrement: priceKop },
        promoteCredits: { increment: credits },
      },
    })
    if (updated.count === 0) return false
    await log(tx, userId, 'purchase', 'rub', -priceKop, note)
    return true
  })
  if (ok) await invalidateBalance(userId)
  return ok
}

/** Журнал кошелька (новые сверху) */
export async function walletHistory(userId: string, take = 20) {
  return db.balanceLog.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take,
    select: { id: true, kind: true, currency: true, amount: true, note: true, createdAt: true },
  })
}

/**
 * Копилка token-usage за цепочку вызовов (чат с инструментами делает несколько
 * вызовов ИИ — суммируем prompt/completion токены всех шагов в один usage).
 * Общая для ИИ-поиска и ИИ-ассистента.
 */
export function usageCollector() {
  const acc: { usage: AiUsage | null } = { usage: null }
  return {
    acc,
    onUsage: (u: AiUsage) => {
      if (!acc.usage) {
        acc.usage = { promptTokens: u.promptTokens, completionTokens: u.completionTokens, model: u.model }
      } else {
        acc.usage.promptTokens += u.promptTokens
        acc.usage.completionTokens += u.completionTokens
        if (u.model) acc.usage.model = u.model
      }
    },
  }
}

/* ==================== ПЛАТНЫЕ ВЫЗОВЫ ИИ (v5.39) ==================== *
 * Схема «проверка до → списание по факту после»:
 *  1) до платного вызова — aiCanAfford по ХУДШЕМУ случаю (оценка входа +
 *     max_tokens): не хватает свайпов И рублей → отказ до генерации;
 *  2) после вызова — chargeAiUsage по РЕАЛЬНОМУ usage OpenRouter
 *     (spendSwipes сам докупит недостающее с рублёвого баланса).
 * Если модель не отдала usage (редко) — списываем fallback-оценку.
 */

/** Хватает ли на кошельке на платный вызов ИИ (свайпы + авто-покупка с рублей 1:1) */
export async function aiCanAfford(userId: string, estSwipes: number): Promise<boolean> {
  if (estSwipes <= 0) return true
  const u = await db.user.findUnique({
    where: { id: userId },
    select: { swipes: true, balanceKop: true },
  })
  if (!u) return false
  // 1 копейка = 5 свайпов (SWP_PER_KOP); раньше множили на 500 — переоценка в 100 раз
  return u.swipes + u.balanceKop * SWP_PER_KOP >= estSwipes
}

/**
 * Списать свайпы по фактическому token-usage OpenRouter.
 * best-effort: false (баланса нет) вызывающий код игнорирует — ответ уже отдан.
 */
export async function chargeAiUsage(
  userId: string,
  usage: AiUsage | null,
  feature: string,
  fallbackSwipes = 1,
): Promise<boolean> {
  const cost = usage ? swipesForUsage(usage) : Math.max(1, fallbackSwipes)
  const note = usage
    ? `${feature}: ${usage.promptTokens} вх. + ${usage.completionTokens} вых. токенов${usage.model ? ` · ${usage.model}` : ''}`
    : `${feature}: расчёт по оценке (usage не получен)`
  return spendSwipes(userId, cost, note)
}
