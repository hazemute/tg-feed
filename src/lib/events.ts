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
}

type Bus = EventEmitter & { on?: never }

const g = globalThis as unknown as { __tgfeedBus?: EventEmitter }

export function appBus(): EventEmitter {
  if (!g.__tgfeedBus) {
    const b = new EventEmitter()
    b.setMaxListeners(200) // по одному слушателю на каждое SSE-соединение
    g.__tgfeedBus = b
  }
  return g.__tgfeedBus
}

/** Опубликовать событие (безопасно: ошибки слушателей не роняют издателя) */
export function emitAppEvent<E extends keyof AppEventMap>(name: E, payload: AppEventMap[E]): void {
  try {
    appBus().emit(name, payload)
  } catch {
    // события не критичны — молча
  }
}
