'use client'

/** Гостевой deviceId (в демо-режиме без Telegram initData) */
export function getDeviceId(): string {
  if (typeof window === 'undefined') return ''
  let id = localStorage.getItem('tgfeed_device_id')
  if (!id) {
    id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `d${Date.now()}${Math.random().toString(36).slice(2)}`
    localStorage.setItem('tgfeed_device_id', id)
  }
  return id
}
