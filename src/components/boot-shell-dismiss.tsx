'use client'

import { useEffect } from 'react'

import { hideBootShell } from '@/lib/boot-shell'

/**
 * v5.86 — гасит boot-шторку (см. layout.tsx) на ЛЮБОМ смонтированном React-
 * дереве, а не только на главной странице.
 *
 * История бага: hideBootShell() вызывал только src/app/page.tsx, поэтому на
 * /admin, /pricing, /privacy, /terms, /contacts шторка висела ПОСЛЕ
 * гидрации бесконечно — пользователь видел вечный сплэш на рабочей странице
 * (скриншот владельца: /admin «легла»).
 *
 * Компонент ставится в корневой layout один раз и покрывает все текущие и
 * будущие маршруты: как только React смонтировался — шторка гаснет, вотчдоги
 * (8с «Медленное соединение…», 14с кнопка «Перезагрузить») отменяются.
 */
export function BootShellDismiss(): null {
  useEffect(() => {
    hideBootShell()
  }, [])
  return null
}
