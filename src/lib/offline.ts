import type { PostDTO } from '@/lib/types'

/**
 * Мини-обёртка IndexedDB (без зависимостей) для офлайн-кэша ленты.
 * Схема: store «kv», ключи вида "feed:<category>".
 * Все методы безопасны: при отсутствии IndexedDB (старые браузеры/SSR)
 * возвращают null — приложение просто работает без кэша.
 */

const DB_NAME = 'tgfeed'
const DB_VERSION = 1
const STORE = 'kv'
const CACHE_LIMIT = 40 // сколько постов храним на категорию

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE)
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

async function get<T>(key: string): Promise<T | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(key)
      req.onsuccess = () => resolve((req.result as T) ?? null)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function set(key: string, value: unknown): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
  } catch {
    // тихо — кэш не критичен
  }
}

export async function loadFeedCache(category: string): Promise<PostDTO[]> {
  const items = await get<PostDTO[]>(`feed:${category}`)
  return Array.isArray(items) ? items : []
}

/** Сохраняем первые CACHE_LIMIT постов ленты категории */
export async function saveFeedCache(category: string, items: PostDTO[]): Promise<void> {
  if (items.length === 0) return
  await set(`feed:${category}`, items.slice(0, CACHE_LIMIT))
}
