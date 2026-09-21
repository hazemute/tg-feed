'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle,
  ArrowUpRight,
  Bot,
  CalendarClock,
  Check,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  FileText,
  Link2,
  Loader2,
  Lock,
  Megaphone,
  MessageSquare,
  MousePointerClick,
  Pause,
  Pin,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Rocket,
  ScanSearch,
  Scissors,
  Send,
  Settings2,
  Sparkles,
  Trash2,
  Wallet,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { copyText } from '@/lib/clipboard'
import { toast } from 'sonner'
import { api, apiCached, invalidateApiCache } from '@/lib/api'
import { useApp } from '@/lib/store'
import { formatCount, pluralRu, timeAgoRu } from '@/lib/format'
import { stripMarkdown } from '@/lib/markdown'
import { formatSwipes, pluralSwipes } from '@/lib/money'
import { haptic, openTelegram } from '@/lib/tg'
import { useT } from '@/lib/i18n'
import { Avatar } from '@/components/tg/Avatar'
import { BottomSheet } from '@/components/tg/BottomSheet'
import { ChannelCabinet } from '@/components/feed/ChannelCabinet'
import { TopUpModal } from '@/components/tabs/TopUpModal'
import { AiChat } from '@/components/ai/AiChat'
import { SwipeIcon } from '@/components/tg/SwipeIcon'
import { ChannelLiveView } from '@/components/channel/ChannelLiveView'
import type { MyChannelDTO, MyChannelResponse, PostDTO } from '@/lib/types'

/**
 * «Канал» (v5.58) — РАБОЧИЙ СТОЛ АДМИНА: три главных элемента внутри одной
 * вкладки нижней навигации:
 *   1. Мой канал — управление: привязка, показ в ленте, CTA, продвижение, реклама.
 *   2. Статистика — большая аналитика именно СВОЕГО канала (как в админке).
 *   3. ИИ-ассистент — Snap Ассистент: генерация, публикация, УДАЛЕНИЕ постов,
 *      смена названия/описания/аватара — полный пульт управления каналом.
 * Переехал из профиля и старой вкладки «Мой канал» (приказ владельца).
 */

const DISPLAY_MODES = [
  { id: 'none', label: 'Полностью', icon: FileText, hint: 'посты видны целиком' },
  { id: 'cut', label: 'Обрезка', icon: Scissors, hint: 'начало текста + кнопка «Читать полностью в Telegram»' },
  { id: 'blur', label: 'Блюр', icon: EyeOff, hint: 'весь текст размыт до подписки' },
] as const

/**
 * Разделы рабочего стола (v5.65: + «Живой канал» — вид чата в стиле Telegram).
 * Активная — пилюлей с layoutId.
 */
const CHANNEL_SECTIONS = [
  { key: 'manage', label: 'Мой канал' },
  { key: 'live', label: 'Живой канал' },
  { key: 'stats', label: 'Статистика' },
  { key: 'ai', label: 'ИИ-ассистент' },
] as const

type ChannelSection = (typeof CHANNEL_SECTIONS)[number]['key']

