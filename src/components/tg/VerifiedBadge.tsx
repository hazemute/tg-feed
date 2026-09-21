import { cn } from '@/lib/utils'

/**
 * Синяя галочка верификации — ровный круг с чёткой белой галочкой по центру
 * (жалоба владельца: прежний BadgeCheck с зубчатыми краями выглядел кривым).
 * Ставится вручную в админке (Channel.verified) — отличает официальные
 * каналы от клонов. Вся геометрия от центральной оси viewBox (24×24):
 * галочка симметрична (x 6.5..17.5, визуальный центр y≈12).
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
      className={cn('inline-block shrink-0 leading-none', className)}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 24 24" className="size-full" aria-hidden focusable="false">
        <circle cx="12" cy="12" r="11" className="fill-tg-link" />
        <path
          d="M6.8 12.5l3.4 3.4L17.2 8.6"
          fill="none"
          stroke="#fff"
          strokeWidth="2.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}
