'use client'

/**
 * LeaderboardSheet (v5.87) — таблицы лидербордов, НЕ рублёвые (решение владельца):
 *   Уровни (XP) и Свайпы — за всё время; Просмотры / Лайки / Комментарии — за 30 дней.
 *
 * Устройство: чипсы разделов → карточка «моё место» (или CTA входа для гостей) →
 * подиум топ-3 → таблица строк 4+. Глобальная часть кэшируется на сервере (60с),
 * на клиенте — SWR-кэш по табам: переключение мгновенное, сеть тихо догоняет.
 * Раздел (`tab`) принадлежит ProfileTab — открытие из строки шита уровня задаёт его извне.
 *
 * v5.89:
 *  - чипсы разделов переехали в слот `toolbar` BottomSheet (ВНЕ зоны прокрутки):
 *    раньше они были position:sticky внутри скролла и на Android WebView контент
 *    «призрачно» проступал над/под панелью, разрывая подиум (баг «верхней менюшки»);
 *    заодно кнопка обновления больше не срезается краем экрана;
 *  - активный чип автодокручивается в видимую зону (5 табов не влезают в 360px);
 *  - клик по игроку (подиум/строки/живой топ недели) открывает его публичный профиль.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Eye, Heart, MessageCircle, RefreshCw, Send, Star, Trophy, Zap } from 'lucide-react'
import { api } from '@/lib/api'
import { useT, type I18nKey, type Lang } from '@/lib/i18n'
import { useApp } from '@/lib/store'
import { formatCount } from '@/lib/format'
import { haptic, userAvatarUrl } from '@/lib/tg'
import { cn } from '@/lib/utils'
import type { LbEntry, LbPrizes, LbTab, LeaderboardResponse, UserDTO } from '@/lib/types'
import { Avatar } from '@/components/tg/Avatar'
import { BottomSheet } from '@/components/tg/BottomSheet'

/** Разделы: иконка + ключ i18n (порядок = порядок чипсов) */
const TAB_META: { tab: LbTab; key: I18nKey; Icon: typeof Trophy }[] = [
  { tab: 'level', key: 'lb.tabLevel', Icon: Trophy },
  { tab: 'swipes', key: 'lb.tabSwipes', Icon: Zap },
  { tab: 'views', key: 'lb.tabViews', Icon: Eye },
  { tab: 'likes', key: 'lb.tabLikes', Icon: Heart },
  { tab: 'comments', key: 'lb.tabComments', Icon: MessageCircle },
]

/** Подпись значения справа: «уровень/свайпов/…» (типизированные ключи словаря) */
const VALUE_LABEL: Record<LbTab, I18nKey> = {
  level: 'lb.levelValue',
  swipes: 'lb.swipesValue',
  views: 'lb.viewsValue',
  likes: 'lb.likesValue',
  comments: 'lb.commentsValue',
}

/** Русские формы единиц (1 свайп / 2 свайпа / 5 свайпов); en — статичный ключ словаря */
const RU_FORMS: Partial<Record<LbTab, [string, string, string]>> = {
  swipes: ['свайп', 'свайпа', 'свайпов'],
  views: ['просмотр', 'просмотра', 'просмотров'],
  likes: ['лайк', 'лайка', 'лайков'],
  comments: ['комментарий', 'комментария', 'комментариев'],
}

function ruPlural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100
  const b = a % 10
  if (a > 10 && a < 20) return forms[2]
  if (b > 1 && b < 5) return forms[1]
  if (b === 1) return forms[0]
  return forms[2]
}

/** Подпись значения под числом: для level — всегда XP, иначе формы множественного числа */
function unitLabel(tab: LbTab, value: number, lang: Lang, t: (k: I18nKey) => string): string {
  if (tab === 'level') return 'XP'
  const forms = RU_FORMS[tab]
  if (lang === 'ru' && forms) return ruPlural(value, forms)
  return t(VALUE_LABEL[tab])
}

/** SWR-кэш модуля: вкладка профиля размонтируется — без кэша каждый вход мигал бы скелетонами */
type CacheRec = { data: LeaderboardResponse; at: number }
const lbCache = new Map<LbTab, CacheRec>()

const fetchLb = (tab: LbTab, signal?: AbortSignal) =>
  api<LeaderboardResponse>(`/api/leaderboard?tab=${tab}`, { signal })