export function ChannelTab() {
  const { user } = useApp()
  const [data, setData] = useState<MyChannelResponse | null>(null)
  const [loading, setLoading] = useState(true)
  // v5.54: сетевой сбой ≠ «канал не привязан» — отдельный экран повтора вместо
  // ввода @username (иначе у владельца канала сбои провоцировали повторный claim)
  const [failed, setFailed] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [section, setSection] = useState<ChannelSection>('manage')
  // v5.65: полноэкранный «живой канал» (вид чата) поверх вкладки
  const [liveOpen, setLiveOpen] = useState(false)
  const t = useT()

  const fetchChannel = useCallback(async (useCache: boolean) => {
    try {
      // Короткий клиентский кэш (15с) — возврат на вкладку не мигает скелетоном;
      // явные перезагрузки после действий кэш инвалидируют — цифры всегда свежие
      const r = useCache
        ? await apiCached<MyChannelResponse>('/api/mychannel', 15_000)
        : await api<MyChannelResponse>('/api/mychannel')
      setData(r)
      setFailed(false)
      setActiveId((prev) => prev ?? r.channels[0]?.id ?? null)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [])

  /** Первичное открытие вкладки: кэш допустим — без мигания скелетона */
  const load = useCallback(() => fetchChannel(true), [fetchChannel])
  /** Перезагрузка после действий (продвижение/настройки/пополнение): только сеть */
  const reload = useCallback(() => {
    invalidateApiCache('/api/mychannel')
    return fetchChannel(false)
  }, [fetchChannel])

  useEffect(() => {
    if (user) void load()
  }, [user, load])

  const channel = useMemo(
    () => data?.channels.find((c) => c.id === activeId) ?? data?.channels[0] ?? null,
    [data, activeId],
  )

  // Тариф и лимит продвижения приходят из GET /api/mychannel (E2E берёт их оттуда же)
  const tier = data?.tier ?? 'free'
  const promotion = data?.promotion ?? { used: 0, limit: 7, available: false }
  const hasChannel = Boolean(data && data.channels.length > 0)

  return (
    <div className="no-scrollbar h-full w-full overflow-y-auto overscroll-contain px-4 pb-28 pt-5 lg:px-6 lg:pt-7">
      {/* Центрированная колонка: кабинет не растягивается на весь широкий экран */}
      <div className="mx-auto w-full max-w-[960px]">
        {/* Заголовок */}
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="text-screen-title leading-tight text-tg-text">Канал</h1>
          <p className="mt-1 text-[15px] text-tg-hint">
            Пульт управления: статистика, показ в ленте и ИИ-ассистент — всё в одном месте
          </p>
        </motion.div>

        {loading ? (
          <div className="mt-6 space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-28 rounded-2xl tg-shimmer" />
            ))}
          </div>
        ) : failed && !data ? (
          <div className="mt-6 flex flex-col items-center gap-3 rounded-2xl bg-tg-surface px-4 py-10 text-center">
            <span className="flex size-16 items-center justify-center rounded-full bg-tg-like/10 text-tg-like" aria-hidden>
              <AlertTriangle className="size-8" strokeWidth={1.7} />
            </span>
            <p className="text-[15px] font-semibold text-tg-text">Не удалось загрузить кабинет</p>
            <p className="text-snippet text-tg-hint">Проверьте соединение и попробуйте ещё раз</p>
            <button
              type="button"
              onClick={() => {
                haptic('light')
                setFailed(false)
                setLoading(true)
                reload()
              }}
              className="press mt-1 flex items-center gap-1.5 rounded-full bg-tg-link px-4 py-2 text-[14px] font-semibold text-white"
            >
              <RefreshCw className="h-4 w-4" aria-hidden /> Повторить
            </button>
          </div>
        ) : !hasChannel ? (
          <ClaimCard onDone={reload} />
        ) : (
          <div className="mt-5 space-y-4">
            {/* Переключатель каналов (если привязано несколько) */}
            {data!.channels.length > 1 && (
              <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
                {data!.channels.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      haptic('light')
                      setActiveId(c.id)
                    }}
                    className={cn(
                      'flex shrink-0 items-center gap-2 rounded-full py-1.5 pl-1.5 pr-3.5 text-[13.5px] font-semibold transition',
                      c.id === channel?.id
                        ? 'bg-tg-link text-white'
                        : 'bg-tg-surface text-tg-text2 active:scale-95',
                    )}
                  >
                    <Avatar name={c.title} color={c.avatarColor} src={c.avatarUrl} size={26} />
                    {c.title}
                  </button>
                ))}
              </div>
            )}

            {/* ТРИ ГЛАВНЫХ РАЗДЕЛА: Мой канал · Статистика · ИИ-ассистент.
                Скроллящиеся пилюли — лёгкий вес, больше воздуха. */}
            {/* v5.65: сплошной фон вместо backdrop-blur — блюр на скролле
                перекрашивает слой каждый кадр и съедает кадры на мобильных */}
            <div className="sticky top-0 z-20 -mx-4 bg-tg-bg px-4 py-2.5 lg:-mx-6 lg:px-6">
              <div className="no-scrollbar flex gap-2 overflow-x-auto" role="tablist" aria-label={t('mc.tabsAria')}>
                {CHANNEL_SECTIONS.map((s) => {
                  const active = section === s.key
                  return (
                    <button
                      key={s.key}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => {
                        if (!active) {
                          haptic('light')
                          setSection(s.key)
                        }
                      }}
                      className={cn(
                        'relative flex h-10 shrink-0 items-center gap-1.5 rounded-full px-4 text-[14px] font-semibold transition active:scale-95',
                        active ? 'text-white' : 'bg-tg-surface text-tg-hint',
                      )}
                    >
                      {active && (
                        <motion.span
                          layoutId="channel-section-pill"
                          className="absolute inset-0 rounded-full bg-tg-link"
                          transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                          aria-hidden
                        />
                      )}
                      <span className="relative z-10">
                        {s.key === 'ai' && <Bot className="mr-1 inline h-4 w-4 -translate-y-px" aria-hidden />}
                        {s.label}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Контент раздела (key — чтобы анимация не переезжала между разделами) */}
            <motion.div
              key={section}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="pt-1"
            >
              {section === 'manage' && (
                <div className="space-y-5">
                  <ChannelHero key={`hero-${channel!.id}`} channel={channel!} onReload={reload} />
                  {/* key с префиксом: сброс состояния при смене канала, но ключи
                      СОСЕДЕЙ уникальны (раньше CtaSection и AiAssistantSection
                      делили один key={channel.id} — React-ошибка «two children
                      with the same key» при каждом открытии вкладки) */}
                  <DisplaySection key={`display-${channel!.id}`} channel={channel!} onSaved={load} />
                  <CtaSection key={`cta-${channel!.id}`} channel={channel!} tier={tier} />
                  <PromotionSection
                    key={`promo-${channel!.id}`}
                    channel={channel!}
                    tier={tier}
                    promotion={promotion}
                    onReload={reload}
                  />
                  <AdsSection key={`ads-${channel!.id}`} channel={channel!} onReload={reload} />
                </div>
              )}
              {section === 'live' && (
                <LiveSection key={`live-${channel!.id}`} channel={channel!} onOpen={() => setLiveOpen(true)} />
              )}
              {section === 'stats' && (
                /* Большой дашборд именно этого канала (просмотры, ER, динамика,
                    лучшее время, ритм, топ постов) — плоский, без карточек */
                <ChannelCabinet key={channel!.username} username={channel!.username} title={channel!.title} />
              )}
              {section === 'ai' && (
                <AssistantSection key={`ai-${channel!.id}`} channel={channel!} tier={tier} />
              )}
            </motion.div>
          </div>
        )}
      </div>

      {/* v5.65: полноэкранный «живой канал» — вид чата в стиле Telegram */}
      <AnimatePresence>
        {liveOpen && channel && (
          <ChannelLiveView channelId={channel.id} onClose={() => setLiveOpen(false)} />
        )}
      </AnimatePresence>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Живой канал (v5.65) — секция-лаунчер нативного чат-вида             */
/* ------------------------------------------------------------------ */

/** Мини-превью бабла для карточки-лаунчера (декоративное) */
function LivePreviewBubble({
  text,
  time,
  views,
  mine,
}: {
  text: string
  time: string
  views: string
  mine?: boolean
}) {
  return (
    <div className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[78%] rounded-2xl px-3 py-1.5 shadow-sm',
          mine ? 'rounded-br-md bg-tg-link text-white' : 'rounded-bl-md bg-tg-surface2 text-tg-text',
        )}
      >
        <p className="text-[12.5px] leading-snug">{text}</p>
        <p className={cn('mt-0.5 text-right text-[10px]', mine ? 'text-white/70' : 'text-tg-hint')}>
          {views} · {time}
        </p>
      </div>
    </div>
  )
}

/**
 * «Живой канал» — нативный вид чата своего канала, один в один механика
 * Telegram (баблы, просмотры, реакции, строка ввода со скрепкой, удаление
 * через контекстное меню), но стилизованный под дизайн-систему Tg Swipe.
 */
