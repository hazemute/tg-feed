'use client'

import { useState } from 'react'
import { AlertCircle, ArrowLeft, Bell, CornerDownRight, Heart, LifeBuoy, Megaphone, MessageCircle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { useApp } from '@/lib/store'
import { haptic, useBackButton } from '@/lib/tg'
import { pluralRu, timeAgo } from '@/lib/format'
import { useT } from '@/lib/i18n'
import type { NotificationDTO, NotificationGroupDTO, NotificationsResponse } from '@/lib/types'
import { Avatar } from '@/components/tg/Avatar'

/**
 * Экран «Уведомления» с двумя вкладками:
 *  • «Посты» — новые посты каналов с включённым колокольчиком (вычисляется
 *    по окну lastSeenNotifiedAt, группируется по каналам);
 *  • «Активность» — инбокс событий пользователя (таблица Notification):
 *    комментарии под постами привязанного канала, ответы поддержки,
 *    статусы рекламных кампаний.
 *
 * Оверлей по образцу ChannelSheet (spring-подъём, role=dialog, BackButton TG).
 * Рендерится из FeedView через createPortal в body; данные (data/failed)
 * приносит FeedView: GET выполняется ДО POST seen, иначе окно «нового»
 * обнуляется под ногами (гонка).
 */

/** Иконка и цвет события активности */
function activityIcon(type: NotificationDTO['type']): { Icon: LucideIcon; cls: string } {
  switch (type) {
    case 'comment':
      return { Icon: MessageCircle, cls: 'bg-tg-link/12 text-tg-link' }
    case 'reply':
      return { Icon: CornerDownRight, cls: 'bg-violet-500/12 text-violet-600' }
    case 'comment_like':
      return { Icon: Heart, cls: 'bg-rose-500/12 text-rose-500' }
    case 'support':
      return { Icon: LifeBuoy, cls: 'bg-emerald-500/12 text-emerald-600' }
    case 'campaign':
      return { Icon: Megaphone, cls: 'bg-amber-500/15 text-amber-600' }
    default:
      return { Icon: Bell, cls: 'bg-tg-surface text-tg-hint' }
  }
}

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
  // ВАЖНО: AnimatePresence живёт ВНУТРИ портала — портал сам по себе не является
  // валидным элементом для трекинга presence (isValidElement(portal) === false).
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
  const t = useT()
  const [tab, setTab] = useTabState(data)

  const groups = data?.groups ?? []
  const activity = data?.activity ?? []
  const loading = data === null && !failed
  const postsEmpty = !loading && !failed && groups.length === 0
  const activityEmpty = !loading && !failed && activity.length === 0

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
        <span className="flex-1 text-[17px] font-semibold text-tg-text">{t('notif.title')}</span>
      </header>

      {/* Вкладки: Посты (колокольчики) / Активность (инбокс событий) */}
      <div className="shrink-0 border-b border-tg-sep/60 bg-tg-bg px-3 pt-1" role="tablist" aria-label={t('notif.title')}>
        <div className="flex">
          <TabButton
            active={tab === 'posts'}
            onClick={() => setTab('posts')}
            label={t('notif.posts')}
            badge={data?.count ?? 0}
          />
          <TabButton
            active={tab === 'activity'}
            onClick={() => setTab('activity')}
            label={t('notif.activity')}
            badge={data?.unreadActivity ?? 0}
          />
        </div>
      </div>

      {/* Контент */}
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {loading && <NotificationsSkeleton />}

        {failed && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-tg-surface">
              <AlertCircle className="h-7 w-7 text-tg-hint" aria-hidden />
            </span>
            <p className="text-[15px] font-semibold text-tg-text">{t('notif.failed')}</p>
            <p className="text-snippet text-tg-hint">{t('notif.failedHint')}</p>
            <button
              type="button"
              onClick={onRetry}
              className="mt-1 h-10 rounded-full bg-tg-surface px-5 text-[14px] font-semibold text-tg-link active:scale-95"
            >
              {t('notif.retry')}
            </button>
          </div>
        )}

        {!failed && !loading && tab === 'posts' && (
          <>
            {postsEmpty && (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
                <span className="flex h-16 w-16 items-center justify-center rounded-full bg-tg-surface">
                  <Bell className="h-12 w-12 text-tg-hint" aria-hidden />
                </span>
                <p className="text-[15px] font-semibold text-tg-text">{t('notif.emptyPosts')}</p>
                <p className="text-snippet text-tg-hint">{t('notif.emptyPostsHint')}</p>
              </div>
            )}
            {groups.length > 0 && <PostsGroups groups={groups} onClose={onClose} />}
          </>
        )}

        {!failed && !loading && tab === 'activity' && (
          <>
            {activityEmpty && (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
                <span className="flex h-16 w-16 items-center justify-center rounded-full bg-tg-surface">
                  <Megaphone className="h-12 w-12 text-tg-hint" aria-hidden />
                </span>
                <p className="text-[15px] font-semibold text-tg-text">{t('notif.emptyActivity')}</p>
                <p className="text-snippet text-tg-hint">{t('notif.emptyActivityHint')}</p>
              </div>
            )}
            {activity.length > 0 && <ActivityList items={activity} onAfterNavigate={onClose} />}
          </>
        )}
      </div>
    </>
  )
}

