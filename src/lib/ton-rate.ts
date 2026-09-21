/**
 * Курс TON → RUB с кэшем в памяти (10 минут; устаревший до 24ч — фолбэк).
 *
 * Источники (по порядку):
 *  1) CoinGecko simple price (бесплатный, без ключа);
 *  2) TonAPI /v2/rates (бесплатный, без ключа);
 *  3) устаревший кэш — лучше старый курс, чем недоступная оплата.
 *
 * Курс нужен только для ВЫСТАВЛЕНИЯ счёта: сумма в TON фиксируется при
 * создании платежа, колебания после не влияют (перевод идёт по зафиксированной
 * сумме с запасом ~2% на волатильность и комиссии сети).
 */

export type TonRate = { rub: number; at: number; source: string }

let cache: TonRate | null = null
const FRESH_MS = 10 * 60 * 1000
const STALE_MS = 24 * 60 * 60 * 1000

export async function getTonRubRate(): Promise<TonRate> {
  if (cache && Date.now() - cache.at < FRESH_MS) return cache

  // 1) CoinGecko
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=rub',
      { signal: AbortSignal.timeout(6000), cache: 'no-store' },
    )
    if (res.ok) {
      const d = (await res.json()) as { 'the-open-network'?: { rub?: number } }
      const rub = d['the-open-network']?.rub
      if (typeof rub === 'number' && rub > 0) {
        cache = { rub, at: Date.now(), source: 'coingecko' }
        return cache
      }
    }
  } catch {
    /* следующий источник */
  }

  // 2) TonAPI
  try {
    const res = await fetch('https://tonapi.io/v2/rates?tokens=ton&currencies=rub', {
      signal: AbortSignal.timeout(6000),
      cache: 'no-store',
    })
    if (res.ok) {
      const d = (await res.json()) as { rates?: { TON?: { RUB?: number } } }
      const rub = d.rates?.TON?.RUB
      if (typeof rub === 'number' && rub > 0) {
        cache = { rub, at: Date.now(), source: 'tonapi' }
        return cache
      }
    }
  } catch {
    /* фолбэк на устаревший кэш */
  }

  if (cache && Date.now() - cache.at < STALE_MS) return cache
  throw new Error('Курс TON временно недоступен — попробуйте чуть позже')
}
