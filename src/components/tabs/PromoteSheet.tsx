'use client'

import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Crown, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useApp } from '@/lib/store'
import { haptic, openTelegram } from '@/lib/tg'
import type { AdminStatsDTO } from '@/lib/types'

const CREATOR = 'tgfeed_creator'

const SLOTS = [
  { id: '7d', title: 'Закреп · 7 дней', price: '990 ₽', note: 'до 3× охвата' },
  { id: '30d', title: 'Закреп · 30 дней', price: '2 990 ₽', note: 'выгоднее на 55%' },
]

/**
 * Premium-аукцион: выбор категории и слота, связь с создателем для активации.
 */
export function PromoteSheet({
  open,
  onClose,
  channels,
}: {
  open: boolean
  onClose: () => void
  channels: AdminStatsDTO[]
}) {
  const { categories } = useApp()
  const [channelId, setChannelId] = useState<string>('')
  const [slot, setSlot] = useState<string>('7d')
  const [category, setCategory] = useState<string>('')

  const activeChannelId = channelId || channels[0]?.channelId || ''
  const activeSlot = useMemo(() => SLOTS.find((s) => s.id === slot) ?? SLOTS[0], [slot])

  const contact = () => {
    haptic('success')
    openTelegram(CREATOR)
    onClose()
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[60] flex flex-col justify-end"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Продвижение канала"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 320 }}
            className="relative mx-auto w-full max-w-[520px] rounded-t-3xl bg-tg-bg p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-[0_-8px_40px_rgba(0,0,0,0.18)]"
          >
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-tg-sep" aria-hidden />

            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-tg-star/15">
                <Crown className="h-4.5 w-4.5 text-tg-star" />
              </span>
              <div>
                <div className="text-[16px] font-bold text-tg-text">Продвинуть в Топ</div>
                <div className="text-[12px] text-tg-hint">Premium-слот в общей ленте</div>
              </div>
            </div>

            <div className="mt-4 space-y-4">
              {/* Канал */}
              <div>
                <div className="mb-1.5 text-[12px] font-medium text-tg-hint">Канал</div>
                {channels.length === 0 ? (
                  <p className="text-snippet text-tg-hint">
                    Сначала добавьте канал и дождитесь модерации — затем вернитесь сюда.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {channels.map((c) => (
                      <Pill
                        key={c.channelId}
                        active={activeChannelId === c.channelId}
                        onClick={() => setChannelId(c.channelId)}
                      >
                        {c.title}
                      </Pill>
                    ))}
                  </div>
                )}
              </div>

              {/* Категория показа */}
              <div>
                <div className="mb-1.5 text-[12px] font-medium text-tg-hint">
                  Категория продвижения
                </div>
                <div className="flex flex-wrap gap-2">
                  {categories.slice(0, 6).map((c) => (
                    <Pill
                      key={c.slug}
                      active={category === c.slug}
                      onClick={() => setCategory(c.slug)}
                    >
                      {c.title}
                    </Pill>
                  ))}
                </div>
              </div>

              {/* Слот */}
              <div>
                <div className="mb-1.5 text-[12px] font-medium text-tg-hint">Слот</div>
                <div className="grid grid-cols-2 gap-2">
                  {SLOTS.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      aria-pressed={slot === s.id}
                      onClick={() => {
                        setSlot(s.id)
                        haptic('light')
                      }}
                      className={cn(
                        'rounded-xl border p-3 text-left transition',
                        slot === s.id
                          ? 'border-tg-star bg-tg-star/10'
                          : 'border-tg-sep bg-tg-surface',
                      )}
                    >
                      <div className="text-[13px] font-semibold whitespace-nowrap text-tg-text">
                        {s.title}
                      </div>
                      <div className="mt-1 flex items-baseline gap-1.5">
                        <span className="text-[17px] font-bold whitespace-nowrap text-tg-star">
                          {s.price}
                        </span>
                        <span className="text-[11px] text-tg-hint">{s.note}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="button"
                disabled={channels.length === 0}
                onClick={contact}
                className={cn(
                  'h-12 w-full rounded-xl text-[15px] font-bold transition active:scale-[0.98]',
                  channels.length === 0
                    ? 'cursor-not-allowed bg-tg-surface text-tg-hint'
                    : 'bg-tg-star text-white',
                )}
              >
                <span className="inline-flex items-center gap-2">
                  <Sparkles className="h-4 w-4" />
                  Связаться для активации
                </span>
              </button>
              <p className="text-center text-[11px] leading-snug text-tg-hint">
                {activeSlot.title} · оплата переводом (СБП) · активация вручную создателем @{CREATOR}
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => {
        onClick()
        haptic('light')
      }}
      className={cn(
        'rounded-full px-3.5 py-2 text-[13px] font-medium transition active:scale-95',
        active ? 'bg-tg-link text-white' : 'bg-tg-surface text-tg-text2',
      )}
    >
      {children}
    </button>
  )
}
