import { EventEmitter } from 'events'

/**
 * Внутренняя событийная шина приложения (в рамках процесса Next.js).
 * Используется для SSE-толкача (/api/events): парсер публикует «posts:new»,
 * лента и бейдж уведомлений реагируют без поллинга.
 * Хранилище на globalThis — чтобы не терялось при HMR в dev-режиме.
 */

export type AppEventMap = {
  /** Парсер добавил новые посты */
  'posts:new': { total: number; usernames: string[] }
  /** Создано уведомление для пользователя (бейдж колокольчика обновится сразу) */
  'notif:new': { userId: string }
}

/** События админ-панели (/admin) — отдельная шина, чтобы не светить их в пользовательском SSE */
export type AdminEventMap = {
  /** Парсер начал прогон */
  'parse:start': { total: number }
  /** Обработан очередной канал */
  'parse:progress': {
    current: number
    total: number
    username: string
    title: string
    added: number
    error?: string
  }
  /** Прогон завершён */
  'parse:done': { newPosts: number; ms: number }
}

type Bus = EventEmitter & { on?: never }

const g = globalThis as unknown as { __tgfeedBus?: EventEmitter; __tgfeedAdminBus?: EventEmitter }

export function appBus(): EventEmitter {
  if (!g.__tgfeedBus) {
    const b = new EventEmitter()
    b.setMaxListeners(200) // по одному слушателю на каждое SSE-соединение
    g.__tgfeedBus = b
  }
  return g.__tgfeedBus
}

export function adminBus(): EventEmitter {
  if (!g.__tgfeedAdminBus) {
    const b = new EventEmitter()
    b.setMaxListeners(50) // слушателей мало: несколько открытых вкладок /admin
    g.__tgfeedAdminBus = b
  }
  return g.__tgfeedAdminBus
}

/** Опубликовать событие (безопасно: ошибки слушателей не роняют издателя) */
export function emitAppEvent<E extends keyof AppEventMap>(name: E, payload: AppEventMap[E]): void {
  try {
    appBus().emit(name, payload)
  } catch {
    // события не критичны — молча
  }
}

export function emitAdminEvent<E extends keyof AdminEventMap>(
  name: E,
  payload: AdminEventMap[E],
): void {
  try {
    adminBus().emit(name, payload)
  } catch {
    // события не критичны — молча
  }
}
