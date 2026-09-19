'use client'

/**
 * Кастомайзер оформления профиля (v5.27) — ПОЛНАЯ СТРАНИЦА (не шит):
 * вкладки «Палитры / Фон / Рамка», живое мини-превью шапки сверху.
 *
 * Сохранение optimistic: каждое применение сразу пишет style в zustand
 * (превью и шапка обновляются мгновенно), PUT /api/profile/customize уходит
 * fire-and-forget; при ошибке — тост, визуал НЕ откатываем (перезагрузка
 * вернёт серверную правду). Гость: локальный preview-only без запроса.
 *
 * Замки: анимированные фоны/рамки — только Plus/Pro (или Telegram Premium),
 * hasPlusAccess/isFrameUnlocked из каталога. Тап по закрытому — не
 * применяется, открывает шит тарифов (onOpenTiers) + тост.
 */

import { useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { ArrowLeft, Check, Lock, Send } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { haptic, useBackButton, userAvatarUrl } from '@/lib/tg'
import {
  BG_ANIM_CLASS,
  DEFAULT_PROFILE_STYLE,
  FRAME_ANIM_CLASS,
  PROFILE_BGS,
  PROFILE_FRAMES,
  PROFILE_PALETTES,
  getPalette,
  hasPlusAccess,
  isFrameUnlocked,
} from '@/lib/profile-style'
import { Avatar } from '@/components/tg/Avatar'
import { ProfileHeaderCover } from '@/components/profile/ProfileHeaderCover'

type CustomizerTab = 'palette' | 'bg' | 'frame'

type StyleState = { palette: string; bg: string; frame: string }

const TABS: { id: CustomizerTab; label: string }[] = [
  { id: 'palette', label: 'Палитры' },
  { id: 'bg', label: 'Фон' },
  { id: 'frame', label: 'Рамка' },
]

export function ProfileCustomizer({
  open,
  onClose,
  onOpenTiers,
}: {
  open: boolean
  onClose: () => void
  onOpenTiers: () => void
}) {
  const user = useApp((s) => s.user)
  const setUser = useApp((s) => s.setUser)
  const setLoginOpen = useApp((s) => s.setLoginOpen)
  const [tab, setTab] = useState<CustomizerTab>('palette')
  // Локальное состояние оформления: монтируется только при открытии —
  // инициализация свежими данными юзера каждый раз
  const [style, setStyle] = useState<StyleState>(
    user?.style ?? { palette: DEFAULT_PROFILE_STYLE.palette, bg: DEFAULT_PROFILE_STYLE.bg, frame: DEFAULT_PROFILE_STYLE.frame },
  )

  // Нативная кнопка «назад» Telegram закрывает кастомайзер
  useBackButton(open, onClose)

  if (!user) return null

  const plus = hasPlusAccess(user.tier, user.isPremium)
  const name = user.isGuest
    ? 'Читатель'
    : [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Пользователь'
  const avatarSrc = userAvatarUrl(user.id, user.photoUrl)

  /** Optimistic-применение: стор мгновенно, PUT — в фоне, без отката */
  const apply = (patch: Partial<StyleState>) => {
    const next: StyleState = { ...style, ...patch }
    setStyle(next)
    setUser({ ...user, style: next })
    if (!user.isGuest) {
      void api('/api/profile/customize', { method: 'PUT', body: JSON.stringify(next) }).catch(() => {
        toast.error('Не удалось сохранить оформление')
      })
    }
    haptic('light')
  }

  /** Тап по анимированному фону без Plus: не применяем, зовём шит тарифов */
  const tapLockedBg = () => {
    haptic('warning')
    onOpenTiers()
    toast('Анимированные фоны — в Tg Swipe Plus', { description: 'Открой плюс, чтобы включить' })
  }

  /** Тап по анимированной рамке без Plus — аналогично */
  const tapLockedFrame = () => {
    haptic('warning')
    onOpenTiers()
    toast('Анимированные рамки — в Tg Swipe Plus', { description: 'Открой плюс, чтобы включить' })
  }

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="Оформление профиля"
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
      className="fixed inset-0 z-[90] flex flex-col bg-background"
    >
      {/* Шапка страницы */}
      <header className="flex items-center gap-3 px-4 pb-1 pt-4">
        <button
          type="button"
          onClick={onClose}
          aria-label="Назад"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-tg-surface text-tg-text transition active:scale-90"
        >
          <ArrowLeft className="h-5 w-5" strokeWidth={1.8} />
        </button>
        <div className="min-w-0">
          <h1 className="truncate text-[18px] font-bold leading-tight text-tg-text">
            Оформление профиля
          </h1>
          <p className="text-[12.5px] text-tg-hint">Анимации — плюс</p>
        </div>
      </header>

      {/* Плашка гостя: оформление живёт только в локальном превью */}
      {user.isGuest && (
        <div className="mx-4 mt-2 rounded-2xl bg-tg-surface p-3.5 text-[13.5px] leading-snug text-tg-hint">
          Привяжи Telegram, чтобы сохранить оформление
          <button
            type="button"
            onClick={() => {
              haptic('light')
              setLoginOpen(true)
            }}
            className="mt-2 flex h-9 items-center gap-1.5 rounded-full bg-tg-link px-3.5 text-[13px] font-bold text-white transition active:scale-95"
          >
            <Send className="h-3.5 w-3.5" />
            Войти по Telegram
          </button>
        </div>
      )}

      {/* Мини-превью шапки: выбор применяется мгновенно (optimistic).
          Спейсер под выступающую половину авы (32px), чтобы ава не наезжала
          на плашку гостя/вкладки */}
      <div className="px-4 pt-3">
        <div className="mx-auto w-full max-w-2xl">
          <ProfileHeaderCover
            paletteId={style.palette}
            bgId={style.bg}
            frameId={style.frame}
            avatarName={name}
            avatarSrc={avatarSrc}
            avatarSize={64}
            tier={user.tier}
            isPremium={user.isPremium}
            className="h-20 sm:h-24"
            coverClassName="rounded-2xl"
          />
          <div className="h-9" aria-hidden />
        </div>
      </div>

      {/* Вкладки-сегменты */}
      <div className="flex justify-center gap-2 px-4 pb-3 pt-4" role="tablist" aria-label="Разделы оформления">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => {
              setTab(item.id)
              haptic('light')
            }}
            className={cn(
              'h-9 rounded-full px-4 text-[13.5px] font-semibold transition active:scale-95',
              tab === item.id ? 'bg-tg-link text-white' : 'bg-tg-surface text-tg-hint active:text-tg-text',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* Сетка карточек (панель скроллится) */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
        <div className="mx-auto grid max-w-2xl grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {tab === 'palette' &&
            PROFILE_PALETTES.map((p) => {
              const selected = style.palette === p.id
              return (
                <CardShell key={p.id} selected={selected} onClick={() => apply({ palette: p.id })} label={`Палитра ${p.name}`}>
                  <div className="relative aspect-[16/7] w-full overflow-hidden rounded-xl" style={{ background: p.css }}>
                    {selected && <CheckBadge />}
                  </div>
                  <CardName>{p.name}</CardName>
                </CardShell>
              )
            })}

          {tab === 'bg' &&
            PROFILE_BGS.map((b) => {
              const locked = b.animated && !plus
              const selected = style.bg === b.id
              const paletteCss = getPalette(style.palette)?.css
              return (
                <CardShell
                  key={b.id}
                  selected={selected}
                  onClick={() => (locked ? tapLockedBg() : apply({ bg: b.id }))}
                  label={`Фон ${b.name}`}
                >
                  <div className="relative aspect-[16/7] w-full overflow-hidden rounded-xl" style={{ background: paletteCss }}>
                    {/* Узор поверх текущей палитры; закрытый анимированный — статично */}
                    <div
                      aria-hidden
                      className={cn('absolute inset-0', b.animated && plus ? BG_ANIM_CLASS[b.id] : undefined)}
                      style={{ background: b.css }}
                    />
                    {locked && <Lock className="absolute right-1.5 top-1.5 h-4 w-4 text-white/85 drop-shadow" aria-label="Только для Plus" />}
                    {selected && <CheckBadge />}
                  </div>
                  <CardName>
                    {b.name}
                    {locked && <PlusBadge />}
                  </CardName>
                </CardShell>
              )
            })}

          {tab === 'frame' &&
            PROFILE_FRAMES.map((f) => {
              const locked = !isFrameUnlocked(f.id, user.tier, user.isPremium)
              const selected = style.frame === f.id
              return (
                <CardShell
                  key={f.id}
                  selected={selected}
                  onClick={() => (locked ? tapLockedFrame() : apply({ frame: f.id }))}
                  label={`Рамка ${f.name}`}
                >
                  <div className="relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-xl bg-tg-surface">
                    {/* Мини-ава в обёртке-рамке: те же p-[3px] + css + glow + класс анимации */}
                    <div
                      className={cn('rounded-full p-[3px]', !locked ? FRAME_ANIM_CLASS[f.id] : undefined)}
                      style={{ background: f.css, boxShadow: f.glow }}
                    >
                      <Avatar name="A" size={56} className="rounded-full" />
                    </div>
                    {locked && <Lock className="absolute right-1.5 top-1.5 h-4 w-4 text-tg-hint" aria-label="Только для Plus" />}
                    {selected && <CheckBadge />}
                  </div>
                  <CardName>
                    {f.name}
                    {locked && <PlusBadge />}
                  </CardName>
                </CardShell>
              )
            })}
        </div>
      </div>

      {/* Низ страницы: «Готово» — сохранение уже случилось (optimistic) */}
      <div className="px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        <button
          type="button"
          onClick={() => {
            haptic('light')
            onClose()
          }}
          className="mx-auto flex h-11 w-full max-w-2xl items-center justify-center rounded-full bg-tg-link text-[15px] font-bold text-white transition active:scale-[0.98]"
        >
          Готово
        </button>
      </div>
    </motion.div>
  )
}

/* ---------- Карточка выбора (общая для трёх вкладок) ---------- */

function CardShell({
  selected,
  onClick,
  label,
  children,
}: {
  selected: boolean
  onClick: () => void
  label: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-label={label}
      className={cn(
        'rounded-2xl p-1.5 text-left transition active:scale-[0.97]',
        selected ? 'ring-2 ring-tg-link' : 'ring-1 ring-tg-sep/60',
      )}
    >
      {children}
    </button>
  )
}

/** Галочка выбора: кружок справа-сверху карточки */
function CheckBadge() {
  return (
    <span className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-tg-link text-white shadow-sm">
      <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
    </span>
  )
}

/** Крошечный бейдж «PLUS» у закрытых карточек */
function PlusBadge() {
  return (
    <span className="ml-1 inline-flex shrink-0 items-center rounded bg-tg-star/15 px-1 py-px text-[10px] font-bold leading-none text-tg-star">
      PLUS
    </span>
  )
}

function CardName({ children }: { children: ReactNode }) {
  return (
    <span className="mt-1.5 flex min-w-0 items-center px-0.5 text-[12.5px] font-medium leading-tight text-tg-text">
      <span className="truncate">{children}</span>
    </span>
  )
}
