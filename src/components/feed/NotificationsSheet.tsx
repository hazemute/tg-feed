'use client'

import { AlertCircle, ArrowLeft, Bell } from 'lucide-react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { useApp } from '@/lib/store'
import { haptic, useBackButton } from '@/lib/tg'
import { pluralRu, timeAgoRu } from '@/lib/format'
import type { NotificationsResponse } from '@/lib/types'
import { Avatar } from '@/components/tg/Avatar'

/**
 * Экран «Уведомления»: новые посты каналов с включённым колокольчиком.
 * Оверлей по образцу ChannelSheet (spring-подъём, role=dialog, BackButton TG).
 *
 * Рендерится из FeedView через createPortal в body — fixed-позиционирование
 * не зависит от transform вкладок (motion.main анимирует x при переходах);
 * состояние открытия живёт в FeedView (page.tsx и store не трогаем).
 *
 * Данные (data/failed) приносит FeedView: GET выполняется ДО POST seen,
 * иначе окно «нового» обнуляется под ногами и шит показывает пустоту (гонка).
 */
export function NotificationsSheet({
  open,
  onClose,
  data,
  failed,
  onRetry,
}: {
  open: boolean
  onClose: () => void
  /** Ответ GET /api/notifications; null — идёт загрузка */
  data: NotificationsResponse | null
  /** Ошибка загрузки (показываем блок с повтором) */
  failed: boolean
  /** Повторить загрузку (кнопка в блоке ошибки) */
  onRetry: () => void
}) {
  // Нативная кнопка «назад» Telegram закрывает экран (как у ChannelSheet)
  useBackButton(open, onClose)

  // FeedView монтируется только на клиенте (после authReady+user) — document доступен.
  // ВАЖНО: AnimatePresence живёт ВНУТРИ портала — портальный объект сам по себе не является
  // валидным элементом для трекинга presence (isValidElement(portal) === false), при обёртке
  // портала в AnimatePresence шит просто не рендерится.
  if (typeof document === 'undefined') return null

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="notifications-sheet"
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%' }}
          transition={{ type: 'spring', damping: 32, stiffness: 330 }}
          className="fixed inset-0 z-[70] mx-auto flex w-full max-w-[430px] flex-col overflow-hidden bg-tg-bg lg:bottom-auto lg:top-[10vh] lg:h-[80vh] lg:max-w-[620px] lg:rounded-3xl lg:border lg:border-tg-sep lg:shadow-[0_24px_90px_rgba(0,0,0,0.30)]"
          role="dialog"
          aria-modal="true"
          aria-label="Уведомления"
          data-noswipe
        >
          <NotificationsScreen data={data} failed={failed} onRetry={onRetry} onClose={onClose} />
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

function NotificationsScreen({
  data,
  failed,
  onRetry,
  onClose,
}: {
  data: NotificationsResponse | null
  failed: boolean
  onRetry: () => void
  onClose: () => void
}) {
  const openChannel = useApp((s) => s.openChannel)

  const onOpenGroup = (username: string) => {
    haptic('light')
    onClose()
    openChannel(username)
  }

  const groups = data?.groups ?? []
  const loading = data === null && !failed
  const empty = !loading && !failed && groups.length === 0

  return (
    <>
      {/* Шапка экрана — по образцу ChannelSheet */}
      <header className="flex shrink-0 items-center gap-2 border-b border-tg-sep/60 bg-tg-bg px-2 py-2">
        <button
          type="button"
          onClick={onClose}
          aria-label="Назад"
          className="flex h-11 w-11 items-center justify-center rounded-full text-tg-text active:bg-tg-surface"
        >
          <ArrowLeft className="h-5.5 w-5.5" />
        </button>
        <span className="flex-1 text-[17px] font-semibold text-tg-text">Уведомления</span>
      </header>

      {/* Контент */}
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {loading && <NotificationsSkeleton />}

        {failed && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-tg-surface">
              <AlertCircle className="h-7 w-7 text-tg-hint" aria-hidden />
            </span>
            <p className="text-[15px] font-semibold text-tg-text">Не удалось загрузить</p>
            <p className="text-snippet text-tg-hint">Проверьте соединение и попробуйте ещё раз</p>
            <button
              type="button"
              onClick={onRetry}
              className="mt-1 h-10 rounded-full bg-tg-surface px-5 text-[14px] font-semibold text-tg-link active:scale-95"
            >
              Повторить
            </button>
          </div>
        )}

        {empty && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-tg-surface">
              <Bell className="h-12 w-12 text-tg-hint" aria-hidden />
            </span>
            <p className="text-[15px] font-semibold text-tg-text">Новых постов нет</p>
            <p className="text-snippet text-tg-hint">
              Включите колокольчик у каналов, чтобы не пропустить новое
            </p>
          </div>
        )}

        {groups.length > 0 && (
          <div className="divide-y divide-tg-sep/50" role="list" aria-label="Каналы с новыми постами">
            {groups.map((g) => (
              <button
                key={g.username}
                type="button"
                role="listitem"
                onClick={() => onOpenGroup(g.username)}
                aria-label={`Открыть канал ${g.title}: ${g.count} ${pluralRu(g.count, 'новый пост', 'новых поста', 'новых постов')}`}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition active:bg-tg-surface/50"
              >
                <div className="shrink-0">
                  {/* Аватар как в ленте */}
                  <Avatar name={g.title} color={g.avatarColor} src={g.avatarUrl} size={52} />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[16px] font-bold leading-tight text-tg-text">{g.title}</span>
                    {/* Время новейшего поста группы (relative, по-русски) */}
                    <span className="shrink-0 text-[12.5px] leading-none text-tg-hint">
                      {timeAgoRu(g.posts[0].publishedAt)}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[13.5px] font-medium leading-tight text-tg-link">
                    {g.count} {pluralRu(g.count, 'новый пост', 'новых поста', 'новых постов')}
                  </div>
                  {/* Превью последнего поста — одна строка с многоточием */}
                  <p className={cn('mt-0.5 truncate text-[14px] leading-tight text-tg-hint')}>
                    {g.posts[0].textPreview || (g.posts[0].mediaUrl ? 'Медиа' : 'Новый пост')}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

/* ---------- Скелетон списка ---------- */

function NotificationsSkeleton() {
  return (
    <div className="divide-y divide-tg-sep/50 px-4" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-3 py-3.5">
          <div className="tg-shimmer h-[52px] w-[52px] shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="tg-shimmer h-4 w-2/5 rounded-md" />
            <div className="tg-shimmer h-3 w-1/4 rounded-md" />
            <div className="tg-shimmer h-3 w-4/5 rounded-md" />
          </div>
        </div>
      ))}
    </div>
  )
}
