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
  FileText,
  Link2,
  Loader2,
  Lock,
  MessageSquare,
  Pin,
  Radio,
  RefreshCw,
  Rocket,
  ScanSearch,
  Send,
  Settings2,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { copyText } from '@/lib/clipboard'
import { toast } from 'sonner'
import { api, apiCached, invalidateApiCache } from '@/lib/api'
import { useApp } from '@/lib/store'
import { formatCount, pluralRu } from '@/lib/format'
import { haptic, openTelegram } from '@/lib/tg'
import { useT } from '@/lib/i18n'
import { Avatar } from '@/components/tg/Avatar'
import { ChannelCabinet } from '@/components/feed/ChannelCabinet'
import { AiChat } from '@/components/ai/AiChat'
import { ChannelLiveView } from '@/components/channel/ChannelLiveView'
import { PromoSection } from '@/components/channel/PromoSection'
import { SubscriptionsSection } from '@/components/tabs/SubscriptionsSection'
import type { MyChannelDTO, MyChannelResponse } from '@/lib/types'

/**
 * «Канал» (v5.58) — РАБОЧИЙ СТОЛ АДМИНА: три главных элемента внутри одной
 * вкладки нижней навигации:
 *   1. Мой канал — управление: привязка и шапка канала.
 *   2. Статистика — большая аналитика именно СВОЕГО канала (как в админке).
 *   3. ИИ-ассистент — Snap Ассистент: генерация, публикация, УДАЛЕНИЕ постов,
 *      смена названия/описания/аватара — полный пульт управления каналом.
 * v5.70 (Task 7-a): «Продвижение в ленте», «CTA-кнопка» и «Показ в ленте»
 * переехали в PromoTab; v5.72: возврат — это РАЗДЕЛ «Промо» этого кабинета
 * (PromoSection), отдельной вкладки навбара больше нет. Рекламный кабинет
 * (кошелёк/CPA-кампании) удалён по решению владельца; бэкенд /api/ads и
 * /api/campaigns не тронут (PromoteSheet живёт).
 */

/**
 * Разделы рабочего стола (v5.65: + «Живой канал»; v5.72: + «Промо» — вернулся
 * из отдельной вкладки навбара в кабинет). Активная — пилюлей с layoutId.
 */
const CHANNEL_SECTIONS = [
  { key: 'manage', label: 'Мой канал' },
  { key: 'live', label: 'Живой канал' },
  { key: 'stats', label: 'Статистика' },
  { key: 'promo', label: 'Промо' },
  { key: 'ai', label: 'ИИ-ассистент' },
] as const