export function LeaderboardSheet({
  open,
  onClose,
  tab,
  onTabChange,
  onLogin,
}: {
  open: boolean
  onClose: () => void
  /** Активный раздел (состояние живёт в ProfileTab — им управляет и шит уровня) */
  tab: LbTab
  onTabChange: (tab: LbTab) => void
  /** Открыть вход по Telegram (гостю); модалка живёт в ProfileTab */
  onLogin?: () => void
}) {
  const t = useT()
  const user = useApp((s) => s.user)
  /** v5.89: клик по игроку — публичный профиль (глобальный шит через zustand) */
  const openUserProfile = useApp((s) => s.openUserProfile)
  // Данные по каждому табу отдельно (показ прошлого раздела мгновенно + сеть догоняет)
  const [dataByTab, setDataByTab] = useState<Partial<Record<LbTab, LeaderboardResponse>>>(
    () => {
      const seed: Partial<Record<LbTab, LeaderboardResponse>> = {}
      for (const [k, v] of lbCache) seed[k] = v.data
      return seed
    },
  )
  const [failedTab, setFailedTab] = useState<LbTab | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  // Загрузка при открытии/смене раздела. setState — только в колбэках промиса
  // (правило react-hooks/set-state-in-effect).
  useEffect(() => {
    if (!open) return
    const ac = new AbortController()
    fetchLb(tab, ac.signal)
      .then((d) => {
        lbCache.set(tab, { data: d, at: Date.now() })
        setDataByTab((prev) => ({ ...prev, [tab]: d }))
        setFailedTab(null)
      })
      .catch((e: unknown) => {
        if ((e as Error)?.name !== 'AbortError') setFailedTab(tab)
      })
    return () => ac.abort()
  }, [open, tab, reloadKey])

  const refresh = useCallback(() => {
    haptic('light')
    setReloadKey((k) => k + 1)
  }, [])

  const data = dataByTab[tab] ?? null
  const top = data?.top ?? []
  const me = data?.me ?? null
  const loading = !data && failedTab !== tab

  // v5.89: держим активный чип в видимой зоне — 5 табов шире экрана телефона,
  // без автопрокрутки выбранный справа раздел остаётся срезанным краем
  const chipRefs = useRef<Partial<Record<LbTab, HTMLButtonElement | null>>>({})
  useEffect(() => {
    if (!open) return
    // небольшая задержка: на открытии шита layout ещё сходится (spring-анимация)
    const tm = setTimeout(() => {
      chipRefs.current[tab]?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
    }, 120)
    return () => clearTimeout(tm)
  }, [tab, open])

  return (
    <BottomSheet open={open} onClose={onClose} title={t('lb.title')} subtitle={t('lb.subtitle')} variant="full"
      toolbar={
        /* Разделы: чипсы + ручное обновление. Панель живёт ВНЕ скролла (слот
           toolbar BottomSheet) — всегда видна и не перекрывается контентом. */
        <div className="shrink-0 border-b border-tg-sep bg-tg-bg px-4 pb-2 pt-2" role="group" aria-label={t('lb.tabAria')}>
          <div className="flex items-center gap-2">
            {/* v5.89: скроллер чипов в relative-обёртке с правым фейдом —
                срезанный чип читается как «есть продолжение», а не как баг */}
            <div className="relative min-w-0 flex-1">
              <div className="no-scrollbar flex gap-2 overflow-x-auto">
                {TAB_META.map(({ tab: tb, key, Icon }) => (
                  <button
                    key={tb}
                    ref={(el) => {
                      chipRefs.current[tb] = el
                    }}
                    type="button"
                    aria-pressed={tab === tb}
                    onClick={() => onTabChange(tb)}
                    className={cn(
                      'flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13.5px] font-semibold transition active:scale-95',
                      tab === tb ? 'bg-tg-link text-white' : 'bg-tg-surface text-tg-text',
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                    {t(key)}
                  </button>
                ))}
              </div>
              <div
                aria-hidden
                className="pointer-events-none absolute inset-y-0 right-0 w-7 bg-gradient-to-l from-tg-bg to-transparent"
              />
            </div>
            <button
              type="button"
              onClick={refresh}
              aria-label={t('lb.refresh')}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-tg-surface text-tg-hint transition active:scale-90"
            >
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} aria-hidden />
            </button>
          </div>
          {/* Окно раздела: «за всё время» / «за 30 дней» */}
          <p className="mt-1.5 px-1 text-[12px] text-tg-hint" aria-live="polite">
            {tab === 'level' || tab === 'swipes' ? t('lb.windowAll') : t('lb.window30d')}
          </p>
        </div>
      }
    >
      <div className="space-y-4">
        {/* ---------- Моё место / CTA гостя ---------- */}
        {data?.guest ? (
          <div className="rounded-2xl bg-tg-surface p-4 text-center">
            <p className="text-[15px] font-semibold text-tg-text">{t('lb.guestTitle')}</p>
            <p className="mt-1 text-[13px] leading-snug text-tg-hint">{t('lb.guestHint')}</p>
            <button
              type="button"
              onClick={() => {
                haptic('light')
                onClose()
                onLogin?.()
              }}
              className="press mx-auto mt-3 flex h-10 items-center gap-1.5 rounded-full bg-tg-link px-4 text-[14px] font-bold text-white"
            >
              <Send className="h-4 w-4" />
              Вход по Telegram
            </button>
          </div>
        ) : data && me ? (
          <MeCard
            me={me}
            tab={tab}
            name={meName(user)}
            avatarSrc={userAvatarUrl(user?.id ?? '', user?.photoUrl)}
          />
        ) : null}

        {/* ---------- Состояния ---------- */}
        {failedTab === tab && (
          <button
            type="button"
            onClick={refresh}
            className="w-full rounded-2xl bg-tg-surface py-6 text-center text-[14px] font-medium text-tg-link"
          >
            {t('lb.failed')} · {t('lb.retry')}
          </button>
        )}

        {loading && <SkeletonList />}

        {data && failedTab !== tab && top.length === 0 && (
          <div className="rounded-2xl bg-tg-surface py-10 text-center">
            <Trophy className="mx-auto h-8 w-8 text-tg-hint" aria-hidden />
            <p className="mt-2 text-[14px] text-tg-hint">{t('lb.empty')}</p>
          </div>
        )}

        {/* ---------- Награды за активность (v5.88) — только «Уровни» ---------- */}
        {tab === 'level' && data?.prizes && (
          <PrizesCard prizes={data.prizes} onOpenUser={openUserProfile} />
        )}

        {/* ---------- Подиум (топ-3) ---------- */}
        {data && top.length > 0 && (
          <Podium
            first={top[0]}
            second={top[1] ?? null}
            third={top[2] ?? null}
            tab={tab}
            myRank={me?.rank ?? null}
            onOpenUser={openUserProfile}
          />
        )}

        {/* ---------- Таблица: строки 4+ ---------- */}
        {top.length > 3 && (
          <ul className="overflow-hidden rounded-2xl bg-tg-surface" aria-label={t('lb.title')}>
            {top.slice(3).map((e, i) => (
              <LbRow
                key={e.uid}
                entry={e}
                tab={tab}
                isMe={me?.rank === e.rank}
                withTopBorder={i > 0}
                onOpen={() => openUserProfile(e.uid)}
              />
            ))}
          </ul>
        )}
      </div>
    </BottomSheet>
  )
}

/* ---------- Мой результат ---------- */

function meName(user: UserDTO | null): string {
  if (!user) return 'Вы'
  const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
  return full || (user.username ? `@${user.username}` : 'Вы')
}

function MeCard({
  me,
  tab,
  name,
  avatarSrc,
}: {
  me: NonNullable<LeaderboardResponse['me']>
  tab: LbTab
  name: string
  avatarSrc: string | null
}) {
  const t = useT()
  const lang = useApp((s) => s.lang)
  const rankLabel =
    me.rank != null ? `#${me.rank}` : me.value > 0 ? t('lb.outOfTop') : t('lb.noActivity')
  // level: value — это XP (место считается по опыту); остальные — метрика как есть
  // (подпись единицы — с русскими формами множественного числа)
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-2xl border p-3.5',
        me.rank != null && me.rank <= 3
          ? 'border-amber-400/40 bg-amber-400/10'
          : 'border-tg-link/30 bg-tg-link/10',
      )}
      aria-label={t('lb.me')}
    >
      <Avatar name={name} src={avatarSrc} size={44} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[15px] font-bold text-tg-text">{t('lb.me')}</span>
          {me.level != null && (
            <span className="shrink-0 rounded-full bg-tg-link px-1.5 py-px text-[10.5px] font-bold leading-4 text-white">
              {t('level.short')} {me.level}
            </span>
          )}
        </div>
        <div className="truncate text-[12.5px] text-tg-hint">{name}</div>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-[17px] font-extrabold leading-tight text-tg-link tabular-nums">{rankLabel}</div>
        <div className="text-[12px] text-tg-hint tabular-nums">
          {formatCount(me.value)} {unitLabel(tab, me.value, lang, t)}
        </div>
      </div>
    </div>
  )
}

