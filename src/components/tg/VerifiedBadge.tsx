import { BadgeCheck, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Синяя галочка верификации — как в Telegram: зубчатый синий шильдик с белой
 * галочкой. Ставится вручную в админке (Channel.verified) — отличает
 * официальные каналы от клонов (interfax_news 1.1K против настоящего).
 */
export function VerifiedBadge({
  size = 15,
  className,
}: {
  size?: number
  className?: string
}) {
  return (
    <span
      role="img"
      aria-label="Официальный канал"
      title="Официальный канал"
      className={cn('relative inline-block shrink-0 leading-none', className)}
      style={{ width: size, height: size }}
    >
      <BadgeCheck className="size-full fill-tg-link text-tg-link" strokeWidth={0} aria-hidden />
      <Check
        className="absolute inset-0 size-full text-white"
        strokeWidth={3.4}
        aria-hidden
      />
    </span>
  )
}
