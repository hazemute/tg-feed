'use client'

/**
 * Платформа запуска: Telegram Mini App или самостоятельный сайт.
 *
 * Определение должно происходить ДО гидрации — раскладка ПК (полная ширина)
 * управляется CSS-правилом html[data-platform='web'] (globals.css), которое
 * выставляет инлайн-скрипт из layout.tsx ещё до первого рендера React.
 * Никаких миганий «сужено → раскрылось» и warning'ов гидрации.
 */

export type Platform = 'telegram' | 'web'

/** Значение data-platform, проставленное инлайн-скриптом layout.tsx */
export function getPlatform(): Platform {
  if (typeof window === 'undefined') return 'telegram'
  const attr = document.documentElement.dataset.platform
  if (attr === 'web' || attr === 'telegram') return attr
  // Фолбэк (скрипт не отработал): initData есть только внутри Telegram
  const w = window as unknown as { Telegram?: { WebApp?: { initData?: string } } }
  return w.Telegram?.WebApp?.initData ? 'telegram' : 'web'
}

/** Приложение открыто внутри Telegram (Mini App) */
export function isInTelegram(): boolean {
  return getPlatform() === 'telegram'
}

/** Приложение открыто как самостоятельный сайт (по домену) */
export function isWebsite(): boolean {
  return getPlatform() === 'web'
}
