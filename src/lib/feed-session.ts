import type { LangFilter } from '@/lib/lang'

/**
 * ПЕРСОНАЛЬНЫЙ СНАПШОТ ПОРЯДКА ЛЕНТЫ (Task 5-c — лечение «баганных рекомендаций»).
 *
 * ПРОБЛЕМА, которую решает: страница N вырезалась из порядка, который
 * ПЕРЕСЧИТЫВАЛСЯ на каждый запрос из живых данных:
 *   - сигналы пользователя растут с каждым просмотром (TTL кэша 15с) →
 *     штрафы за просмотренное сдвигают весь хвост → между запросами страниц
 *     1 и 2 посты перескакивают через границу (пропуски/повторы);
 *   - глобальный вес дышит каждую секунду (свежесть в числителе, jitter,
 *     hotScore) → близкие веса меняются местами между запросами;
 *   - индекс (TTL 300с) перестраивается с новыми постами → сдвиг ВСЕГО списка;
 *   - сид по умолчанию «userId:час» переворачивал порядок на границе часа;
 *   - промо/спонсоры вставлялись ТОЛЬКО на странице 0 с перевырезкой страниц.
 * Итог жалоб: «повторы постов между страницами, дёрганье порядка при пагинации».
 *
 * РЕШЕНИЕ: финальный персональный порядок (после фильтров языка/мьютов/
 * скрытых/жалоб, персонального скора, языкового множителя, сортировки с
 * детерминированным tiebreak, diversify и пинning промо/спонсоров) замораживается
 * в снапшот на сессию скролла. Пагинация = честные срезы ОДНОГО списка:
 *   • дубли между страницами невозможны по построению (каждый id встречается 1 раз);
 *   • порядок стабилен между запросами (детерминированный построитель + single-flight);
 *   • «Не интересно»/жалобы/мьюты, сделанные В СЕРЕДИНЕ сессии, применяются
 *     на выдаче свежим фильтром поверх снапшота (пост исчезает, остальные не перемешиваются);
 *   • новый refresh (новый сид от клиента) строит новый снапшот — ротация ленты работает как раньше.
 *
 * Ключ снапшота: userId|category|lang|seed. TTL 10 минут (сессия скролла),
 * кап 600 снапшотов (≈600 активных сессий на инстанс, ~240К строк-идентификаторов).
 * Снапшот живёт В ПАМЯТИ процесса (L0) — как page-cache; через globalThis-синглтон,
 * чтобы dev-изоляция модулей Next не сделала две копии карты (см. lib/page-cache.ts).
 */

export type FeedSnapshotItem = { id: string; cid: string }

export type FeedSnapshot = {
  /** Финальный порядок страницы-потока: post ids с channelId (для мьют-фильтра на выдаче) */
  items: FeedSnapshotItem[]
  /** Промо-посты (Snap Pro «Продвинуть») — для dto.promoted */
  promotedIds: Set<string>
  /** Спонсорские посты (активные CPA-кампании) — для dto.sponsored + показов */
  sponsoredIds: Set<string>
  /** channelId → campaignId (для инкремента показов, когда пост реально на странице) */
  sponsorCampaigns: Map<string, string>
  builtAt: number
  exp: number
}

type SnapshotStore = { sessions: Map<string, FeedSnapshot>; inflight: Map<string, Promise<FeedSnapshot>> }
const G = globalThis as unknown as { __tgFeedSessions?: SnapshotStore }
const store: SnapshotStore = (G.__tgFeedSessions ??= { sessions: new Map(), inflight: new Map() })

const SNAPSHOT_TTL_MS = 10 * 60_000
const SNAPSHOT_MAX = 600

/** Ключ сессии рекомендаций: пользователь + разрез ленты + язык + сид обновления */
export function feedSessionKey(userId: string, category: string, lang: LangFilter, seed: string): string {
  return `${userId}|${category}|${lang}|${seed}`
}

function evictExpired(now: number): void {
  if (store.sessions.size < SNAPSHOT_MAX) return
  for (const [k, s] of store.sessions) if (s.exp <= now) store.sessions.delete(k)
  while (store.sessions.size >= SNAPSHOT_MAX) {
    const first = store.sessions.keys().next().value
    if (first === undefined) break
    store.sessions.delete(first)
  }
}

/** Живой снапшот сессии или null (промах/TTL) */
export function getFeedSnapshot(key: string): FeedSnapshot | null {
  const hit = store.sessions.get(key)
  if (!hit) return null
  if (hit.exp <= Date.now()) {
    store.sessions.delete(key)
    return null
  }
  return hit
}

/**
 * Снапшот с single-flight: параллельные страницы одной сессии (клиент
 * префетчит p+1 пока пользователь читает p) гарантированно получают ОДИН
 * и тот же построитель — иначе два параллельных запроса построили бы два
 * слегка разных порядка и вернули бы пересекающиеся страницы.
 */
export async function getOrBuildFeedSnapshot(
  key: string,
  build: () => Promise<FeedSnapshot>,
): Promise<FeedSnapshot> {
  const live = getFeedSnapshot(key)
  if (live) return live

  const running = store.inflight.get(key)
  if (running) return running

  const p = (async (): Promise<FeedSnapshot> => {
    const snap = await build()
    snap.builtAt = Date.now()
    snap.exp = Date.now() + SNAPSHOT_TTL_MS
    evictExpired(Date.now())
    store.sessions.set(key, snap)
    return snap
  })()

  store.inflight.set(key, p)
  try {
    return await p
  } finally {
    store.inflight.delete(key)
  }
}

/** Сброс снапшотов пользователя (мутации, ломающие порядок: мьют канала и т.п.) */
export function invalidateUserSnapshots(userId: string): void {
  const prefix = `${userId}|`
  for (const k of store.sessions.keys()) if (k.startsWith(prefix)) store.sessions.delete(k)
}
