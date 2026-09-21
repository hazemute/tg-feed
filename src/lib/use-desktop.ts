'use client'

import { useEffect, useState } from 'react'

/**
 * Десктопный экран (lg+, ≥1024px)? На ПК текст постов не обрезается —
 * читаемость важнее компактности ленты (поручение: «на ПК не обрезать жёстко»).
 * SSR/первый кадр — false (мобильный рендер), расхождение безобидно:
 * на десктопе текст просто разжимается после гидрации.
 */
export function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const apply = () => setDesktop(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])
  return desktop
}