function LiveSection({ channel, onOpen }: { channel: MyChannelDTO; onOpen: () => void }) {
  const features = [
    { icon: Send, text: 'Публикуйте посты прямо отсюда — с картинками и видео' },
    { icon: Trash2, text: 'Удаляйте любой пост: тап или долгое нажатие → «Удалить»' },
    { icon: Settings2, text: 'Название, описание и аватар — классическое меню настроек' },
    { icon: Eye, text: 'Просмотры и реакции каждого поста — как в самом Telegram' },
  ]
  return (
    <div className="space-y-4">
      {/* Hero-карточка с превью чата */}
      <div className="overflow-hidden rounded-2xl bg-gradient-to-br from-tg-link/12 via-tg-link/5 to-transparent p-4">
        <div className="flex items-center gap-2.5">
          <Avatar name={channel.title} color={channel.avatarColor} src={channel.avatarUrl} size={44} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15.5px] font-bold text-tg-text">{channel.title}</p>
            <p className="text-[12.5px] text-tg-hint">
              t.me/{channel.username} · {formatCount(channel.subscribersCount)}{' '}
              {pluralRu(channel.subscribersCount, 'подписчик', 'подписчика', 'подписчиков')}
            </p>
          </div>
        </div>

        {/* Декоративный мини-чат */}
        <div className="mt-3.5 space-y-1.5 rounded-2xl bg-tg-bg/60 p-3">
          <LivePreviewBubble text="Новый выпуск уже сегодня 🔥" time="18:04" views="12,4K" />
          <LivePreviewBubble text="Ставь ❤️, если ждал" time="18:05" views="11,1K" />
          <LivePreviewBubble text="Отправить сообщение…" time="" views="" mine />
        </div>

        <button
          type="button"
          onClick={() => {
            haptic('light')
            onOpen()
          }}
          className="press mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-tg-link text-[15px] font-bold text-white shadow-lg shadow-tg-link/25"
        >
          <MessageSquare className="h-5 w-5" aria-hidden />
          Открыть живой канал
        </button>
      </div>

      {/* Возможности */}
      <div className="overflow-hidden rounded-2xl bg-tg-surface">
        {features.map((f, i) => (
          <div key={i}>
            {i > 0 && <div className="mx-3.5 h-px bg-tg-sep" />}
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-tg-link/12 text-tg-link">
                <f.icon className="h-[18px] w-[18px]" aria-hidden />
              </span>
              <p className="text-[13.5px] leading-snug text-tg-text">{f.text}</p>
            </div>
          </div>
        ))}
      </div>

      <p className="px-1 text-[12px] leading-snug text-tg-hint">
        Всё происходит через нашего бота в вашем канале: публикации, правки и удаления мгновенно
        появляются в Telegram. Бот должен быть администратором канала.
      </p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Привязка канала                                                     */
/* ------------------------------------------------------------------ */

function ClaimCard({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('')
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState<'input' | 'code'>('input')
  const [code, setCode] = useState('')
  const [title, setTitle] = useState('')
  const [copied, setCopied] = useState(false)

  const start = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username.trim() || busy) return
    setBusy(true)
    try {
      const r = await api<{ ok: boolean; code: string; title: string }>('/api/mychannel', {
        method: 'POST',
        body: JSON.stringify({ action: 'claimStart', username: username.trim() }),
      })
      setCode(r.code)
      setTitle(r.title)
      setStage('code')
      haptic('success')
    } catch (err) {
      toast.error((err as Error).message || 'Не удалось найти канал')
      haptic('error')
    } finally {
      setBusy(false)
    }
  }

  const verify = async () => {
    if (busy) return
    setBusy(true)
    try {
      await api('/api/mychannel', {
        method: 'POST',
        body: JSON.stringify({ action: 'claimVerify', username: username.trim(), code }),
      })
      haptic('success')
      onDone()
    } catch (err) {
      toast.error((err as Error).message || 'Код пока не найден в канале')
      haptic('error')
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    // фолбэк execCommand — iframe Telegram Web может запрещать clipboard-write
    if (await copyText(code)) {
      setCopied(true)
      haptic('light')
      setTimeout(() => setCopied(false), 1600)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="mt-6 overflow-hidden rounded-2xl border border-tg-sep/60 bg-tg-surface/50"
    >
      <div className="flex items-center gap-3 px-5 pt-5">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-tg-link/15">
          <Radio className="h-6 w-6 text-tg-link" />
        </span>
        <div>
          <div className="text-[17px] font-bold text-tg-text">Привяжите канал</div>
          <div className="text-[13px] text-tg-hint">Без модерации и ожидания — за 2 минуты</div>
        </div>
      </div>

      {stage === 'input' ? (
        <>
          <div className="mt-4 space-y-2.5 px-5">
            {[
              'Укажите @юзернейм публичного канала',
              'Опубликуйте код-слово постом в канале',
              'Подтвердите — статистика и реклама откроются',
            ].map((t, i) => (
              <div key={i} className="flex items-center gap-2.5 text-[13.5px] text-tg-text2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-tg-link/12 text-[11px] font-bold text-tg-link">
                  {i + 1}
                </span>
                {t}
              </div>
            ))}
          </div>
          <form onSubmit={start} className="mt-4 flex gap-2 px-5 pb-5">
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="@my_channel"
              aria-label="Юзернейм канала"
              autoComplete="off"
              className="h-12 min-w-0 flex-1 rounded-2xl border border-tg-sep bg-tg-bg px-4 text-[15px] text-tg-text outline-none placeholder:text-tg-hint focus:border-tg-link"
            />
            <button
              type="submit"
              disabled={busy || !username.trim()}
              className={cn(
                'flex h-12 shrink-0 items-center gap-1.5 rounded-2xl px-5 text-[14.5px] font-semibold transition active:scale-95',
                busy || !username.trim()
                  ? 'cursor-not-allowed bg-tg-surface text-tg-hint'
                  : 'bg-tg-link text-white',
              )}
            >
              {busy ? <Loader2 className="h-4.5 w-4.5 animate-spin" /> : <Link2 className="h-4.5 w-4.5" />}
              Привязать
            </button>
          </form>
        </>
      ) : (
        <>
          <div className="mt-4 px-5">
            <p className="text-[13.5px] leading-relaxed text-tg-text2">
              Опубликуйте этот код постом в канале{' '}
              <span className="font-semibold text-tg-text">{title}</span> — это подтверждает, что
              канал ваш:
            </p>
            <button
              type="button"
              onClick={copy}
              className="mt-3 flex w-full items-center justify-between gap-3 rounded-2xl border border-dashed border-tg-link/50 bg-tg-link/[0.06] px-4 py-3.5 text-left transition active:scale-[0.99]"
            >
              <span className="truncate font-mono text-[15px] font-bold tracking-wide text-tg-link">
                {code}
              </span>
              <span className="flex shrink-0 items-center gap-1 text-[12px] font-semibold text-tg-hint">
                {copied ? <Check className="h-4 w-4 text-tg-link" /> : <Copy className="h-4 w-4" />}
                {copied ? 'Скопировано' : 'Копировать'}
              </span>
            </button>
          </div>
          <div className="mt-4 flex gap-2 px-5 pb-5">
            <button
              type="button"
              onClick={verify}
              disabled={busy}
              className="flex h-12 flex-1 items-center justify-center gap-2 rounded-2xl bg-tg-link text-[14.5px] font-semibold text-white transition active:scale-[0.98]"
            >
              {busy ? <Loader2 className="h-4.5 w-4.5 animate-spin" /> : <Check className="h-4.5 w-4.5" />}
              Я опубликовал код
            </button>
            <button
              type="button"
              onClick={() => setStage('input')}
              className="h-12 rounded-2xl bg-tg-surface px-4 text-[14px] font-semibold text-tg-text2 active:scale-95"
            >
              Назад
            </button>
          </div>
        </>
      )}
    </motion.div>
  )
}

/* ------------------------------------------------------------------ */
/* Шапка канала                                                        */
/* ------------------------------------------------------------------ */

function ChannelHero({ channel, onReload }: { channel: MyChannelDTO; onReload: () => void | Promise<void> }) {
  const [syncing, setSyncing] = useState(false)
  // Спиннер живёт ровно столько, сколько реально идёт перезагрузка данных
  const sync = async () => {
    if (syncing) return
    setSyncing(true)
    try {
      await onReload()
    } finally {
      setSyncing(false)
    }
  }
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative overflow-hidden rounded-2xl border border-tg-sep/50"
    >
      <div className="relative p-5">
        <div className="flex items-center gap-3.5">
          <Avatar
            name={channel.title}
            color={channel.avatarColor}
            src={channel.avatarUrl}
            size={58}
            className="ring-2 ring-tg-link/30"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[17px] font-bold leading-tight text-tg-text">
                {channel.title}
              </span>
              <Check className="h-4 w-4 shrink-0 text-tg-link" aria-label="Владение подтверждено" />
            </div>
            <div className="mt-0.5 truncate text-[13px] text-tg-hint">
              @{channel.username} · {channel.categoryTitle}
            </div>
          </div>
        </div>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => openTelegram(`https://t.me/${channel.username}`)}
            className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-tg-link text-[13.5px] font-semibold text-white transition active:scale-[0.98]"
          >
            <Send className="h-4 w-4" />
            Открыть в Telegram
          </button>
          <button
            type="button"
            onClick={() => void sync()}
            aria-label="Обновить статистику"
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-tg-surface text-tg-text2 transition active:scale-95"
          >
            {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpRight className="h-4.5 w-4.5" />}
          </button>
        </div>
      </div>
    </motion.section>
  )
}

