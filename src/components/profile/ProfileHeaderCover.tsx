'use client'

/**
 * Обложка профиля (v5.27): палитра-фон + узор поверх + аватар по центру,
 * наполовину выступающий из обложки вниз. Общий рендер для шапки вкладки
 * «Профиль» и публичного профиля (UserProfileSheet).
 *
 * Имя/статус внутри НЕ рендерятся — их кладёт вызывающий (children — для
 * оверлеев на обложке, например кнопок в углах; имя — соседним блоком под
 * обложкой с отступом size/2, т.к. аватар выступает вниз).
 *
 * Контракт каталога — src/lib/profile-style.ts: css — значение CSS-шортката
 * `background`; узор — отдельный absolute-слой поверх палитры; рамка —
 * обёртка аватара p-[3px] rounded-full (css + glow); анимационные классы
 * BG_ANIM_CLASS / FRAME_ANIM_CLASS вешаются только при доступе Plus/Pro
 * (у free анимированный узор/рамка рендерятся статично, без класса).
 */

import type { ReactNode } from 'react'
import { Star, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/tg/Avatar'
import {
  BG_ANIM_CLASS,
  DEFAULT_PROFILE_STYLE,
  FRAME_ANIM_CLASS,
  getBg,
  getFrame,
  getPalette,
  hasPlusAccess,
  isFrameUnlocked,
} from '@/lib/profile-style'

export function ProfileHeaderCover({
  paletteId,
  bgId,
  frameId,
  avatarName,
  avatarSrc,
  avatarSize = 88,
  tier,
  isPremium,
  className,
  coverClassName,
  children,
}: {
  paletteId?: string | null
  bgId?: string | null
  frameId?: string | null
  avatarName: string
  avatarSrc?: string | null
  /** Размер аватара, px (вызывающий должен учесть выступ size/2 под обложкой) */
  avatarSize?: number
  /** Тир/премиум владельца профиля — от них зависят замки на анимациях */
  tier?: string | null
  isPremium?: boolean
  /** Классы внешнего контейнера: высота обложки (по умолчанию h-28 sm:h-32) */
  className?: string
  /** Классы фонового блока обложки (например, скругление углов) */
  coverClassName?: string
  /** Оверлеи на обложке (кнопки в углах) — позиционирует вызывающий */
  children?: ReactNode
}) {
  // Неизвестный/пустой id → дефолт из каталога (кримзон-референс владельца)
  const palette = getPalette(paletteId) ?? getPalette(DEFAULT_PROFILE_STYLE.palette)
  const bg = getBg(bgId) ?? getBg(DEFAULT_PROFILE_STYLE.bg)
  const frame = getFrame(frameId) ?? getFrame(DEFAULT_PROFILE_STYLE.frame)
  const plus = hasPlusAccess(tier, isPremium)
  // Анимированный узор: класс только если узор анимированный И есть доступ
  const bgAnimClass = bg?.animated && plus ? BG_ANIM_CLASS[bg.id] : undefined
  // Рамка: анимационный класс — только для открытой пользователю рамки
  const frameAnimClass =
    frame && isFrameUnlocked(frame.id, tier, isPremium) ? FRAME_ANIM_CLASS[frame.id] : undefined

  return (
    <div className={cn('relative h-28 sm:h-32', className)}>
      {/* Фон-палитра + узор. overflow-hidden — внутри (лучи prof-bg-rays
          вращаются с запасом масштаба и не должны вылезать за обложку),
          контейнер аватара клиппинг не проходит. */}
      <div
        aria-hidden
        className={cn('absolute inset-0 overflow-hidden rounded-b-2xl', coverClassName)}
        style={{ background: palette?.css }}
      >
        <div className={cn('absolute inset-0', bgAnimClass)} style={{ background: bg?.css ?? 'none' }} />
      </div>
      {/* Оверлеи вызывающего (кнопки в углах) */}
      {children}
      {/* Аватар по центру: наполовину выступает из обложки вниз (рамка-обёртка) */}
      <div className="absolute bottom-0 left-1/2 z-10 -translate-x-1/2 translate-y-1/2">
        <div
          className={cn('rounded-full p-[3px]', frameAnimClass)}
          style={{ background: frame?.css ?? 'transparent', boxShadow: frame?.glow }}
        >
          <Avatar name={avatarName} src={avatarSrc} size={avatarSize} className="rounded-full" />
        </div>
      </div>
    </div>
  )
}

/** Чипы Premium / PLUS / PRO рядом с именем (шапка профиля и публичный профиль) */
export function ProfileTierChips({
  tier,
  isPremium,
  className,
}: {
  tier?: string | null
  isPremium?: boolean
  className?: string
}) {
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1', className)}>
      {isPremium === true && (
        <span
          className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-tg-star/15 px-2 py-0.5 text-[11px] font-bold text-tg-star"
          title="Telegram Premium"
        >
          <Star className="h-3 w-3 fill-current" /> Premium
        </span>
      )}
      {(tier === 'plus' || tier === 'pro') && (
        <span
          className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-tg-star/15 px-2 py-0.5 text-[11px] font-bold text-tg-star"
          title={tier === 'plus' ? 'Snap Plus' : 'Snap Pro'}
        >
          <Zap className="h-3 w-3 fill-current" />
          {tier === 'plus' ? 'PLUS' : 'PRO'}
        </span>
      )}
    </span>
  )
}