/**
 * Вкладка выбирается по содержимому: при первом приходе данных, если постов
 * нет, а активность есть — сразу открываем «Активность». Подстройка состояния
 * под пропсы — во время рендера (паттерн React «derived state», без рефов).
 */
function useTabState(data: NotificationsResponse | null) {
  const [state, setState] = useState<{ tab: 'posts' | 'activity'; seen: boolean }>({
    tab: 'posts',
    seen: false,
  })
  if (data !== null && !state.seen) {
    const tab: 'posts' | 'activity' =
      (data.count ?? 0) === 0 && (data.activity?.length ?? 0) > 0 ? 'activity' : 'posts'
    setState({ tab, seen: true })
  }
  const setTab = (tab: 'posts' | 'activity') => setState({ tab, seen: true })
  return [state.tab, setTab] as const
}

function TabButton({
  active,
  onClick,
  label,
  badge,
}: {
  active: boolean
  onClick: () => void
  label: string
  badge: number
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => {
        haptic('light')
        onClick()
      }}
      className={cn(
        'relative flex-1 pb-2.5 pt-1.5 text-[15px] font-semibold transition',
        active ? 'text-tg-link' : 'text-tg-hint active:opacity-70',
      )}
    >
      <span className="inline-flex items-center gap-1.5">
        {label}
        {badge > 0 && (
          <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-tg-link px-1 text-[11px] font-bold leading-none text-white tabular-nums">
            {badge > 9 ? '9+' : badge}
          </span>
        )}
      </span>
      {active && (
        <motion.span
          layoutId="notif-tab-underline"
          className="absolute inset-x-3 bottom-0 h-[3px] rounded-full bg-tg-link"
          transition={{ type: 'spring', stiffness: 500, damping: 35 }}
        />
      )}
    </button>
  )
}

/* ---------- Вкладка «Посты»: группы новых постов по каналам ---------- */

function PostsGroups({ groups, onClose }: { groups: NotificationGroupDTO[]; onClose: () => void }) {
  const openChannel = useApp((s) => s.openChannel)

  const onOpenGroup = (username: string) => {
    haptic('light')
    onClose()
    openChannel(username)
  }

  return (
    <div className="divide-y divide-tg-sep/50" role="list" aria-label="Каналы с новыми постами">
      {groups.map((g) => (
        <PostGroupRow key={g.username} group={g} onOpen={onOpenGroup} />
      ))}
    </div>
  )
}

