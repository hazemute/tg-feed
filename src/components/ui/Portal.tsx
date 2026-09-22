'use client'

import { useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const emptySubscribe = () => () => {}

/**
 * ПОРТАЛ В document.body (v5.74) — починка бага «навбар перекрывает чат
 * поддержки» (скрин от 21:39): модалки, отрендеренные ВНУТРИ вкладки, застревали
 * в stacking context motion.main (framer-motion держит will-change: transform,
 * opacity → элемент создаёт свой контекст наложения). Внутри этого контекста
 * даже z-[90] красится РАНЬШЕ соседнего BottomNav (absolute z-40), потому что
 * сам motion.main не позиционирован и z-auto — контекст рисуется в DOM-порядке.
 *
 * Портал выносит поддерево в <body> — z-индексы модалок снова сравниваются
 * с навбаром напрямую. Используется всеми полноэкранными модалками, которые
 * монтируются из табов (SupportChat, SummarySheet, MediaLightbox, BottomSheet…).
 *
 * useSyncExternalStore: на сервере getServerSnapshot → false (портал не рендерится,
 * гидратация не расходится), на клиенте → true сразу после монтажа.
 */
export function Portal({ children }: { children: ReactNode }) {
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  )
  if (!mounted) return null
  return createPortal(children, document.body)
}
