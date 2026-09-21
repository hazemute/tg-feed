import { cacheDel, cacheGet, cacheSet } from '@/lib/redis'

/**
 * Кэш БАЛАНСА кошелька в Redis (v5.39) — «проверка баланса за микросекунды».
 *
 * Схема «баланс из Redis» (решение владельца: даже если тысячи человек
 * одновременно ломанутся проверять баланс после конкурса — Supabase не заметит):
 *   • каждая транзакция кошелька (списание/конвертация/покупка/пополнение)
 *     ИНВАЛИДИРУЕТ ключ bal:{uid};
 *   • GET /api/wallet (Node + Prisma) читает БД и ЗАПИСЫВАЕТ свежий баланс
 *     в кэш (write-through);
 *   • GET /api/wallet/balance (Vercel Edge, runtime='edge') читает ТОЛЬКО
 *     этот ключ через Upstash REST — ноль обращений к PostgreSQL.
 *     Кэш холодный → { ok:false } и клиент добирает из /api/wallet.
 *
 * ВАЖНО: модуль EDGE-СОВМЕСТИМ — только Upstash REST (fetch), никакого Prisma.
 * Импортируется и из lib/wallet.ts (Node), и из edge-роута.
 */

/** Жизнь ключа баланса: короткая — устаревание ограничено, инвалидация мгновенная */
export const BAL_TTL_SEC = 120

export const balKeyOf = (uid: string): string => `bal:${uid}`

export type CachedBalance = { balanceKop: number; swipes: number }

/** Write-through: свежий баланс из БД → Redis (вызывает Node-роут после чтения) */
export async function cacheBalance(uid: string, b: CachedBalance): Promise<void> {
  await cacheSet(balKeyOf(uid), b, BAL_TTL_SEC)
}

/** После любой мутации кошелька: ключ удаляется — edge отдаст { ok:false } */
export async function invalidateBalance(uid: string): Promise<void> {
  await cacheDel(balKeyOf(uid))
}

/** Только для edge-роута: читаем ключ и строго проверяем форму данных */
export async function readCachedBalance(uid: string): Promise<CachedBalance | null> {
  const v = await cacheGet<CachedBalance>(balKeyOf(uid))
  if (!v || typeof v !== 'object') return null
  const rec = v as Record<string, unknown>
  if (typeof rec.balanceKop !== 'number' || typeof rec.swipes !== 'number') return null
  if (!Number.isFinite(rec.balanceKop) || !Number.isFinite(rec.swipes)) return null
  return { balanceKop: rec.balanceKop, swipes: rec.swipes }
}
