'use client'

/**
 * Публичный профиль другого человека (v5.27) — глобальный шит.
 *
 * Открывается тапом по автору комментария (аватар/имя): zustand-состояние
 * profileUserId, данные — GET /api/user/[uid] (без сессии). Гости и баны
 * отдают 404 → «Профиль недоступен» (неотличимо от несуществующего).
 *
 * Контент: обложка (ProfileHeaderCover по style из ответа), имя, бейджи,
 * @username, чипы Premium/PLUS/PRO, «В Tg Swipe с …» и два стата
 * (комментарии / лайки, полученные на комментариях).
 */

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { userAvatarUrl } from '@/lib/tg'
import type { PublicProfileResponse } from '@/lib/types'
import { BottomSheet } from '@/components/tg/BottomSheet'
import { UserBadges } from '@/components/badges/UserBadges'
import { ProfileHeaderCover, ProfileTierChips } from '@/components/profile/ProfileHeaderCover'

export function UserProfileSheet() {
  const profileUserId = useApp((s) => s.profileUserId)
  const closeUserProfile = useApp((s) => s.closeUserProfile)
  // Состояние загрузки хранится ВМЕСТЕ с uid профиля: по несоответствию uid
  // понятно, что данные для открытого профиля ещё едут (скелетон) — и не
  // нужен синхронный сброс setState в эффекте (react-hooks/set-state-in-effect)
  const [state, setState] = useState<{
    uid: string | null
    data: PublicProfileResponse | null
    failed: boolean
  }>({ uid: null, data: null, failed: false })
  const [reloadKey, setReloadKey] = useState(0)

  const open = !!profileUserId
  const fresh = state.uid !== null && state.uid === profileUserId

  // Загрузка при открытии/смене профиля и по кнопке «Повторить»
  useEffect(() => {
    if (!profileUserId) return
    const ac = new AbortController()
    const uid = profileUserId
    api<PublicProfileResponse>(`/api/user/${encodeURIComponent(uid)}`, { signal: ac.signal })
      .then((d) => setState({ uid, data: d, failed: false }))
      .catch((e: unknown) => {
        if ((e as Error)?.name !== 'AbortError') setState({ uid, data: null, failed: true })
      })
    return () => ac.abort()
  }, [profileUserId, reloadKey])

  // «В Tg Swipe с {месяц год}» — формат по ТЗ (Intl ru-RU, месяц + год)
  const memberSince = state.data?.memberSince
    ? new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' }).format(new Date(state.data.memberSince))
    : null

  return (
    <BottomSheet open={open} onClose={closeUserProfile} zClass="z-[85]" wide title="Профиль">
      {open && !fresh && <Skeletons />}

      {open && fresh && state.failed && (
        <div className="rounded-2xl bg-tg-surface p-4 text-center">
          <p className="text-[14.5px] text-tg-hint">Профиль недоступен</p>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="mt-3 h-11 w-full rounded-xl bg-tg-link text-[15px] font-semibold text-white transition active:scale-[0.98]"
          >
            Повторить
          </button>
        </div>
      )}

      {open && fresh && !state.failed && state.data && (
        <div className="pb-1">
          {/* Обложка с оформлением владельца (анимации — по его тиру) */}
          <ProfileHeaderCover
            paletteId={state.data.style?.palette}
            bgId={state.data.style?.bg}
            frameId={state.data.style?.frame}
            avatarName={state.data.name}
            avatarSrc={userAvatarUrl(state.data.id, state.data.photoUrl)}
            avatarSize={76}
            tier={state.data.tier}
            isPremium={state.data.isPremium}
            className="h-24 sm:h-28"
          />

          {/* Ава торчит из обложки на size/2 (38px) → отступ под неё */}
          <div className="flex flex-col items-center px-4 pt-12 text-center">
            <div className="flex max-w-full items-center justify-center gap-1.5">
              <span className="truncate text-[18px] font-bold leading-tight text-tg-text">{state.data.name}</span>
              <ProfileTierChips tier={state.data.tier} isPremium={state.data.isPremium} />
            </div>
            {state.data.badges && state.data.badges.length > 0 && (
              <div className="mt-1.5 flex justify-center">
                <UserBadges badges={state.data.badges} max={5} />
              </div>
            )}
            {state.data.username && (
              <div className="mt-0.5 text-[14px] text-tg-hint">@{state.data.username}</div>
            )}
            {memberSince && (
              <div className="mt-1 text-[12.5px] font-medium text-tg-link">В Tg Swipe с {memberSince}</div>
            )}
          </div>

          {/* Статы: комментарии и полученные лайки, разделитель между блоками */}
          <div className="mt-4 flex items-stretch px-4" aria-label="Статистика">
            <div className="flex-1 rounded-2xl bg-tg-surface px-4 py-3 text-center">
              <div className="text-[18px] font-bold leading-none tabular-nums text-tg-text">
                {state.data.stats.comments}
              </div>
              <div className="mt-1.5 text-[12px] text-tg-hint">Комментарии</div>
            </div>
            <div className="mx-1.5 w-px shrink-0 bg-tg-sep" aria-hidden />
            <div className="flex-1 rounded-2xl bg-tg-surface px-4 py-3 text-center">
              <div className="text-[18px] font-bold leading-none tabular-nums text-tg-text">
                {state.data.stats.likesReceived}
              </div>
              <div className="mt-1.5 text-[12px] text-tg-hint">Лайки</div>
            </div>
          </div>
        </div>
      )}
    </BottomSheet>
  )
}

/** Скелетон на время загрузки: обложка + строки имени и статов */
function Skeletons() {
  return (
    <div className="space-y-4 px-1 py-2" aria-hidden>
      <div className="tg-shimmer h-24 rounded-2xl" />
      <div className="flex flex-col items-center gap-2 pt-4">
        <div className="tg-shimmer h-4 w-40 rounded" />
        <div className="tg-shimmer h-3 w-24 rounded" />
      </div>
      <div className="flex gap-3 pt-2">
        <div className="tg-shimmer h-16 flex-1 rounded-2xl" />
        <div className="tg-shimmer h-16 flex-1 rounded-2xl" />
      </div>
    </div>
  )
}
