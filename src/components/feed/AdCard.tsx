'use client'

import { useEffect, useRef } from 'react'
import { ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import type { AdDTO } from '@/lib/types'
import { api } from '@/lib/api'
import { haptic, openExternal, openTelegram } from '@/lib/tg'

/**
 * Рекламная карточка в ленте (каждый 10-й слот) — «спонсорский пост»:
 * картинка, заголовок, текст и явная CTA-кнопка. Рекламодателю важно,
 * чтобы блок вёл не «куда-то», а прямо в подписку: для t.me-ссылок кнопка
 * открывает канал в Telegram, где пользователь жмёт родную «Подписаться».
 *
 * Аналитика: показ засчитывается один раз, когда ≥60% карточки появилось
 * на экране (IntersectionObserver, без повторов при скролле туда-сюда);
 * клик — по нажатию CTA. Оба события — fire-and-forget в /api/ads/track.
 * Для CPA-кампаний клик тарифицируется с анти-накруткой (уникальный
 * пользователь в сутки) и списывает бюджет из эскроу кампании.
 */
export function AdCard({ ad }: { ad: AdDTO }) {
  const rootRef = useRef<HTMLElement>(null)
  const impressionSent = useRef(false)

  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[0]
        if (e.intersectionRatio >= 0.6 && !impressionSent.current) {
          impressionSent.current = true
          io.disconnect()
          api('/api/ads/track', {
            method: 'POST',
            body: JSON.stringify({ adId: ad.id, type: 'impression', kind: ad.kind ?? 'ad' }),
          }).catch(() => {})
        }
      },
      { threshold: [0, 0.6] },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [ad.id])

  const isTg = ad.link.includes('t.me')

  const onClick = () => {
    haptic('light')
    api('/api/ads/track', {
      method: 'POST',
      body: JSON.stringify({ adId: ad.id, type: 'click', kind: ad.kind ?? 'ad' }),
    }).catch(() => {})
    if (isTg) openTelegram(ad.link)
    else {
      openExternal(ad.link)
      toast.success('Открываем сайт рекламодателя')
    }
  }

  return (
    <aside ref={rootRef} className="px-4 py-3" aria-label="Реклама">
      <div className="overflow-hidden rounded-2xl bg-tg-surface">
        {ad.imageUrl && (
          <img
            src={ad.imageUrl}
            alt={`Реклама: ${ad.title}`}
            className="h-36 w-full object-cover"
            loading="lazy"
          />
        )}
        <div className="p-4">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-tg-hint">
            Реклама
          </span>
          <div className="mt-1 text-[16.5px] font-bold leading-snug text-tg-text">{ad.title}</div>
          <p className="mt-1 text-snippet leading-snug text-tg-hint">{ad.body}</p>
          <button
            type="button"
            onClick={onClick}
            className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-tg-link text-[15px] font-semibold text-white transition active:scale-[0.98]"
          >
            {isTg ? (
              <svg viewBox="0 0 24 24" className="h-4.5 w-4.5 fill-white" aria-hidden>
                <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.161-1.86 8.766c-.14.62-.51.772-1.032.48l-2.85-2.1-1.376 1.324c-.152.152-.28.28-.574.28l.204-2.9 5.286-4.774c.23-.204-.05-.318-.354-.114l-6.534 4.112-2.814-.88c-.612-.192-.624-.612.128-.906l11.004-4.244c.51-.192.956.114.772.956z" />
              </svg>
            ) : (
              <ExternalLink className="h-4.5 w-4.5" aria-hidden />
            )}
            {ad.ctaLabel || (isTg ? 'Подписаться' : 'Перейти')}
          </button>
        </div>
      </div>
    </aside>
  )
}
