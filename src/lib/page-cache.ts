import type { PostDTO } from '@/lib/types'

/**
 * Кэш ГОТОВЫХ страниц ленты в памяти процесса (L0, без команд к Upstash).
 *
 * Зачем: БД в дальнем регионе (Supabase eu-central-1), каждая холодная страница
 * стоит 2-4с цепочки RTT. Повторные загрузки (смена вкладок категорий, возврат
 * на ленту, повторное открытие) — самый частый паттерн, и он обязан быть
 * мгновенным. Свежесть:
 *  - TTL 45с: новые посты всё равно приходят отдельной пилюлей «N новых»;
 *  - персональные флаги (liked/bookmarked) перекладываются поверх кэша
 *    через override-карту, которую заполняют /api/like и /api/bookmark —
 *    свежий лайк не «откатывается» кэшированной страницей.
 */

type PageEntry = { items: PostDTO[]; hasMore: boolean; exp: number }
type Flags = { liked?: boolean; bookmarked?: boolean }

/*
 * v5.52: хранилище через globalThis-синглтон (паттерн lib/db.ts). В dev Next.js
 * изолирует модули разных route-бандлов: /api/like писал override в СВОЮ копию
 * Map, /api/feed читал СВОЮ — «свежий лайк откатывался» на 45с. globalThis
 * гарантирует один инстанс на процесс для всех роутов (в проде — то же самое).
 */
type PageCacheStore = {
  pages: Map<string, PageEntry>
  overrides: Map<string, { flags: Flags; exp: number }>
}
const G = globalThis as unknown as { __tgFeedPageCache?: PageCacheStore }
const store: PageCacheStore = (G.__tgFeedPageCache ??= { pages: new Map(), overrides: new Map() })
const pages = store.pages
const overrides = store.overrides

/*
 * v5.58: TTL 45с → 90с — новые посты всё равно приходят отдельной пилюлей
 * «N новых» и попадают в ленту через /api/feed/fresh, а возвраты на вкладку
 * и смена вкладок вдвое дольше остаются мгновенными.
 */
const PAGE_TTL_MS = 90_000
const PAGE_MAX = 400
const OVERRIDE_TTL_MS = 10 * 60_000

const keyOf = (uid: string, category: string, page: number, limit: number, seed: string, lang: string) =>
  `${uid}|${category}|${page}|${limit}|${seed}|${lang}`

/** Взять страницу из кэша (применяя свежие персональные флаги); null — промах */
export function getCachedPage(
  uid: string,
  category: string,
  page: number,
  limit: number,
  seed: string,
  lang: string,
): { items: PostDTO[]; hasMore: boolean } | null {
  const hit = pages.get(keyOf(uid, category, page, limit, seed, lang))
  if (!hit || hit.exp <= Date.now()) {
    if (hit) pages.delete(keyOf(uid, category, page, limit, seed, lang))
    return null
  }
  const items = hit.items.map((p) => {
    const o = overrides.get(`${uid}|${p.id}`)
    return o && o.exp > Date.now() ? { ...p, ...o.flags } : p
  })
  return { items, hasMore: hit.hasMore }
}

/** Положить страницу в кэш */
export function putCachedPage(
  uid: string,
  category: string,
  page: number,
  limit: number,
  seed: string,
  lang: string,
  items: PostDTO[],
  hasMore: boolean,
) {
  if (pages.size >= PAGE_MAX) {
    const now = Date.now()
    for (const [k, e] of pages) if (e.exp <= now) pages.delete(k)
    if (pages.size >= PAGE_MAX) {
      const first = pages.keys().next().value
      if (first !== undefined) pages.delete(first)
    }
  }
  pages.set(keyOf(uid, category, page, limit, seed, lang), {
    items,
    hasMore,
    exp: Date.now() + PAGE_TTL_MS,
  })
}

/** Запомнить свежие персональные флаги поста (вызывают like/bookmark-роуты) */
export function putFlagsOverride(uid: string, postId: string, flags: Flags) {
  if (overrides.size > 5_000) {
    const now = Date.now()
    for (const [k, v] of overrides) if (v.exp <= now) overrides.delete(k)
  }
  overrides.set(`${uid}|${postId}`, { flags, exp: Date.now() + OVERRIDE_TTL_MS })
}

/**
 * Полная очистка кэша страниц: вызывают админские мутации рекламы (пауза/удаление
 * кампании) — иначе спонсорские посты могут доживать в кэше до 45с.
 */
export function clearPageCache() {
  pages.clear()
}

/**
 * Выборочная очистка кэша страниц ОДНОГО пользователя (Task 5-c):
 * «Не интересно»/жалоба/мьют обязаны примениться МГНОВЕННО, но L0-кэш
 * страниц (90с) отдаёт готовый JSON ДО свежих фильтров видимости в
 * /api/feed — без сброса скрытый пост доживал бы в кэше до минуты.
 * Снапшот порядка при этом НЕ трогаем (lib/feed-session.ts): страницы
 * перестраиваются из того же порядка, пагинация не дёргается, а свежий
 * фильтр исключений убирает скрытое уже на следующем запросе.
 */
export function clearUserPages(uid: string) {
  const prefix = `${uid}|`
  for (const k of pages.keys()) if (k.startsWith(prefix)) pages.delete(k)
}
