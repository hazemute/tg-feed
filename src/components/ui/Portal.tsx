'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * ПОРТАЛ В document.body (v5.74) — починка бага «шапка навбара перекрывает чат
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
 * Монтирование после первого коммита: на сервере document.body недоступен,
 * а гидратация не должна расходиться (портал-контент не участвует в SSR-сравнении).
 */
export function Portal({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return null
  return createPortal(children, document.body)
}