/* ------------------------------------------------------------------ */
/* Настройки показа в ленте                                            */
/* ------------------------------------------------------------------ */

function DisplaySection({ channel, onSaved }: { channel: MyChannelDTO; onSaved: () => void }) {
  const [mode, setMode] = useState(channel.teaserMode)
  const [limit, setLimit] = useState(channel.teaserLimit)
  const [busy, setBusy] = useState(false)
  const dirty = mode !== channel.teaserMode || limit !== channel.teaserLimit

  const save = async () => {
    if (busy || !dirty) return
    setBusy(true)
    try {
      await api('/api/mychannel', {
        method: 'POST',
        body: JSON.stringify({
          action: 'settings',
          channelId: channel.id,
          teaserMode: mode,
          teaserLimit: limit,
        }),
      })
      haptic('success')
      onSaved()
    } catch (err) {
      toast.error((err as Error).message || 'Не удалось сохранить')
      haptic('error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 }}>
      <SectionTitle icon={Eye}>Показ в ленте</SectionTitle>
      <div className="rounded-2xl border border-tg-sep/50 bg-tg-surface/70 p-4">
        <p className="text-[12.5px] leading-relaxed text-tg-hint">
          Управляйте тем, сколько поста видят неподписчики: полный текст, обрезка с призывом
          читать в канале или размытие.
        </p>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {DISPLAY_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                haptic('light')
                setMode(m.id)
              }}
              className={cn(
                'flex flex-col items-center gap-1.5 rounded-2xl border px-2 py-3 text-[12.5px] font-semibold transition active:scale-95',
                mode === m.id
                  ? 'border-tg-link bg-tg-link/10 text-tg-link'
                  : 'border-tg-sep/60 bg-tg-bg text-tg-text2',
              )}
            >
              <m.icon className="h-4.5 w-4.5" />
              {m.label}
            </button>
          ))}
        </div>

        {mode !== 'none' && (
          <div className="mt-4">
            <div className="flex items-center justify-between text-[12.5px] font-medium text-tg-text2">
              <span>Порог обрезки</span>
              <span className="tabular-nums text-tg-hint">{limit} симв.</span>
            </div>
            <input
              type="range"
              min={60}
              max={600}
              step={20}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="mt-2 w-full accent-[var(--tg-link, #0a84ff)]"
              aria-label="Порог обрезки текста"
            />
            {/* Живое превью */}
            <div className="mt-2 rounded-xl bg-tg-bg px-3 py-2.5">
              <div className="text-[12px] font-semibold uppercase tracking-wide text-tg-hint">Как увидят читатели</div>
              <div className={cn('mt-1 text-[13px] text-tg-text2', mode === 'blur' && 'blur-[5px] select-none')}>
                Тизер показывает первые {limit} символов поста и ведёт читателя в канал…
              </div>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className={cn(
            'mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-2xl text-[14px] font-semibold transition active:scale-[0.98]',
            dirty ? 'bg-tg-link text-white' : 'cursor-default bg-tg-sep/50 text-tg-hint',
          )}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          {dirty ? 'Сохранить настройки' : 'Сохранено'}
        </button>
      </div>
    </motion.section>
  )
}

/* ------------------------------------------------------------------ */
/* Snap Pro: общие блоки апгрейда                                      */
/* ------------------------------------------------------------------ */

/** 402 pro_required: api() кидает Error(data.error) — message ровно 'pro_required' */
function proRequired(err: unknown): boolean {
  return (err as Error)?.message === 'pro_required'
}

/**
 * Кнопки «Тарифы» из кабинета ведут прямо в шит тарифов на вкладке «Профиль»
 * (флаг в sessionStorage + событие — ProfileTab подхватывает и на монтировании,
 * и когда уже смонтирован).
 */
const TIERS_FLAG = 'tgfeed_open_tiers'
const TIERS_EVENT = 'tgfeed:open-tiers'
function useGoToTiers() {
  const setTab = useApp((s) => s.setTab)
  return () => {
    haptic('light')
    try {
      sessionStorage.setItem(TIERS_FLAG, '1')
    } catch {
      /* приватный режим — останется только событие */
    }
    window.dispatchEvent(new Event(TIERS_EVENT))
    setTab('profile')
  }
}

/** Заблокированная возможность (не-pro): замок + кнопка апгрейда */
function LockedCard({ title, text }: { title: string; text: string }) {
  const goTiers = useGoToTiers()
  return (
    <div className="rounded-2xl border border-tg-sep/50 bg-tg-surface/70 p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-tg-link/12">
          <Lock className="h-5 w-5 text-tg-link" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-bold text-tg-text">{title}</div>
          <p className="mt-0.5 text-[13px] leading-relaxed text-tg-hint">{text}</p>
        </div>
      </div>
      <button
        type="button"
        onClick={goTiers}
        className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-2xl bg-tg-link text-[14px] font-semibold text-white transition active:scale-[0.98]"
      >
        <Sparkles className="h-4 w-4" />
        Включить в Snap Pro
      </button>
    </div>
  )
}

