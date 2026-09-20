'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * Аватар канала/пользователя: фото (src) с автоматическим фолбэком на
 * цветной круг с инициалами (1–2 буквы, как в Telegram), если картинки нет
 * или она не загрузилась (404 у прокси, оффлайн и т.п.).
 *
 * v5.60 — ОДИН ТИХИЙ РЕТРАЙ: edge мог закэшировать 404/обрыв ровно на момент
 * первого запроса (мобильные сети рвут коннекты), а <img> сам не повторяет.
 * Cache-buster (hbr) делает новый запрос мимо залипшего кэша — аватарка
 * возвращается вместо мгновенных инициалов.
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
  /** cache-buster ретрай: у нашей /api/* одна ошибка часто лечится новым запросом */
  const [retrySrc, setRetrySrc] = useState<string | null>(null)
  /** src, за который ретрай уже потрачен (один тихий ретрай на ссылку) */
  const [retriedFor, setRetriedFor] = useState<string | null>(null)
  const handleErr = () => {
    if (src && retriedFor !== src && (src.startsWith('/api/') || src.startsWith('/_next/'))) {
      setRetriedFor(src)
      setRetrySrc(`${src}${src.includes('?') ? '&' : '?'}hbr=${Date.now()}`)
      return
    }
    setBroken(true)
  }
  // Новая ссылка — сбрасываем флаг (картинка канала могла обновиться).
  // Сброс во время рендера — канонический паттерн React без лишнего эффекта
  const [prevSrc, setPrevSrc] = useState(src)
  if (prevSrc !== src) {
    setPrevSrc(src)
    setBroken(false)
    setRetrySrc(null)
    setRetriedFor(null)
  }

  const shown = retrySrc ?? src
  if (shown && !broken) {
    return (
      <img
        src={shown}
        alt={name}
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={handleErr}
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
