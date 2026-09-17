'use client'

import { useEffect } from 'react'
import { toast } from 'sonner'

/** Минимальные типы Telegram WebApp SDK */
export type TgWebApp = {
  ready: () => void
  expand: () => void
  initData: string
  colorScheme?: 'light' | 'dark'
  themeParams?: {
    bg_color?: string
    text_color?: string
    hint_color?: string
    link_color?: string
    button_color?: string
    secondary_bg_color?: string
    header_bg_color?: string
    accent_text_color?: string
  }
  initDataUnsafe?: {
    user?: {
      id: number
      username?: string
      first_name?: string
      last_name?: string
      photo_url?: string
      is_premium?: boolean
      language_code?: string
    }
  }
  openTelegramLink: (url: string) => void
  openLink: (url: string, options?: { try_instant_view?: boolean }) => void
  setHeaderColor?: (color: string) => void
  setBackgroundColor?: (color: string) => void
  setBottomBarColor?: (color: string) => void
  onEvent?: (event: string, cb: () => void) => void
  offEvent?: (event: string, cb: () => void) => void
  disableVerticalSwipes?: () => void
  enableClosingConfirmation?: () => void
  HapticFeedback?: {
    impactOccurred: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void
    notificationOccurred: (type: 'error' | 'success' | 'warning') => void
    selectionChanged?: () => void
  }
  BackButton?: {
    show: () => void
    hide: () => void
    onClick: (cb: () => void) => void
    offClick: (cb: () => void) => void
  }
}

export function tg(): TgWebApp | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { Telegram?: { WebApp?: TgWebApp } }
  return w.Telegram?.WebApp ?? null
}

/**
 * Синхронизировать themeParams Telegram → CSS-переменные --tg-theme-*.
 * Тема «Как в Telegram» (auto) в globals.css построена на этих переменных;
 * без этой синхронизации она всегда падает в светлое значение.
 * Вызывается при инициализации и на событие themeChanged.
 */
export function syncTelegramThemeVars(): void {
  const w = tg()
  const tp = w?.themeParams
  if (!w || !tp) return
  const root = document.documentElement.style
  const map: Array<[string, string | undefined]> = [
    ['--tg-theme-bg-color', tp.bg_color],
    ['--tg-theme-text-color', tp.text_color],
    ['--tg-theme-hint-color', tp.hint_color],
    ['--tg-theme-link-color', tp.link_color],
    ['--tg-theme-button-color', tp.button_color],
    ['--tg-theme-secondary-bg-color', tp.secondary_bg_color],
    ['--tg-theme-header-bg-color', tp.header_bg_color],
    ['--tg-theme-accent-text-color', tp.accent_text_color],
  ]
  for (const [name, value] of map) {
    if (value) root.setProperty(name, value)
  }
}

/**
 * Покрасить рамки миниаппы (шапка, фон, нижняя панель) в цвет темы приложения.
 * Hex-цвета поддерживаются в Bot API ≥ 7.10; на старых клиентах откатываемся
 * на семантический color_key (bg_color = «в цвет темы клиента»).
 */
export function applyTgFrame(hex: string): void {
  const w = tg()
  if (!w) return
  const paint = (fn: ((c: string) => void) | undefined) => {
    if (!fn) return
    try {
      fn(hex)
    } catch {
      try {
        fn('bg_color') // старые клиенты без hex-поддержки
      } catch {
        // noop
      }
    }
  }
  paint(w.setHeaderColor)
  paint(w.setBackgroundColor)
  paint(w.setBottomBarColor)
}

export function initTelegram(): TgWebApp | null {
  const w = tg()
  if (!w) return null
  try {
    w.ready()
    w.expand()
    // Вертикальные свайпы Telegram конфликтуют со свайпом вкладок ленты — отключаем
    try {
      w.disableVerticalSwipes?.()
    } catch {
      // старые клиенты — не критично
    }
    // CSS-переменные темы Telegram (для auto-темы). Цвет рамок ставит
    // page.tsx после применения активной темы приложения (applyTgFrame).
    syncTelegramThemeVars()
  } catch {
    // вне Telegram — игнорируем
  }
  return w
}

export function openTelegram(usernameOrUrl: string) {
  const url = usernameOrUrl.startsWith('http')
    ? usernameOrUrl
    : `https://t.me/${usernameOrUrl.replace(/^@/, '')}`
  const w = tg()
  if (w?.openTelegramLink) {
    w.openTelegramLink(url)
  } else {
    window.open(url, '_blank', 'noopener')
  }
}

export function openExternal(url: string) {
  const w = tg()
  if (w?.openLink) w.openLink(url)
  else window.open(url, '_blank', 'noopener')
}

/**
 * Нативная кнопка «назад» Telegram: пока open=true — показываем её и закрываем шит.
 * Вне Telegram — no-op (обратная совместимость с браузером).
 */
export function useBackButton(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return
    const bb = tg()?.BackButton
    if (!bb) return
    const handler = () => onClose()
    try {
      bb.show()
      bb.onClick(handler)
      return () => {
        try {
          bb.offClick(handler)
          bb.hide()
        } catch {
          // noop
        }
      }
    } catch {
      // noop
    }
  }, [open, onClose])
}

export function haptic(kind: 'light' | 'success' | 'warning' | 'error' | 'select' = 'light') {
  const h = tg()?.HapticFeedback
  if (!h) return
  try {
    if (kind === 'light') h.impactOccurred('light')
    else if (kind === 'success') h.notificationOccurred('success')
    else if (kind === 'warning') h.notificationOccurred('warning')
    else if (kind === 'select') h.selectionChanged?.()
    else h.notificationOccurred('error')
  } catch {
    // noop
  }
}

/**
 * Аватар текущего пользователя: прочный прокси-URL /api/avatar/<uid>
 * (tgfile:<file_id> из Bot API или временный CDN-URL в демо-режиме).
 * Возвращает null, если у пользователя нет фото — рисуем инициалы.
 */
export function userAvatarUrl(userId: string, photoUrl?: string | null): string | null {
  if (!photoUrl) return null
  if (photoUrl.startsWith('tgfile:')) return `/api/avatar/${userId}`
  return photoUrl
}

/** Репост поста: в Telegram — нативный шаринг, иначе navigator.share / буфер обмена */
export async function sharePost(link: string | null, title: string) {
  const url = link || 'https://t.me/tgfeed_app'
  const w = tg()
  try {
    if (w?.openTelegramLink) {
      w.openTelegramLink(
        `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(`Пост из канала «${title}» — смотрел в TG-Feed`)}`,
      )
      return
    }
    if (typeof navigator !== 'undefined' && navigator.share) {
      await navigator.share({ title: `TG-Feed · ${title}`, url })
      return
    }
    await navigator.clipboard.writeText(url)
    toast.success('Ссылка скопирована')
  } catch {
    // пользователь отменил шаринг
  }
}
