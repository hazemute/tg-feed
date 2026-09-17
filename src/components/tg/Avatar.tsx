import { cn } from '@/lib/utils'

/** Аватар канала: цветной круг с инициалами (1–2 буквы, как в Telegram) или фото */
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
  if (src) {
    return (
       
      <img
        src={src}
        alt={name}
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
