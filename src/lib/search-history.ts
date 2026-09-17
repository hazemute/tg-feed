/**
 * История поисковых запросов (localStorage).
 * Ключ tgfeed_search_history, максимум 8 запросов, свежие первыми, без дубликатов.
 * Все методы безопасны при отсутствии localStorage (SSR / приватный режим).
 */

const HISTORY_KEY = 'tgfeed_search_history'
const MAX_HISTORY = 8

/** Прочитать историю: trim, без пустых и дубликатов, максимум 8, свежие первыми */
export function loadSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const result: string[] = []
    for (const item of parsed) {
      if (typeof item !== 'string') continue
      const query = item.trim()
      if (!query || seen.has(query)) continue
      seen.add(query)
      result.push(query)
      if (result.length >= MAX_HISTORY) break
    }
    return result
  } catch {
    return []
  }
}

/** Сохранить запрос наверх списка (пустые и пробельные не сохраняются). Возвращает новый список */
export function saveSearchQuery(q: string): string[] {
  const query = q.trim()
  if (!query) return loadSearchHistory()
  const next = [query, ...loadSearchHistory().filter((item) => item !== query)].slice(0, MAX_HISTORY)
  writeHistory(next)
  return next
}

/** Удалить один запрос из истории. Возвращает новый список */
export function removeSearchQuery(q: string): string[] {
  const query = q.trim()
  const next = loadSearchHistory().filter((item) => item !== query)
  writeHistory(next)
  return next
}

/** Полностью очистить историю. Возвращает пустой список (удобно для setState) */
export function clearSearchHistory(): string[] {
  try {
    localStorage.removeItem(HISTORY_KEY)
  } catch {
    // приватный режим — игнорируем
  }
  return []
}

function writeHistory(list: string[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list))
  } catch {
    // приватный режим / переполнение квоты — игнорируем
  }
}