/** Компактная апгрейд-подсказка (показывается после 402 pro_required) */
function UpgradeNote({ className }: { className?: string }) {
  const goTiers = useGoToTiers()
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 rounded-2xl border border-dashed border-tg-link/40 bg-tg-link/[0.06] px-3.5 py-2.5',
        className,
      )}
    >
      <span className="text-[12.5px] leading-snug text-tg-text2">Эта возможность входит в тариф Snap Pro</span>
      <button
        type="button"
        onClick={goTiers}
        className="shrink-0 rounded-full bg-tg-link px-3.5 py-1.5 text-[12px] font-bold text-white transition active:scale-95"
      >
        Тарифы
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* CTA-кнопка (Snap Pro)                                               */
/* ------------------------------------------------------------------ */

function CtaSection({ channel, tier }: { channel: MyChannelDTO; tier: 'free' | 'plus' | 'pro' }) {
  const pro = tier === 'pro'
  const [label, setLabel] = useState(channel.ctaLabel ?? '')
  const [url, setUrl] = useState(channel.ctaUrl ?? '')
  const [busy, setBusy] = useState(false)
  const [needPro, setNeedPro] = useState(false)
  // Очистка: пустой текст не отправляем (на сервере min 2) — кнопка просто неактивна
  const valid = label.trim().length >= 2 && /^https:\/\//i.test(url.trim())

  const save = async () => {
    if (busy || !valid) return
    setBusy(true)
    try {
      await api('/api/mychannel', {
        method: 'POST',
        body: JSON.stringify({
          action: 'cta',
          channelId: channel.id,
          ctaLabel: label.trim(),
          ctaUrl: url.trim(),
        }),
      })
      haptic('success')
      toast.success('CTA-кнопка сохранена')
    } catch (err) {
      if (proRequired(err)) {
        setNeedPro(true)
        toast.error('CTA-кнопка доступна на тарифе Snap Pro')
      } else {
        toast.error((err as Error).message || 'Не удалось сохранить')
      }
      haptic('error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 }}>
      <SectionTitle icon={MousePointerClick}>Кнопка действия (CTA)</SectionTitle>
      {pro ? (
        <div className="rounded-2xl border border-tg-sep/50 bg-tg-surface/70 p-4">
          <p className="text-[12.5px] leading-relaxed text-tg-hint">
            Появляется в конце раскрытых постов канала: ведите читателя на сайт, бота или в закреп.
          </p>
          <div className="mt-3 space-y-2.5">
            <Field label="Текст кнопки">
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value.slice(0, 30))}
                maxLength={30}
                placeholder="Подписаться"
                className={INPUT_CLS}
              />
            </Field>
            <Field label="Ссылка (https)">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                type="url"
                inputMode="url"
                placeholder="https://t.me/my_channel"
                className={INPUT_CLS}
              />
            </Field>
          </div>
          {/* Живое превью кнопки */}
          {label.trim().length >= 2 && (
            <div className="mt-3 rounded-xl bg-tg-bg px-3 py-3 text-center">
              <span className="inline-block rounded-full bg-tg-link px-4 py-1.5 text-[13px] font-semibold text-white">
                {label.trim()}
              </span>
            </div>
          )}
          <button
            type="button"
            onClick={save}
            disabled={busy || !valid}
            className={cn(
              'mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-2xl text-[14px] font-semibold transition active:scale-[0.98]',
              valid ? 'bg-tg-link text-white' : 'cursor-default bg-tg-sep/50 text-tg-hint',
            )}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Сохранить
          </button>
          {needPro && <UpgradeNote className="mt-3" />}
        </div>
      ) : (
        <LockedCard
          title="Кнопка действия (CTA)"
          text="Появляется в конце раскрытых постов канала — ведите читателя на сайт, бота или в закреп."
        />
      )}
    </motion.section>
  )
}

/* ------------------------------------------------------------------ */
/* ИИ-ассистент — ПОЛНЫЙ РАЗДЕЛ (v5.58)                                */
/* ------------------------------------------------------------------ */

/**
 * Раздел «ИИ-ассистент» внутри вкладки «Канал» (v5.58): Snap Ассистент
 * переехал сюда из профиля. Не просто генератор контента, а пульт
 * администрирования: пишет и публикует посты, удаляет посты, меняет
 * название/описание/аватар канала — по текстовым инструкциям админа.
 * Без Pro показываем возможности + апгрейд.
 */
const ASSISTANT_FEATURES = [
  { icon: ScanSearch, title: 'Живой аудит канала из Telegram', text: 'Реальные подписчики, просмотры и реакции через бота — оценка и план роста' },
  { icon: FileText, title: 'Пишет, публикует и откладывает', text: 'Пост в вашем стиле с обложкой — сейчас или по расписанию' },
  { icon: Pin, title: 'Правит и закрепляет посты', text: '«Исправь текст», «закрепи анонс» — и в Telegram, и в ленте' },
  { icon: Trash2, title: 'Удаляет посты', text: '«Удали пост про кофе» — покажет варианты, удалит после подтверждения' },
  { icon: Radio, title: 'Меняет канал', text: 'Название, описание, аватар, кнопка в постах — прямо в диалоге' },
  { icon: Link2, title: 'Пригласительные ссылки', text: 'С меткой, лимитом и сроком — для кампаний и закрытых каналов' },
  { icon: CalendarClock, title: 'Подсказывает время публикаций', text: 'Найдёт лучшие часы по реальным просмотрам аудитории' },
] as const

