import { db } from '@/lib/db'
import { runParser } from '@/lib/parse-engine'
import { cacheGet, cacheSet } from '@/lib/redis'

/**
 * v5.96 — ИМПОРТ ИСТОРИИ ПРИВЯЗАННОГО КАНАЛА (бэкфил).
 *
 * КОРЕНЬ БАГА «кабинет пустой, статистика по нулям»: до этой версии посты
 * привязанного канала попадали в БД ТОЛЬКО как новые channel_post через
 * вебхук. История канала (а у владельца её сотни постов) НЕ импортировалась
 * никогда → «0 постов», «Канал пуст», статистика из нулей при живом канале
 * на 868 подписчиков.
 *
 * Решение: после привязки (и по кнопке «Импортировать посты», и самолечением
 * при открытии кабинета с пустым каналом) прогоняем обычный парсер t.me/s
 * ТОЛЬКО по этому каналу с глубокой пагинацией ?before=<id> (до 20 страниц ×
 * ~20 постов). Ровно тот же конвейер, что у каталога: зачистка текста,
 * медиа, премиум-эмодзи, просмотры/реакции из веб-превью.
 *
 * Троттлинг: Redis-ключ (общий для всех инстансов serverless) + in-process
 * Set (мгновенная защита от параллельных вызовов в тёплом инстансе).
 * Авто-запуск и кнопка используют разный интервал: кнопка — чаще.
 */

/** Авто-самолечение при открытии кабинета: не чаще раза в 30 минут */
const AUTO_THROTTLE_SEC = 30 * 60
/** Ручной запуск кнопкой «Импортировать» — не чаще раза в 3 минуты */
const MANUAL_THROTTLE_SEC = 3 * 60

const inFlight = new Set<string>()

export type BackfillResult = {
  ok: boolean
  reason?: 'throttled' | 'in-flight' | 'empty-username'
  added?: number
  scannedError?: string
}

function normalize(raw: string): string {
  return raw
    .replace(/^@/, '')
    .replace(/^https?:\/\/t\.me\//, '')
    .split('/')[0]
    .trim()
    .toLowerCase()
}

/**
 * Импорт истории канала username → таблицу Post. Синхронный (результат
 * верен), вызывать из after() — ответ клиенту он не задерживает.
 *
 * @param pages   глубина истории: страниц t.me/s?before= (1..20)
 * @param per     сколько НОВЫХ постов максимум добавить за прогон
 */
export async function backfillChannelHistory(
  rawUsername: string,
  opts?: { pages?: number; per?: number; manual?: boolean; deadlineMs?: number },
): Promise<BackfillResult> {
  const username = normalize(rawUsername)
  if (!username) return { ok: false, reason: 'empty-username' }

  const throttleSec = opts?.manual ? MANUAL_THROTTLE_SEC : AUTO_THROTTLE_SEC
  const lockKey = `chbackfill:${username}`

  // Мгновенный guard в тёплом инстансе
  if (inFlight.has(username)) return { ok: false, reason: 'in-flight' }

  // Кросс-инстансовый троттлинг (Redis недоступен — не валим импорт,
  // in-process Set всё равно защищает от параллельности)
  try {
    const busy = await cacheGet<number>(lockKey)
    if (busy) return { ok: false, reason: 'throttled' }
  } catch {
    /* Redis моргнул — идём дальше */
  }
  try {
    await cacheSet(lockKey, Date.now(), throttleSec)
  } catch {
    /* нет Redis — троттлинг только in-process */
  }
  inFlight.add(username)
  try {
    // deadlineMs: мягкий бюджет прогона — парсер сам докрутит до конца страницы
    // и вернёт truncated, чтобы не упереться в maxDuration serverless-функции
    const r = await runParser(
      opts?.per ?? 50,
      username,
      1,
      opts?.deadlineMs ?? 40_000,
      Math.max(1, Math.min(20, opts?.pages ?? 8)),
    )
    const res = r.results[0]
    if (res?.error) {
      // t.me/s недоступен / канал не публичный — вернём причину в логи
      return { ok: false, scannedError: res.error, added: res.added }
    }
    return { ok: true, added: res?.added ?? 0 }
  } catch (e) {
    console.error('[channel-backfill]', e instanceof Error ? e.message.slice(0, 160) : e)
    return { ok: false, scannedError: 'exception' }
  } finally {
    inFlight.delete(username)
  }
}

/**
 * Самолечение при открытии кабинета: канал владельца есть, публичный,
 * а постов в ленте НОЛЬ → запускаем импорт истории. Возвращает true, если
 * бэкфил реально запущен (вызывающий код делает это через after()).
 */
export async function maybeBackfillEmptyChannel(
  channelId: string,
  username: string | null,
): Promise<boolean> {
  if (!username) return false
  const ch = await db.channel.findUnique({
    where: { id: channelId },
    select: { id: true, username: true, claimedById: true, status: true },
  })
  if (!ch || !ch.claimedById || !ch.username) return false
  const posts = await db.post.count({ where: { channelId: ch.id } })
  if (posts > 0) return false
  const r = await backfillChannelHistory(ch.username, { pages: 8, per: 50 })
  if (r.added) {
    console.log(`[channel-backfill] @${ch.username}: +${r.added} постов истории`)
  }
  return r.ok
}