/* ---------- Награды за активность (v5.88) ---------- */

/** Топ недели/месяца по набранному XP получает свайпы (lib/lb-payouts.ts) */
const PRIZE_MEDALS = ['🥇', '🥈', '🥉']

function swipesWord(n: number, lang: Lang, t: (k: I18nKey) => string): string {
  if (lang === 'ru') return ruPlural(n, ['свайп', 'свайпа', 'свайпов'])
  return t('lb.swipesValue')
}

function PrizesCard({ prizes, onOpenUser }: { prizes: LbPrizes; onOpenUser: (uid: string) => void }) {
  const t = useT()
  const lang = useApp((s) => s.lang)
  const eachOf = (amount: number) =>
    `${t('lb.prizeEach')} ${formatCount(amount)} ${swipesWord(amount, lang, t)}`

  return (
    <div
      className="overflow-hidden rounded-2xl border border-amber-400/30 bg-amber-400/[0.06]"
      aria-label={t('lb.prizeTitle')}
    >
      <div className="flex items-center gap-1.5 px-4 pt-3">
        <Trophy className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />
        <span className="text-[14px] font-bold text-tg-text">{t('lb.prizeTitle')}</span>
      </div>
      <div className="mt-1 space-y-0.5 px-4 text-[12.5px] leading-snug text-tg-hint">
        <p className="tabular-nums">
          <span className="font-semibold text-tg-text">{t('lb.prizeWeek')}</span> — {eachOf(prizes.weeklyAmount)}
        </p>
        <p className="tabular-nums">
          <span className="font-semibold text-tg-text">{t('lb.prizeMonth')}</span> — {eachOf(prizes.monthlyAmount)}
        </p>
      </div>

      {/* Живой топ текущей недели (XP, набранный с понедельника) */}
      {prizes.liveWeek.length > 0 && (
        <div className="mt-2 border-t border-amber-400/20 px-2 pt-2">
          <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-tg-hint">
            {t('lb.prizeLiveWeek')}
          </p>
          <ul>
            {prizes.liveWeek.map((e, i) => (
              <li key={e.uid}>
                {/* v5.89: клик по участнику — публичный профиль */}
                <button
                  type="button"
                  onClick={() => {
                    haptic('light')
                    onOpenUser(e.uid)
                  }}
                  aria-label={`${e.name} — ${t('lb.prizeLiveWeek')}`}
                  className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition active:bg-tg-link/5"
                >
                  <span className="w-5 shrink-0 text-center text-[13px]" aria-hidden>
                    {PRIZE_MEDALS[i] ?? `#${e.rank}`}
                  </span>
                  <Avatar name={e.name} src={userAvatarUrl(e.uid, e.photoUrl)} size={28} />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-tg-text">{e.name}</span>
                  <span className="shrink-0 text-[12px] font-bold text-amber-500 tabular-nums">
                    +{formatCount(e.value)} XP
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Итоги последних выплат */}
      {(prizes.lastWeek.length > 0 || prizes.lastMonth.length > 0) && (
        <div className="space-y-0.5 border-t border-amber-400/20 px-4 py-2.5 text-[12px] leading-snug text-tg-hint">
          {prizes.lastWeek.length > 0 && (
            <p className="truncate">
              <span className="font-semibold">{t('lb.prizeLastWeek')}:</span>{' '}
              {prizes.lastWeek.map((r) => `${PRIZE_MEDALS[r.place - 1] ?? ''} ${r.name}`).join(' · ')}
            </p>
          )}
          {prizes.lastMonth.length > 0 && (
            <p className="truncate">
              <span className="font-semibold">{t('lb.prizeLastMonth')}:</span>{' '}
              {prizes.lastMonth.map((r) => `${PRIZE_MEDALS[r.place - 1] ?? ''} ${r.name}`).join(' · ')}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/* ---------- Подиум ---------- */

const PODIUM_STYLE: Record<1 | 2 | 3, { ring: string; medal: string; avatar: number }> = {
  1: { ring: 'ring-2 ring-amber-400', medal: '🥇', avatar: 64 },
  2: { ring: 'ring-2 ring-slate-300', medal: '🥈', avatar: 52 },
  3: { ring: 'ring-2 ring-amber-600/70', medal: '🥉', avatar: 52 },
}

function Podium({
  first,
  second,
  third,
  tab,
  myRank,
  onOpenUser,
}: {
  first: LbEntry
  second: LbEntry | null
  third: LbEntry | null
  tab: LbTab
  myRank: number | null
  onOpenUser: (uid: string) => void
}) {
  const t = useT()
  const lang = useApp((s) => s.lang)
  const cell = (e: LbEntry | null, order: 1 | 2 | 3) => {
    if (!e) return <div className="flex-1" aria-hidden />
    const st = PODIUM_STYLE[order]
    const isMe = myRank === e.rank
    return (
      // v5.89: вся ячейка — кнопка: тап по игроку открывает его профиль
      <button
        type="button"
        onClick={() => {
          haptic('light')
          onOpenUser(e.uid)
        }}
        aria-label={`${e.name} — ${t('user.openProfile')}`}
        className={cn(
          'flex min-w-0 flex-1 flex-col items-center rounded-2xl transition active:scale-95',
          order === 1 ? 'mt-0' : 'mt-4',
        )}
      >
        <div className="relative">
          <Avatar
            name={e.name}
            src={userAvatarUrl(e.uid, e.photoUrl)}
            size={st.avatar}
            className={cn('rounded-full', st.ring)}
          />
          <span className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 text-[16px] leading-none drop-shadow" aria-hidden>
            {st.medal}
          </span>
        </div>
        <div className={cn('mt-3 flex max-w-full items-center gap-1 px-1', order === 1 ? 'text-[13.5px]' : 'text-[12.5px]')}>
          <span className="truncate font-semibold text-tg-text">{e.name}</span>
          {e.premium && <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" aria-hidden />}
        </div>
        {/* level: «8 ур.» отдельно от «3200 XP» (иначе читается как одно число) */}
        <div className="mt-0.5 flex items-baseline gap-1 text-[12px] text-tg-hint tabular-nums">
          <span className="font-bold text-tg-text">
            {tab === 'level'
              ? `${formatCount(e.value)} ${t('level.short').toLowerCase()}`
              : formatCount(e.value)}
          </span>
          <span>
            {tab === 'level' && e.sub ? `· ${e.sub}` : unitLabel(tab, e.value, lang, t)}
          </span>
        </div>
        {isMe && (
          <span className="mt-1 rounded-full bg-tg-link px-2 py-px text-[10.5px] font-bold text-white">{t('lb.me')}</span>
        )}
      </button>
    )
  }
  return (
    <div className="flex items-start justify-center gap-2 rounded-2xl bg-tg-surface px-3 pb-4 pt-5" aria-label={`Топ-3 · ${t('lb.title')}`}>
      {cell(second, 2)}
      {cell(first, 1)}
      {cell(third, 3)}
    </div>
  )
}

/* ---------- Строка таблицы (4+) ---------- */

function LbRow({
  entry,
  tab,
  isMe,
  withTopBorder,
  onOpen,
}: {
  entry: LbEntry
  tab: LbTab
  isMe: boolean
  withTopBorder: boolean
  /** v5.89: тап по строке — публичный профиль игрока */
  onOpen: () => void
}) {
  const t = useT()
  const lang = useApp((s) => s.lang)
  const label = entry.sub ?? unitLabel(tab, entry.value, lang, t)
  return (
    <li className={cn(withTopBorder && 'border-t border-tg-sep', isMe && 'bg-tg-link/10')}>
      <button
        type="button"
        onClick={() => {
          haptic('light')
          onOpen()
        }}
        aria-label={`${entry.name} — ${t('user.openProfile')}`}
        className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition active:bg-tg-link/5"
      >
        <span
          className={cn(
            'w-6 shrink-0 text-center text-[13.5px] font-bold tabular-nums',
            entry.rank <= 10 ? 'text-tg-text' : 'text-tg-hint',
          )}
        >
          {entry.rank}
        </span>
        <Avatar name={entry.name} src={userAvatarUrl(entry.uid, entry.photoUrl)} size={38} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[14.5px] font-semibold text-tg-text">{entry.name}</span>
            {entry.premium && <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" aria-hidden />}
            {isMe && (
              <span className="shrink-0 rounded-full bg-tg-link px-1.5 py-px text-[10px] font-bold leading-4 text-white">
                {t('lb.me')}
              </span>
            )}
          </div>
          {entry.username && <div className="truncate text-[12px] text-tg-hint">@{entry.username}</div>}
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[15px] font-extrabold leading-tight text-tg-text tabular-nums">{formatCount(entry.value)}</div>
          <div className="text-[11px] text-tg-hint">{label}</div>
        </div>
      </button>
    </li>
  )
}

/* ---------- Скелетон ---------- */

function SkeletonList() {
  return (
    <div className="space-y-3" aria-hidden>
      <div className="tg-shimmer h-28 rounded-2xl" />
      <div className="tg-shimmer h-16 rounded-2xl" />
      <div className="space-y-2 rounded-2xl bg-tg-surface p-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="tg-shimmer h-9 rounded-lg" />
        ))}
      </div>
    </div>
  )
}