function AssistantSection({ channel, tier }: { channel: MyChannelDTO; tier: 'free' | 'plus' | 'pro' }) {
  const pro = tier === 'pro'
  const [chatOpen, setChatOpen] = useState(false)

  // Открытие чата при переходе в раздел (для pro): раздел и есть ассистент
  useEffect(() => {
    if (pro) {
      const t = window.setTimeout(() => setChatOpen(true), 0)
      return () => window.clearTimeout(t)
    }
  }, [pro])

  const open = () => {
    haptic('light')
    if (!pro) {
      goTiersFromAssistant()
      return
    }
    setChatOpen(true)
  }

  const goTiersFromAssistant = () => {
    try {
      sessionStorage.setItem(TIERS_FLAG, '1')
    } catch {
      /* приватный режим */
    }
    window.dispatchEvent(new Event(TIERS_EVENT))
    useApp.getState().setTab('profile')
  }

  return (
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} data-noswipe>
      <SectionTitle icon={Bot}>Snap Ассистент</SectionTitle>

      {/* Главная карточка ассистента */}
      <button
        type="button"
        onClick={open}
        aria-label="Открыть чат с Snap Ассистентом"
        className="group relative w-full overflow-hidden rounded-2xl border border-tg-link/30 bg-gradient-to-br from-tg-link/[0.14] via-tg-link/[0.06] to-transparent p-5 text-left transition active:scale-[0.99]"
      >
        <span
          className="flex h-14 w-14 items-center justify-center rounded-2xl bg-tg-link text-white shadow-lg shadow-tg-link/30"
          aria-hidden
        >
          <Bot className="h-7 w-7" />
        </span>
        <span className="mt-3 flex items-center gap-2">
          <span className="text-[18px] font-bold text-tg-text">Полный пульт канала</span>
          {!pro && <Sparkles className="h-4 w-4 shrink-0 text-tg-star" aria-hidden />}
        </span>
        <span className="mt-1 block text-[13.5px] leading-relaxed text-tg-hint">
          {pro
            ? 'Аудит из Telegram, посты по расписанию, правка/закрепление/удаление, ссылки и оформление — просто попросите'
            : 'Генерация, публикация и полное управление каналом через ИИ — на тарифе Snap Pro'}
        </span>
        <span className="mt-4 flex h-11 items-center justify-center gap-2 rounded-2xl bg-tg-link text-[14.5px] font-bold text-white transition active:scale-[0.98]">
          {pro ? <Send className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
          {pro ? 'Открыть чат с ассистентом' : 'Включить в Snap Pro'}
        </span>
      </button>

      {/* Возможности */}
      <div className="mt-4 space-y-2.5">
        {ASSISTANT_FEATURES.map((f, i) => (
          <motion.div
            key={f.title}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.06 + i * 0.05 }}
            className="flex items-start gap-3 rounded-2xl border border-tg-sep/50 bg-tg-surface/60 px-4 py-3.5"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-tg-link/12" aria-hidden>
              <f.icon className="h-4.5 w-4.5 text-tg-link" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14.5px] font-semibold leading-snug text-tg-text">{f.title}</span>
              <span className="mt-0.5 block text-[12.5px] leading-snug text-tg-hint">{f.text}</span>
            </span>
            {pro ? (
              <ChevronRight className="mt-1.5 h-4 w-4 shrink-0 text-tg-hint" aria-hidden />
            ) : (
              <Lock className="mt-1.5 h-4 w-4 shrink-0 text-tg-hint" aria-hidden />
            )}
          </motion.div>
        ))}
      </div>

      {pro && (
        <AiChat
          kind="assistant"
          open={chatOpen}
          onClose={() => setChatOpen(false)}
          channelId={channel.id}
          channelTitle={channel.title}
        />
      )}
    </motion.section>
  )
}

/* ------------------------------------------------------------------ */
/* Продвижение в ленте (Snap Pro, ≤7/нед)                              */
/* ------------------------------------------------------------------ */

function PromotionSection({
  channel,
  tier,
  promotion,
  onReload,
}: {
  channel: MyChannelDTO
  tier: 'free' | 'plus' | 'pro'
  promotion: MyChannelResponse['promotion']
  onReload: () => void
}) {
  const pro = tier === 'pro'
  const [posts, setPosts] = useState<PostDTO[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [needPro, setNeedPro] = useState(false)
  const limitReached = promotion.used >= promotion.limit

  // Последние 10 постов канала: публичный роут экрана канала (GET /api/channel?username=…&limit=10)
  useEffect(() => {
    if (!pro) return
    let alive = true
    api<{ items: PostDTO[] }>(`/api/channel?username=${encodeURIComponent(channel.username)}&limit=10`)
      .then((r) => {
        if (alive) setPosts(r.items)
      })
      .catch(() => {
        if (alive) setPosts([])
      })
    return () => {
      alive = false
    }
  }, [pro, channel.username])

  const promote = async (postId: string) => {
    if (busyId) return
    setBusyId(postId)
    try {
      const r = await api<{ ok: boolean; used: number; limit: number }>('/api/mychannel', {
        method: 'POST',
        body: JSON.stringify({ action: 'promote', channelId: channel.id, postId }),
      })
      haptic('success')
      toast.success(`Продвинуто (${r.used} из ${r.limit})`)
      onReload() // свежий promotion.used из GET /api/mychannel
    } catch (err) {
      const m = (err as Error).message || ''
      if (proRequired(err)) {
        setNeedPro(true)
        toast.error('Продвижение доступно на тарифе Snap Pro')
      } else if (/лимит/i.test(m)) {
        toast.error('Лимит недели исчерпан')
      } else {
        toast.error(m || 'Не удалось продвинуть')
      }
      haptic('error')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 }}>
      <SectionTitle icon={Rocket}>Продвижение в ленте</SectionTitle>
      {pro ? (
        <div className="rounded-2xl border border-tg-sep/50 bg-tg-surface/70 p-4">
          <p className="text-[12.5px] leading-relaxed text-tg-hint">
            Протолкните пост в первые ряды ленты — буст температуры на сутки.
          </p>

          {/* Недельный счётчик */}
          <div className="mt-3">
            <div className="flex items-center justify-between text-[12.5px] font-medium text-tg-text2">
              <span>Использовано на этой неделе</span>
              <span className="tabular-nums text-tg-hint">
                {promotion.used} из {promotion.limit}
              </span>
            </div>
            <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-tg-sep/50">
              <div
                className="h-full rounded-full bg-tg-link transition-all duration-500"
                style={{
                  width: `${Math.min(100, Math.round((promotion.used / Math.max(1, promotion.limit)) * 100))}%`,
                }}
              />
            </div>
          </div>

          {/* Последние посты канала */}
          <div className="mt-3 space-y-2">
            {posts === null ? (
              <div className="h-[68px] rounded-2xl tg-shimmer" />
            ) : posts.length === 0 ? (
              <p className="py-2 text-center text-[13px] text-tg-hint">У канала пока нет постов в Tg Swipe</p>
            ) : (
              posts.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-2.5 rounded-2xl border border-tg-sep/40 bg-tg-bg p-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-[13px] leading-snug text-tg-text2">
                      {stripMarkdown(p.text).replace(/\s+/g, ' ').trim() || 'Медиа-пост'}
                    </p>
                    <div className="mt-0.5 text-[11.5px] text-tg-hint">
                      {timeAgoRu(p.publishedAt)} · {formatCount(p.viewsCount)} {pluralRu(p.viewsCount, 'просмотр', 'просмотра', 'просмотров')}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => promote(p.id)}
                    disabled={busyId !== null || limitReached}
                    className="flex h-11 shrink-0 items-center gap-1.5 rounded-xl bg-tg-surface px-3 text-[12.5px] font-semibold text-tg-link transition active:scale-95 disabled:opacity-50"
                  >
                    {busyId === p.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Rocket className="h-3.5 w-3.5" />
                    )}
                    Продвинуть
                  </button>
                </div>
              ))
            )}
          </div>

          {limitReached && (
            <p className="mt-2.5 text-[12px] leading-snug text-tg-hint">
              Лимит недели исчерпан — новое продвижение откроется через 7 дней после последнего.
            </p>
          )}
          {needPro && <UpgradeNote className="mt-3" />}
        </div>
      ) : (
        <LockedCard
          title="Продвижение в ленте"
          text="Поднимайте свои посты в первых рядах ленты — до 7 раз в неделю."
        />
      )}
    </motion.section>
  )
}