function PostGroupRow({ group, onOpen }: { group: NotificationGroupDTO; onOpen: (username: string) => void }) {
  const t = useT()
  const lang = useApp((s) => s.lang)
  const countLabel =
    lang === 'ru'
      ? `${group.count} ${pluralRu(group.count, 'новый пост', 'новых поста', 'новых постов')}`
      : `${group.count} ${group.count === 1 ? 'new post' : 'new posts'}`

  return (
    <button
      type="button"
      role="listitem"
      onClick={() => onOpen(group.username)}
      aria-label={`Открыть канал ${group.title}: ${countLabel}`}
      className="flex w-full items-center gap-3 px-4 py-3 text-left transition active:bg-tg-surface/50"
    >
      <div className="shrink-0">
        {/* Аватар как в ленте */}
        <Avatar name={group.title} color={group.avatarColor} src={group.avatarUrl} size={52} />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[16px] font-bold leading-tight text-tg-text">{group.title}</span>
          {/* Время новейшего поста группы (relative) */}
          <span className="shrink-0 text-[12.5px] leading-none text-tg-hint">
            {timeAgo(group.posts[0].publishedAt, lang)}
          </span>
        </div>
        <div className="mt-0.5 text-[13.5px] font-medium leading-tight text-tg-link">{countLabel}</div>
        {/* Превью последнего поста — одна строка с многоточием */}
        <p className={cn('mt-0.5 truncate text-[14px] leading-tight text-tg-hint')}>
          {group.posts[0].textPreview || (group.posts[0].mediaUrl ? t('notif.media') : t('notif.newPost'))}
        </p>
      </div>
    </button>
  )
}

/* ---------- Вкладка «Активность»: инбокс событий ---------- */

function ActivityList({
  items,
  onAfterNavigate,
}: {
  items: NotificationDTO[]
  onAfterNavigate: () => void
}) {
  return (
    <div className="divide-y divide-tg-sep/50" role="list" aria-label="Активность">
      {items.map((n) => (
        <ActivityRow key={n.id} item={n} onAfterNavigate={onAfterNavigate} />
      ))}
    </div>
  )
}

function ActivityRow({ item, onAfterNavigate }: { item: NotificationDTO; onAfterNavigate: () => void }) {
  const t = useT()
  const lang = useApp((s) => s.lang)
  const openChannel = useApp((s) => s.openChannel)
  const openCommentsById = useApp((s) => s.openCommentsById)
  const goToTab = useApp((s) => s.goToTab)

  const onClick = () => {
    haptic('light')
    switch (item.type) {
      case 'comment':
      case 'reply':
      case 'comment_like':
        // Комментарий/ответ/лайк под постом → комментарии на ЭТОМ комментарии:
        // ветка раскроется, экран доскроллится и строка подсветится (v5.21)
        if (item.postId) {
          onAfterNavigate()
          openCommentsById(item.postId, 0, item.commentId ?? null)
        } else if (item.channelUsername) {
          onAfterNavigate()
          openChannel(item.channelUsername)
        }
        break
      case 'support':
        // Поддержка живёт во вкладке профиля — переходим и открываем чат
        onAfterNavigate()
        goToTab('profile')
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent('tgfeed:open-support'))
        }, 380)
        break
      case 'campaign':
        onAfterNavigate()
        goToTab('mychannel')
        break
      case 'system':
        // Системные события (бейдж, подписка): показываем профиль
        onAfterNavigate()
        goToTab('profile')
        break
      default:
        // Любое прочее уведомление со ссылкой на пост тоже ведёт к посту
        if (item.postId) {
          onAfterNavigate()
          openCommentsById(item.postId, 0, item.commentId ?? null)
        } else if (item.channelUsername) {
          onAfterNavigate()
          openChannel(item.channelUsername)
        }
        break
    }
  }

  const { Icon, cls } = activityIcon(item.type)

  return (
    <button
      type="button"
      role="listitem"
      onClick={onClick}
      className="flex w-full items-start gap-3 px-4 py-3 text-left transition active:bg-tg-surface/50"
    >
      <span className={cn('mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full', cls)}>
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              'truncate text-[15.5px] leading-tight text-tg-text',
              item.read ? 'font-semibold' : 'font-bold',
            )}
          >
            {item.title}
          </span>
          <span className="shrink-0 text-[12.5px] leading-none text-tg-hint">
            {timeAgo(item.createdAt, lang)}
          </span>
        </span>
        {item.body && (
          <span className="mt-0.5 line-clamp-2 block text-[14px] leading-snug text-tg-hint">{item.body}</span>
        )}
      </span>
      {/* Точка непрочитанного */}
      {!item.read && (
        <span className="mt-2.5 h-2.5 w-2.5 shrink-0 rounded-full bg-tg-link" aria-label={t('notif.unread')} />
      )}
    </button>
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