/** Порог горизонтального свайпа между разделами кабинета (v5.72) */
const SECTION_SWIPE_DIST = 56

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
  // v5.72: авто-докрутка активной пилюли раздела в зону видимости
  const pillListRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = pillListRef.current?.querySelector<HTMLElement>(`[data-sec="${section}"]`)
    el?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' })
  }, [section])

  /* v5.72: СВАЙП МЕЖДУ РАЗДЕЛАМИ кабинета. Горизонтальный жест по контенту
   * секции переключает раздел (Мой канал ↔ Живой ↔ Статистика ↔ Промо ↔ ИИ),
   * а НЕ вкладку навбара (прежде свайп по пилюлям уводил в другую вкладку).
   * Траекторный анализ как в page.tsx: вертикаль «победила первой» — это
   * скролл; жесты, начавшиеся в [data-hscroll] (пилюли, слайдер), игнорируем.
   * На контенте стоит data-noswipe — страничный хендлер навбара здесь молчит. */
  const secTouch = useRef<{
    x: number
    y: number
    t: number
    maxDx: number
    maxDy: number
    skip: boolean
  } | null>(null)

  const onSectionTouchStart = (e: React.TouchEvent) => {
    const t0 = e.touches[0]
    const el = e.target as Element | null
    secTouch.current = {
      x: t0.clientX,
      y: t0.clientY,
      t: Date.now(),
      maxDx: 0,
      maxDy: 0,
      skip: Boolean(el?.closest?.('[data-hscroll]')),
    }
  }
  const onSectionTouchMove = (e: React.TouchEvent) => {
    const r = secTouch.current
    if (!r) return
    const t0 = e.touches[0]
    r.maxDx = Math.max(r.maxDx, Math.abs(t0.clientX - r.x))
    r.maxDy = Math.max(r.maxDy, Math.abs(t0.clientY - r.y))
  }
  const onSectionTouchEnd = (e: React.TouchEvent) => {
    const r = secTouch.current
    secTouch.current = null
    if (!r || r.skip) return
    const dx = e.changedTouches[0].clientX - r.x
    const dt = Date.now() - r.t
    // Чисто горизонтальный жест: доминирует над вертикалью вдвое
    if (r.maxDx < SECTION_SWIPE_DIST || r.maxDx < r.maxDy * 2 || dt > 800) return
    const idx = CHANNEL_SECTIONS.findIndex((s) => s.key === section)
    const next = CHANNEL_SECTIONS[idx + (dx < 0 ? 1 : -1)]
    if (next) {
      haptic('light')
      setSection(next.key)
    }
  }

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

  // Тариф приходит из GET /api/mychannel (E2E берёт его оттуда же).
  // v5.70: состояние продвижения (promotion/pack*) нужно только вкладке «Промо»
  const tier = data?.tier ?? 'free'
  const hasChannel = Boolean(data && data.channels.length > 0)

  return (
    <div className="no-scrollbar h-full w-full overflow-y-auto overscroll-contain px-4 pb-28 pt-5 lg:px-6 lg:pt-7">
      {/* Центрированная колонка: кабинет не растягивается на весь широкий экран */}
      <div className="mx-auto w-full max-w-[960px]">
        {/* Заголовок */}
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="text-screen-title leading-tight text-tg-text">Каналы</h1>
          <p className="mt-1 text-[15px] text-tg-hint">
            Подписки, ваш канал и ИИ-пульт — всё в одном месте
          </p>
        </motion.div>

        {/* v5.68: УПРАВЛЕНИЕ ПОДПИСКАМИ — переехало из профиля наверх вкладки.
            Скрытие из ленты (мьют) тоже здесь — это управление каналами. */}
        <div className="mt-5">
          <SubscriptionsSection />
        </div>

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
          <>
            {/* v5.68: разделитель секций (подписки выше, привязка канала ниже) */}
            <h2 className="mb-3 mt-7 px-1 text-[19px] font-bold text-tg-text">Ваш канал</h2>
            <ClaimCard onDone={reload} />
          </>
        ) : (
          <div className="mt-5 space-y-4">
            {/* v5.68: заголовок админ-части (визуально отделяет от подписок) */}
            <h2 className="px-1 pt-3 text-[19px] font-bold text-tg-text">Ваш канал</h2>
            {/* Переключатель каналов (если привязано несколько) */}
            {data!.channels.length > 1 && (
              <div
                data-noswipe
                data-hscroll
                className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-1"
              >
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

            {/* ТРИ ГЛАВНЫХ РАЗДЕЛА: Мой канал · Живой · Статистика · Промо · ИИ.
                Скроллящиеся пилюли — лёгкий вес, больше воздуха. */}
            {/* v5.65: сплошной фон вместо backdrop-blur — блюр на скролле
                перекрашивает слой каждый кадр и съедает кадры на мобильных */}
            {/* data-noswipe+data-hscroll: горизонтальный скролл пилюль — это скролл
                пилюль, а НЕ свайп вкладки навбара и НЕ смена раздела */}
            <div className="sticky top-0 z-20 -mx-4 bg-tg-bg px-4 py-2.5 lg:-mx-6 lg:px-6">
              <div
                ref={pillListRef}
                data-noswipe
                data-hscroll
                className="no-scrollbar flex gap-2 overflow-x-auto"
                role="tablist"
                aria-label={t('mc.tabsAria')}
              >
                {CHANNEL_SECTIONS.map((s) => {
                  const active = section === s.key
                  return (
                    <button
                      key={s.key}
                      type="button"
                      role="tab"
                      data-sec={s.key}
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

            {/* Контент раздела (key — чтобы анимация не переезжала между разделами).
                v5.72: data-noswipe — здесь горизонтальный свайп переключает РАЗДЕЛ
                кабинета (хендлеры ниже), навбаровский свайп вкладок отключён.
                Автопрокрутка пилюли к активной — scrollIntoView при смене section. */}
            <motion.div
              key={section}
              data-noswipe
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="pt-1"
              onTouchStart={onSectionTouchStart}
              onTouchMove={onSectionTouchMove}
              onTouchEnd={onSectionTouchEnd}
            >
              {section === 'manage' && (
                <div className="space-y-5">
                  <ChannelHero key={`hero-${channel!.id}`} channel={channel!} onReload={reload} />
                  {/* v5.72: «Продвижение в ленте», «CTA-кнопка» и «Показ в ленте»
                      живут в разделе «Промо» этого же кабинета — кнопка открывает его */}
                  <button
                    type="button"
                    onClick={() => {
                      haptic('light')
                      setSection('promo')
                    }}
                    className="press flex w-full items-center gap-3 rounded-2xl border border-tg-sep/50 bg-tg-surface/70 p-4 text-left transition active:scale-[0.99]"
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-tg-link/12">
                      <Rocket className="h-5 w-5 text-tg-link" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-bold text-tg-text">
                        Продвижение · CTA · показ в ленте
                      </span>
                      <span className="block text-[12.5px] leading-snug text-tg-hint">
                        Пакеты продвижений, кнопка действия и гибкий тизер — в разделе «Промо»
                      </span>
                    </span>
                    <ChevronRight className="h-4.5 w-4.5 shrink-0 text-tg-hint" aria-hidden />
                  </button>
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
              {section === 'promo' && channel && data && (
                <PromoSection
                  key={`promo-${channel.id}`}
                  data={data}
                  channel={channel}
                  onReload={() => void reload()}
                />
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
/* Snap Pro: общие блоки апгрейда                                      */
/* ------------------------------------------------------------------ */

/**
 * Кнопки «Тарифы» из кабинета ведут прямо в шит тарифов на вкладке «Профиль»
 * (флаг в sessionStorage + событие — ProfileTab подхватывает и на монтировании,
 * и когда уже смонтирован).
 */
const TIERS_FLAG = 'tgfeed_open_tiers'
const TIERS_EVENT = 'tgfeed:open-tiers'

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
/* Общие мелочи                                                        */
/* ------------------------------------------------------------------ */

function SectionTitle({ icon: Icon, children }: { icon: typeof Eye; children: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-1.5 px-1">
      <Icon className="h-4 w-4 text-tg-hint" />
      <span className="text-[13px] font-bold uppercase tracking-wide text-tg-hint">{children}</span>
    </div>
  )
}