/* ------------------------------------------------------------------ */
/* Рекламный кабинет                                                   */
/* ------------------------------------------------------------------ */

function AdsSection({
  channel,
  onReload,
}: {
  channel: MyChannelDTO
  onReload: () => void
}) {
  const [topUpOpen, setTopUpOpen] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  // v5.54: баланс — в общем сторе: мутировал другую вкладку — кабинет видит свежим
  const patchBalance = useApp((s) => s.patchBalance)
  // Баланс ОБЩЕГО кошелька (v5.39): edge-кэш Redis → фолбэк на /api/wallet (Node + БД)
  const [bal, setBal] = useState<{ balanceKop: number; swipes: number } | null>(null)
  const active = channel.campaigns.filter((c) => c.status === 'active' || c.status === 'moderation' || c.status === 'paused')
  const finished = channel.campaigns.filter((c) => c.status === 'completed' || c.status === 'rejected' || c.status === 'canceled')

  const loadBalance = useCallback(() => {
    api<{ ok: boolean; cached?: boolean; balanceKop?: number; swipes?: number }>('/api/wallet/balance')
      .then((r) => {
        if (r.ok && typeof r.balanceKop === 'number') {
          setBal({ balanceKop: r.balanceKop, swipes: r.swipes ?? 0 })
          patchBalance({ balanceKop: r.balanceKop, swipes: r.swipes ?? 0 })
          return null
        }
        return api<{ balanceKop: number; swipes: number }>('/api/wallet')
      })
      .then((fallback) => {
        if (fallback) {
          setBal({ balanceKop: fallback.balanceKop, swipes: fallback.swipes })
          patchBalance({ balanceKop: fallback.balanceKop, swipes: fallback.swipes })
        }
      })
      .catch(() => {})
  }, [patchBalance])

  useEffect(() => {
    loadBalance()
  }, [loadBalance, onReload])

  return (
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 }}>
      <SectionTitle icon={Megaphone}>Реклама</SectionTitle>
      <div className="space-y-3">
        {/* Баланс — ОБЩИЙ кошелёк (v5.39): рубли + свайпы; эскроу-счёт выведен из оборота */}
        <div className="flex items-center gap-4 rounded-2xl border border-tg-sep/50 bg-tg-surface/70 p-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-tg-star/15">
            <Wallet className="h-6 w-6 text-tg-star" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-semibold uppercase tracking-wide text-tg-hint">Кошелёк</div>
            <div className="text-[22px] font-bold leading-tight tabular-nums text-tg-text">
              {bal ? `${(bal.balanceKop / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽` : '…'}
              <span className="ml-2 inline-flex items-center gap-1 text-[14px] font-semibold text-tg-hint">
                {bal ? (
                  <>
                    <SwipeIcon className="inline h-3.5 w-3.5" />
                    {bal.swipes.toLocaleString('ru-RU')} {pluralSwipes(bal.swipes)}
                  </>
                ) : (
                  ''
                )}
              </span>
            </div>
            <div className="text-[11.5px] text-tg-hint">
              Бюджеты кампаний списываются с общего баланса · возврат остатка — в кошелёк
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              haptic('light')
              setTopUpOpen(true)
            }}
            className="flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-tg-star px-4 text-[13.5px] font-bold text-white transition active:scale-95"
          >
            <Plus className="h-4 w-4" />
            Пополнить
          </button>
        </div>

        {/* Кампании */}
        {active.length === 0 && finished.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-tg-sep bg-tg-surface/50 p-5 text-center">
            <Sparkles className="mx-auto h-6 w-6 text-tg-hint" />
            <p className="mt-2 text-[13.5px] leading-relaxed text-tg-hint">
              Запустите кампанию — посты канала поднимутся в первые ряды ленты, платите только за
              уникальных читателей.
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {channel.campaigns.map((c) => (
              <CampaignCard key={c.id} campaign={c} reload={onReload} />
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={() => {
            haptic('light')
            setFormOpen(true)
          }}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-tg-link text-[14.5px] font-semibold text-white transition active:scale-[0.98]"
        >
          <Plus className="h-4.5 w-4.5" />
          Новая кампания
        </button>
      </div>

      {/* Пополнение ОБЩЕГО кошелька: на ПК — целая страница, в миниаппе — шторка; 3 способа оплаты */}
      <TopUpModal open={topUpOpen} onClose={() => { setTopUpOpen(false); loadBalance() }} onReload={() => { onReload(); loadBalance() }} />
      {/* Форма кампании */}
      <BottomSheet open={formOpen} onClose={() => setFormOpen(false)} title="Новая кампания">
        <CampaignForm channel={channel} onDone={() => { setFormOpen(false); onReload() }} />
      </BottomSheet>
    </motion.section>
  )
}

/* ------------------------------------------------------------------ */
/* Форма кампании                                                      */
/* ------------------------------------------------------------------ */

function CampaignForm({ channel, onDone }: { channel: MyChannelDTO; onDone: () => void }) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [cta, setCta] = useState('Подписаться')
  const [link, setLink] = useState(`https://t.me/${channel.username}`)
  const [cpc, setCpc] = useState(300)
  const [budget, setBudget] = useState(5000)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      await api('/api/campaigns', {
        method: 'POST',
        body: JSON.stringify({
          channelId: channel.id,
          title: title.trim(),
          body: body.trim(),
          ctaLabel: cta.trim() || 'Подписаться',
          link: link.trim(),
          costPerClickKop: cpc,
          budgetKop: budget,
        }),
      })
      haptic('success')
      onDone()
    } catch (err) {
      toast.error((err as Error).message || 'Не удалось создать кампанию')
      haptic('error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="pb-2">
      <SheetTitle icon={Megaphone} title="Новая кампания" subtitle="Посты канала поднимаются в ленте" />
      <div className="mt-3 space-y-3">
        <Field label="Заголовок объявления">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={`Канал «${channel.title}»`}
            maxLength={60}
            className={INPUT_CLS}
          />
        </Field>
        <Field label="Текст">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Что читатель получит, подписавшись?"
            maxLength={140}
            rows={2}
            className={cn(INPUT_CLS, 'resize-none')}
          />
        </Field>
        <Field label="Ссылка (t.me)">
          <input
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://t.me/channel"
            className={INPUT_CLS}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Цена перехода, свайпов">
            <input
              type="number"
              min={3}
              max={100}
              value={cpc / 100}
              onChange={(e) => setCpc(Math.max(100, Math.round(Number(e.target.value) * 100)))}
              className={INPUT_CLS}
            />
          </Field>
          <Field label="Бюджет, свайпов">
            <input
              type="number"
              min={30}
              value={budget / 100}
              onChange={(e) => setBudget(Math.max(3000, Math.round(Number(e.target.value) * 100)))}
              className={INPUT_CLS}
            />
          </Field>
        </div>
        <p className="text-[12px] leading-snug text-tg-hint">
          Хватит примерно на <span className="font-semibold text-tg-text2">{Math.floor(budget / cpc)}</span>{' '}
          {pluralRu(Math.floor(budget / cpc), 'уникальный переход', 'уникальных перехода', 'уникальных переходов')} · 1 свайп = 1 ₽ · списание только за реальных читателей
        </p>
      </div>
      <button
        type="submit"
        disabled={busy || !title.trim() || !body.trim()}
        className={cn(
          'mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-2xl text-[15px] font-semibold transition active:scale-[0.98]',
          busy || !title.trim() || !body.trim()
            ? 'cursor-not-allowed bg-tg-surface text-tg-hint'
            : 'bg-tg-link text-white',
        )}
      >
        {busy ? <Loader2 className="h-4.5 w-4.5 animate-spin" /> : <Send className="h-4.5 w-4.5" />}
        Запустить кампанию
      </button>
    </form>
  )
}

/* ------------------------------------------------------------------ */
/* Карточка кампании                                                   */
/* ------------------------------------------------------------------ */

const CAMPAIGN_STATUS: Record<string, { label: string; cls: string }> = {
  moderation: { label: 'на модерации', cls: 'bg-tg-star/12 text-tg-star' },
  active: { label: 'идёт показ', cls: 'bg-tg-green/12 text-tg-green' },
  paused: { label: 'пауза', cls: 'bg-tg-sep/60 text-tg-hint' },
  completed: { label: 'завершена', cls: 'bg-tg-sep/60 text-tg-hint' },
  rejected: { label: 'отклонена', cls: 'bg-tg-like/12 text-tg-like' },
  canceled: { label: 'отменена', cls: 'bg-tg-sep/60 text-tg-hint' },
}

function CampaignCard({ campaign, reload }: { campaign: CampaignDTOView; reload: () => void }) {
  const [busy, setBusy] = useState(false)
  const spent = Math.min(campaign.spentKop, campaign.budgetKop)
  const progress = campaign.budgetKop > 0 ? Math.round((spent / campaign.budgetKop) * 100) : 0
  const ctr = campaign.impressions > 0 ? ((campaign.clicks / campaign.impressions) * 100).toFixed(1) : '—'
  const status = CAMPAIGN_STATUS[campaign.status] ?? CAMPAIGN_STATUS.paused

  const act = async (action: 'pause' | 'resume' | 'cancel') => {
    if (busy) return
    setBusy(true)
    try {
      await api('/api/campaigns', { method: 'PATCH', body: JSON.stringify({ id: campaign.id, action }) })
      haptic('light')
      reload()
    } catch (err) {
      toast.error((err as Error).message || 'Не удалось')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-2xl border border-tg-sep/50 bg-tg-surface/70 p-4">
      <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-bold text-tg-text">{campaign.title}</div>
          <div className="mt-0.5 line-clamp-1 text-[12.5px] text-tg-hint">{campaign.body}</div>
        </div>
        <span className={cn('shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold', status.cls)}>
          {status.label}
        </span>
      </div>

      {/* Прогресс бюджета */}
      <div className="mt-3">
        <div className="h-2 overflow-hidden rounded-full bg-tg-sep/50">
          <motion.div
            className="h-full rounded-full bg-tg-link"
            initial={{ width: 0 }}
            animate={{ width: `${progress}%` }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
          />
        </div>
        <div className="mt-1.5 flex justify-between text-[11.5px] tabular-nums text-tg-hint">
          <span>{formatSwipes(spent)} из {formatSwipes(campaign.budgetKop)}</span>
          <span>{progress}%</span>
        </div>
      </div>

      {/* Метрики */}
      <div className="mt-3 grid grid-cols-4 gap-1.5 text-center">
        <Metric value={formatCount(campaign.impressions)} label="показы" />
        <Metric value={formatCount(campaign.clicks)} label="переходы" />
        <Metric value={`${ctr}%`} label="CTR" />
        <Metric value={`${campaign.costPerClickKop / 100}`} label="свайпов за переход" />
      </div>

      {/* Действия */}
      {(campaign.status === 'active' || campaign.status === 'paused' || campaign.status === 'moderation') && (
        <div className="mt-3 flex gap-2">
          {campaign.status === 'active' ? (
            <button
              type="button"
              onClick={() => act('pause')}
              disabled={busy}
              className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl bg-tg-sep/50 text-[13px] font-semibold text-tg-text2 active:scale-95"
            >
              <Pause className="h-3.5 w-3.5" /> Пауза
            </button>
          ) : campaign.status === 'paused' ? (
            <button
              type="button"
              onClick={() => act('resume')}
              disabled={busy}
              className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl bg-tg-link/10 text-[13px] font-semibold text-tg-link active:scale-95"
            >
              <Play className="h-3.5 w-3.5" /> Возобновить
            </button>
          ) : (
            <span className="flex h-9 flex-1 items-center justify-center text-[12.5px] text-tg-hint">
              Проверяем объявление — обычно это быстро
            </span>
          )}
          <button
            type="button"
            onClick={() => act('cancel')}
            disabled={busy}
            aria-label="Отменить кампанию"
            className="flex h-9 w-9 items-center justify-center rounded-xl bg-tg-sep/50 text-tg-hint active:scale-95"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-4 w-4" />}
          </button>
        </div>
      )}
    </div>
  )
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-xl bg-tg-bg py-2">
      <div className="text-[14px] font-bold leading-none tabular-nums text-tg-text">{value}</div>
      <div className="mt-1 text-[10.5px] text-tg-hint">{label}</div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Общие мелочи                                                        */
/* ------------------------------------------------------------------ */

type CampaignDTOView = MyChannelDTO['campaigns'][number]

const INPUT_CLS =
  // 16px — iOS не зумит поле при фокусе (ниже 16 зумит) — забота о всех устройствах
  'h-11 w-full rounded-xl border border-tg-sep bg-tg-bg px-3.5 text-[16px] text-tg-text outline-none placeholder:text-tg-hint focus:border-tg-link'

function SectionTitle({ icon: Icon, children }: { icon: typeof Eye; children: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-1.5 px-1">
      <Icon className="h-4 w-4 text-tg-hint" />
      <span className="text-[13px] font-bold uppercase tracking-wide text-tg-hint">{children}</span>
    </div>
  )
}

function SheetTitle({ icon: Icon, title, subtitle }: { icon: typeof Eye; title: string; subtitle: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-tg-link/12">
        <Icon className="h-5 w-5 text-tg-link" />
      </span>
      <div>
        <div className="text-[16px] font-bold text-tg-text">{title}</div>
        <div className="text-[12.5px] text-tg-hint">{subtitle}</div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12.5px] font-semibold text-tg-text2">{label}</span>
      {children}
    </label>
  )
}
