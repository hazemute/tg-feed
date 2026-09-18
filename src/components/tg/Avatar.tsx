'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * Аватар канала/пользователя: фото (src) с автоматическим фолбэком на
 * цветной круг с инициалами (1–2 буквы, как в Telegram), если картинки нет
 * или она не загрузилась (404 у прокси, оффлайн и т.п.).
 */
export function Avatar({
  name,
  color,
  src,
  size = 40,
  className,
}: {
  name: string
  color?: string
  src?: string | null
  size?: number
  className?: string
}) {
  const [broken, setBroken] = useState(false)
  // Новая ссылка — сбрасываем флаг (картинка канала могла обновиться).
  // Сброс во время рендера — канонический паттерн React без лишнего эффекта
  const [prevSrc, setPrevSrc] = useState(src)
  if (prevSrc !== src) {
    setPrevSrc(src)
    setBroken(false)
  }

  if (src && !broken) {
    return (
      <img
        src={src}
        alt={name}
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setBroken(true)}
        className={cn('shrink-0 rounded-full object-cover', className)}
        style={{ width: size, height: size }}
      />
    )
  }
  const words = (name || 'T').trim().split(/\s+/)
  const initials =
    words.length >= 2
      ? (words[0].charAt(0) + words[1].charAt(0)).toUpperCase()
      : words[0].slice(0, 2).toUpperCase()
  return (
    <div
      aria-hidden
      className={cn(
        'flex shrink-0 select-none items-center justify-center rounded-full font-bold text-white',
        className,
      )}
      style={{
        width: size,
        height: size,
        backgroundColor: color || '#0a84ff',
        fontSize: Math.round(size * (initials.length >= 2 ? 0.34 : 0.42)),
        letterSpacing: initials.length >= 2 ? '0.02em' : undefined,
      }}
    >
      {initials}
    </div>
  )
}
