'use client'

import { useEffect, useRef, useState } from 'react'

import { getAdminKey } from './api'

/**
 * Единое SSE-соединение к /api/panel/events на всю вкладку /admin.
 * Общий singleton с ref-count: OverviewTab и ToolsTab подписываются независимо,
 * EventSource открывается один раз и переиспользуется; переподключение — через 5с.
 */

export type AdminSseEvent =
  | { name: 'hello'; data: { ts: number } }
  | { name: 'status'; data: { ts: number; bot: boolean } }
  | { name: 'parse:start'; data: { total: number } }
  | {
      name: 'parse:progress'
      data: {
        current: number
        total: number
        username: string
        title: string
        added: number
        error?: string
      }
    }
  | { name: 'parse:done'; data: { newPosts: number; ms: number } }

type Handler = (event: AdminSseEvent) => void

const listeners = new Set<Handler>()
let es: EventSource | null = null
let refCount = 0
let isOpen = false // текущее состояние singleton-соединения
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
const connectionWatchers = new Set<(connected: boolean) => void>()

const EVENT_NAMES = ['hello', 'status', 'parse:start', 'parse:progress', 'parse:done'] as const

function dispatch(event: AdminSseEvent) {
  for (const h of listeners) {
    try {
      h(event)
    } catch {
      // ошибка одного слушателя не роняет остальные
    }
  }
}

function notifyWatchers(connected: boolean) {
  for (const w of connectionWatchers) {
    try {
      w(connected)
    } catch {
      // noop
    }
  }
}

function openStream() {
  const key = getAdminKey()
  if (!key) return // без ключа не подключаемся — после логина будет retry
  if (es) return

  es = new EventSource(`/api/panel/events?key=${encodeURIComponent(key)}`)

  es.onopen = () => {
    isOpen = true
    notifyWatchers(true)
  }

  for (const name of EVENT_NAMES) {
    es.addEventListener(name, (e) => {
      try {
        const raw = (e as MessageEvent<string>).data
        const data = raw ? JSON.parse(raw) : null
        dispatch({ name, data } as AdminSseEvent)
      } catch {
        // битый JSON игнорируем
      }
    })
  }

  es.onerror = () => {
    // 401/сеть — браузерный EventSource молча ретраится; мы закрываем и пробуем раз в 5с
    es?.close()
    es = null
    isOpen = false
    notifyWatchers(false)
    if (refCount > 0 && !reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        openStream()
      }, 5_000)
    }
  }
}

function acquire() {
  refCount++
  openStream()
}

function release() {
  refCount = Math.max(0, refCount - 1)
  if (refCount === 0) {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    es?.close()
    es = null
    isOpen = false
    notifyWatchers(false)
  }
}

/** Подписка на события. onEvent можно передавать инлайн — он живёт в ref. */
export function useAdminSSE(onEvent: Handler): { connected: boolean } {
  const [connected, setConnected] = useState(() => isOpen) // соединение могло быть уже открыто
  const cbRef = useRef(onEvent)
  useEffect(() => {
    cbRef.current = onEvent
  })

  useEffect(() => {
    const handler: Handler = (e) => cbRef.current(e)
    listeners.add(handler)
    connectionWatchers.add(setConnected)
    acquire()
    return () => {
      listeners.delete(handler)
      connectionWatchers.delete(setConnected)
      release()
    }
  }, [])

  return { connected }
}
