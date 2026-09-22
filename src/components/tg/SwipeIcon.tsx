'use client'

import { cn } from '@/lib/utils'

/**
 * «СВАЙПЫ» — фирменная иконка валюты (v5.58).
 *
 * Дизайн: стилизованная молния (⚡ энергия нейросетей) внутри дуги свайпа —
 * палец делает свайп, след которого закручивается вокруг искры. Отрисовка
 * через currentColor: иконка красится в цвет текста контекста (тг-линк,
 * тг-звезда, зелёный начисления и т.д.) и нативно встраивается в любую строку.
 *
 * Используется ВО ВСЕХ местах упоминания баланса: Кошелёк, Задания, кабинет
 * канала, тосты списаний.
 */
export function SwipeIcon({ className, size = 16 }: { className?: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={cn('inline-block shrink-0 align-[-2px]', className)}
      aria-hidden
      focusable="false"
    >
      {/* Дуга свайпа (след жеста) */}
      <path
        d="M4.5 13.5a7.5 7.5 0 1 1 3.6 6.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.45"
      />
      {/* Стрелка-кончик дуги свайпа */}
      <path
        d="M5.2 17.2 4.4 20.4 7.6 19.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.45"
      />
      {/* Молния — сама энергия свайпов */}
      <path
        d="M13.4 3.2 8.6 12.1c-.3.5.1 1.1.7 1.1h2.9l-1.4 6.9c-.1.7.8 1.1 1.2.5l4.8-8.9c.3-.5-.1-1.1-.7-1.1h-2.9l1.4-6.9c.1-.7-.8-1.1-1.2-.5Z"
        fill="currentColor"
      />
    </svg>
  )
}
