'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  FileText,
  Image as ImageIcon,
  Loader2,
  Lock,
  Minus,
  MousePointerClick,
  Plus,
  Radio,
  RefreshCw,
  Rocket,
  Scissors,
  Sparkles,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { api, apiCached, invalidateApiCache } from '@/lib/api'
import { useApp } from '@/lib/store'
import { formatCount, pluralRu, timeAgoRu } from '@/lib/format'
import { stripMarkdown } from '@/lib/markdown'
import { haptic } from '@/lib/tg'
import { Avatar } from '@/components/tg/Avatar'
import { PromotePackSheet } from '@/components/channel/PromotePackSheet'
import { cutAtWord, normalizeTeaserApplyTo, teaserApplies, type TeaserApplyTo } from '@/lib/teaser'
import type { MyChannelDTO, MyChannelResponse, PostDTO } from '@/lib/types'

/**
 * «Промо» (v5.70, Task 7-a) — ОТДЕЛЬНАЯ вкладка-рабочий стол продвижения автора.
 * Секции переехали из «Моего канала» (ChannelTab) 1:1, логика не менялась:
 *   1. Продвижение в ленте — месячный лимит Snap Pro (1/мес) + пакеты (PromotePackSheet).
 *   2. CTA-кнопка — текст/https-ссылка, tier-гейт.
 *   3. Показ в ленте — РАСШИРЕННО: режим (полностью/обрезка/блюр) + лимит символов
 *      + НОВОЕ teaserApplyTo (ко всем / только лонгридам / только текстовым без
 *      медиа) + живое превью мок-поста.
 * Данные: тот же контракт GET/POST /api/mychannel, что у ChannelTab.
 */

/** Режимы показа в ленте (переехали из ChannelTab без изменений) */
const DISPLAY_MODES = [
  { id: 'none', label: 'Полностью', icon: FileText, hint: 'посты видны целиком' },
  { id: 'cut', label: 'Обрезка', icon: Scissors, hint: 'начало текста + кнопка «Читать полностью в Telegram»' },
  { id: 'blur', label: 'Блюр', icon: EyeOff, hint: 'весь текст размыт до подписки' },
] as const

/** v5.70: гибкость — КОМУ из постов применять тизер */
const APPLY_MODES = [
  { id: 'all', label: 'Ко всем постам', hint: 'тизер у любого поста длиннее порога' },
  { id: 'long', label: 'Только длинным', hint: 'лонгриды — текст длиннее 600 символов' },
  { id: 'text', label: 'Текстовым без медиа', hint: 'посты с фото и видео показываются целиком' },
] as const

/** Мок-текст превью: «лонгрид» (~700 символов) — заметно длиннее лимита и порога long */
const SAMPLE_TEXT =
  'Разбор: как мы выросли с нуля до десяти тысяч подписчиков за три месяца без бюджета ' +
  'на рекламу. Каждый день мы публиковали ровно один пост в одно и то же время — аудитория ' +
  'привыкает к ритму быстрее, чем к контенту. Второй шаг — тематические рубрики: читатели ' +
  'подписываются не на канал, а на привычку находить нужное в одном месте. Третий шаг — ' +
  'приглашения: каждый пост заканчивался одним коротким вопросом, на который хотелось ' +
  'ответить. Комментарии разгоняли охват, а охват приводил новых людей. И наконец, ' +
  'ретроспектива раз в неделю: что зашло, что нет и что попробуем завтра. Сохраните этот ' +
  'план и адаптируйте под свою нишу — ритм, рубрики, вовлечение и честная аналитика.' +
  ' Через месяц вы увидите рост, а через три — стабильное ядро читателей, которое ' +
  'останется с каналом надолго.'

export function PromoTab() {
  const goToTab = useApp((s) => s.goToTab)
  const [data, setData] = useState<MyChannelResponse | null>(null)
  const [loading, setLoading] = useState(true)
  // Сетевой сбой ≠ «канал не привязан» — отдельный экран повтора (паттерн ChannelTab)
  const [failed, setFailed] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)

  const fetchChannel = useCallback(async (useCache: boolean) => {
    try {
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
  /** Перезагрузка после действий (продвижение/настройки): только сеть */
  const reload = useCallback(() => {
    invalidateApiCache('/api/mychannel')
    return fetchChannel(false)
  }, [fetchChannel])

  useEffect(() => {
    void load()
  }, [load])

  const channel = useMemo(
    () => data?.channels.find((c) => c.id === activeId) ?? data?.channels[0] ?? null,
    [data, activeId],
  )

  const tier = data?.tier ?? 'free'
  const promotion = data?.promotion ?? { used: 0, limit: 1, available: false, credits: 0 }
  const packPrice = data?.promotePackPrice ?? 19_900
  const packCount = data?.promotePackCount ?? 5

  return (
    <div className="no-scrollbar h-full w-full overflow-y-auto overscroll-contain px-4 pb-28 pt-5 lg:px-6 lg:pt-7">
      <div className="mx-auto w-full max-w-[960px]">
        {/* Заголовок вкладки */}
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="text-screen-title leading-tight text-tg-text">Промо</h1>
          <p className="mt-1 text-[15px] text-tg-hint">Продвижение, CTA и показ в ленте</p>
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
            <p className="text-[15px] font-semibold text-tg-text">Не удалось загрузить промо-кабинет</p>
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
        ) : !channel ? (
          <>
            {/* Канала нет — пустое состояние с переходом к привязке */}
            <div className="mt-8 flex flex-col items-center gap-3 rounded-2xl border border-dashed border-tg-sep bg-tg-surface/50 px-4 py-10 text-center">
              <span className="flex size-16 items-center justify-center rounded-full bg-tg-link/10 text-tg-link" aria-hidden>
                <Radio className="size-8" strokeWidth={1.7} />
              </span>
              <p className="text-[15px] font-semibold text-tg-text">Сначала привяжите канал</p>
              <p className="max-w-[320px] text-snippet text-tg-hint">
                Продвижение постов, CTA-кнопка и показ в ленте настраиваются для вашего канала
              </p>
              <button
                type="button"
                onClick={() => {
                  haptic('light')
                  goToTab('channel')
                }}
                className="press mt-1 flex items-center gap-1.5 rounded-full bg-tg-link px-4 py-2 text-[14px] font-semibold text-white"
              >
                Привязать канал
              </button>
            </div>
          </>
        ) : (
          <div className="mt-5 space-y-5">
            {/* Селектор канала (если привязано несколько) */}
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
                      c.id === channel.id
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

            <PromotionSection
              key={`promo-${channel.id}`}
              channel={channel}
              tier={tier}
              promotion={promotion}
              packPrice={packPrice}
              packCount={packCount}
              onReload={reload}
            />

            <CtaSection key={`cta-${channel.id}`} channel={channel} tier={tier} />

            <TeaserSection key={`teaser-${channel.id}`} channel={channel} onSaved={load} />
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Продвижение в ленте (Snap Pro: 1 бесплатно в месяц + пакеты)         */
/* Переехало из ChannelTab (Task 5-a) 1:1 — логика не менялась          */
/* ------------------------------------------------------------------ */

const fmtPackPrice = (kop: number): string => {
  const rub = kop / 100
  const frac = Number.isInteger(rub) ? 0 : 2
  return `${rub.toLocaleString('ru-RU', { minimumFractionDigits: frac, maximumFractionDigits: 2 })} ₽`
}

/** 402 pro_required: api() кидает Error(data.error) — message ровно 'pro_required' */
function proRequired(err: unknown): boolean {
  return (err as Error)?.message === 'pro_required'
}

/**
 * Кнопки «Тарифы» ведут прямо в шит тарифов на вкладке «Профиль»
 * (флаг в sessionStorage + событие — ProfileTab подхватывает и на монтировании,
 * и когда уже смонтирован).
 */
const TIERS_FLAG = 'tgfeed_open_tiers'
const TIERS_EVENT = 'tgfeed:open-tiers'
function goTiers() {
  haptic('light')
  try {
    sessionStorage.setItem(TIERS_FLAG, '1')
  } catch {
    /* приватный режим — останется только событие */
  }
  window.dispatchEvent(new Event(TIERS_EVENT))
  useApp.getState().setTab('profile')
}

/** Заблокированная возможность (не-pro): замок + кнопка апгрейда */
function LockedCard({ title, text }: { title: string; text: string }) {
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

function PromotionSection({
  channel,
  tier,
  promotion,
  packPrice,
  packCount,
  onReload,
}: {
  channel: MyChannelDTO
  tier: 'free' | 'plus' | 'pro'
  promotion: MyChannelResponse['promotion']
  packPrice: number
  packCount: number
  onReload: () => void
}) {
  const pro = tier === 'pro'
  const [posts, setPosts] = useState<PostDTO[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [needPro, setNeedPro] = useState(false)
  const [packOpen, setPackOpen] = useState(false)
  const freeLeft = Math.max(0, promotion.limit - promotion.used)
  // Продвигать можно, пока есть бесплатный слот месяца ИЛИ купленные кредиты
  const limitReached = freeLeft <= 0 && promotion.credits <= 0

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
      const r = await api<{
        ok: boolean
        source: 'free' | 'credit'
        used: number
        limit: number
        credits: number
      }>('/api/mychannel', {
        method: 'POST',
        body: JSON.stringify({ action: 'promote', channelId: channel.id, postId }),
      })
      haptic('success')
      toast.success(
        r.source === 'free'
          ? 'Продвинуто — бесплатное за этот месяц'
          : `Продвинуто из пакета · осталось ${r.credits}`,
      )
      onReload() // свежие promotion.used/credits из GET /api/mychannel
    } catch (err) {
      const m = (err as Error).message || ''
      if (proRequired(err)) {
        setNeedPro(true)
        toast.error('Продвижение доступно на тарифе Snap Pro')
      } else if (/пакет|месяц/i.test(m)) {
        // Исчерпаны и бесплатный слот, и кредиты — сразу предлагаем решение
        toast.error('Бесплатное продвижение месяца использовано')
        setPackOpen(true)
      } else {
        toast.error(m || 'Не удалось продвинуть')
      }
      haptic('error')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.06 }}>
      <SectionTitle icon={Rocket}>Продвижение в ленте</SectionTitle>
      {pro ? (
        <div className="card-soft rounded-2xl border border-tg-sep/50 bg-tg-surface p-4">
          <p className="text-[12.5px] leading-relaxed text-tg-hint">
            Протолкните пост в первые ряды ленты — буст температуры на сутки. 1 бесплатно в месяц,
            дальше — купленные продвижения.
          </p>

          {/* Месячный счётчик + купленные кредиты */}
          <div className="mt-3">
            <div className="flex items-center justify-between text-[12.5px] font-medium text-tg-text2">
              <span>Осталось в этом месяце</span>
              <span className="tabular-nums text-tg-hint">
                {freeLeft} из {promotion.limit}
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
            {promotion.credits > 0 && (
              <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-tg-text2">
                <Rocket className="h-3.5 w-3.5 text-tg-link" aria-hidden />
                Из пакета: <span className="font-semibold tabular-nums">{promotion.credits}</span>
              </p>
            )}
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

          {/* Бесплатный слот исчерпан → предложение докупить пакет */}
          {freeLeft <= 0 && (
            <p className="mt-2.5 text-[12px] leading-snug text-tg-hint">
              {promotion.credits > 0
                ? 'Бесплатное продвижение месяца использовано — следующие пойдут из пакета.'
                : 'Бесплатное продвижение месяца использовано — следующее откроется в новом месяце или купите пакет.'}
            </p>
          )}
          <button
            type="button"
            onClick={() => {
              haptic('light')
              setPackOpen(true)
            }}
            className={cn(
              'press mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl text-[14.5px] font-semibold transition active:scale-[0.98]',
              limitReached
                ? 'bg-tg-link text-white'
                : 'border border-tg-sep bg-tg-surface text-tg-link',
            )}
          >
            <Plus className="h-4 w-4" aria-hidden />
            Купить продвижения · {packCount} за {fmtPackPrice(packPrice)}
          </button>
          {needPro && <UpgradeNote className="mt-3" />}
        </div>
      ) : (
        <LockedCard
          title="Продвижение в ленте"
          text="Поднимайте свои посты в первых рядах ленты — 1 бесплатно в месяц, больше — пакетами."
        />
      )}

      {/* Покупка пакета: с баланса / 50/50 / картой (PromotePackSheet) */}
      <PromotePackSheet open={packOpen} onClose={() => setPackOpen(false)} onBought={onReload} />
    </motion.section>
  )
}

/* ------------------------------------------------------------------ */
/* CTA-кнопка (Snap Pro) — переехала из ChannelTab 1:1                  */
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
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
      <SectionTitle icon={MousePointerClick}>Кнопка действия (CTA)</SectionTitle>
      {pro ? (
        <div className="card-soft rounded-2xl border border-tg-sep/50 bg-tg-surface p-4">
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
/* Показ в ленте (v5.70) — режим + лимит + teaserApplyTo + живое превью */
/* Расширение DisplaySection из ChannelTab (Task 7-a)                   */
/* ------------------------------------------------------------------ */

function TeaserSection({ channel, onSaved }: { channel: MyChannelDTO; onSaved: () => void }) {
  const [mode, setMode] = useState(channel.teaserMode)
  const [limit, setLimit] = useState(channel.teaserLimit)
  const [applyTo, setApplyTo] = useState<TeaserApplyTo>(normalizeTeaserApplyTo(channel.teaserApplyTo))
  const [busy, setBusy] = useState(false)
  const dirty = mode !== channel.teaserMode || limit !== channel.teaserLimit || applyTo !== normalizeTeaserApplyTo(channel.teaserApplyTo)

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
          teaserApplyTo: applyTo,
        }),
      })
      haptic('success')
      toast.success('Настройки показа сохранены')
      onSaved()
    } catch (err) {
      toast.error((err as Error).message || 'Не удалось сохранить')
      haptic('error')
    } finally {
      setBusy(false)
    }
  }

  const setLimitClamped = (v: number) => setLimit(Math.min(600, Math.max(60, v)))

  return (
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.14 }}>
      <SectionTitle icon={Eye}>Показ в ленте</SectionTitle>
      <div className="card-soft rounded-2xl border border-tg-sep/50 bg-tg-surface p-4">
        <p className="text-[12.5px] leading-relaxed text-tg-hint">
          Управляйте тем, сколько поста видят неподписчики: полный текст, обрезка с призывом
          читать в канале или размытие.
        </p>

        {/* Режим: сегмент-контрол Полностью / Обрезка / Блюр */}
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

        {/* Порог обрезки: слайдер + степпер (режим «Обрезка») */}
        {mode === 'cut' && (
          <div className="mt-4">
            <div className="flex items-center justify-between text-[12.5px] font-medium text-tg-text2">
              <span>До скольких символов показывать</span>
              <span className="tabular-nums text-tg-hint">{limit} симв.</span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                aria-label="Меньше символов"
                onClick={() => {
                  haptic('light')
                  setLimitClamped(limit - 20)
                }}
                className="press flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-tg-surface text-tg-text2 active:scale-95"
              >
                <Minus className="h-4 w-4" aria-hidden />
              </button>
              <input
                type="range"
                min={60}
                max={600}
                step={20}
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
                className="w-full accent-[var(--tg-link, #0a84ff)]"
                aria-label="Порог обрезки текста"
              />
              <button
                type="button"
                aria-label="Больше символов"
                onClick={() => {
                  haptic('light')
                  setLimitClamped(limit + 20)
                }}
                className="press flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-tg-surface text-tg-text2 active:scale-95"
              >
                <Plus className="h-4 w-4" aria-hidden />
              </button>
            </div>
          </div>
        )}

        {/* v5.70: ГИБКОСТЬ — каким постам применять тизер */}
        {mode !== 'none' && (
          <div className="mt-4">
            <div className="text-[12.5px] font-medium text-tg-text2">Применять</div>
            <div className="mt-2 space-y-2">
              {APPLY_MODES.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => {
                    haptic('light')
                    setApplyTo(a.id)
                  }}
                  aria-pressed={applyTo === a.id}
                  className={cn(
                    'flex w-full items-start gap-2.5 rounded-2xl border px-3.5 py-2.5 text-left transition active:scale-[0.99]',
                    applyTo === a.id
                      ? 'border-tg-link bg-tg-link/10'
                      : 'border-tg-sep/60 bg-tg-bg',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                      applyTo === a.id ? 'border-tg-link bg-tg-link' : 'border-tg-sep bg-transparent',
                    )}
                    aria-hidden
                  >
                    {applyTo === a.id && <Check className="h-3 w-3 text-white" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={cn('block text-[13.5px] font-semibold', applyTo === a.id ? 'text-tg-link' : 'text-tg-text')}>
                      {a.label}
                    </span>
                    <span className="block text-[12px] leading-snug text-tg-hint">{a.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ЖИВОЕ ПРЕВЬЮ: мок-пост (обложка-плейсхолдер + текст) отражает и режим,
            и applyTo — пост в моке медийный, поэтому при «только текстовым»
            он показывается целиком */}
        <TeaserPreview mode={mode} limit={limit} applyTo={applyTo} />

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

/** Мини-пост с медиа для превью: показывает выбранный режим и область applyTo */
function TeaserPreview({ mode, limit, applyTo }: { mode: string; limit: number; applyTo: TeaserApplyTo }) {
  // Мок-пост медийный (есть обложка) → при applyTo='text' тизер к нему НЕ применяется
  const applies = teaserApplies(applyTo, { textLen: SAMPLE_TEXT.length, hasMedia: true, teaserLimit: limit })
  const shownMode = applies ? mode : 'none'
  const teaserText = cutAtWord(SAMPLE_TEXT, Math.max(60, limit)).trimEnd() + '…'

  return (
    <div className="mt-4 rounded-2xl bg-tg-bg p-3">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-semibold uppercase tracking-wide text-tg-hint">Как увидят читатели</span>
        {!applies && mode !== 'none' && (
          <span className="rounded-full bg-tg-star/12 px-2 py-0.5 text-[10.5px] font-semibold text-tg-star">
            медийный пост — без тизера
          </span>
        )}
      </div>

      {/* Мок-карточка поста */}
      <div className="mt-2 overflow-hidden rounded-xl border border-tg-sep/50 bg-tg-surface">
        {/* Обложка-плейсхолдер */}
        <div className="relative flex h-20 items-center justify-center bg-gradient-to-br from-tg-link/20 via-tg-link/8 to-transparent">
          <ImageIcon className="h-6 w-6 text-tg-link/60" aria-hidden />
        </div>
        <div className="relative p-3">
          {shownMode === 'blur' && (
            <span className="absolute inset-x-0 top-1/2 z-10 mx-auto w-fit -translate-y-1/2 rounded-full bg-tg-bg/90 px-3 py-1.5 text-[11.5px] font-bold text-tg-link shadow-sm">
              Подписаться, чтобы читать
            </span>
          )}
          <p
            className={cn(
              'text-[13px] leading-snug text-tg-text2',
              shownMode === 'blur' && 'select-none blur-[4px]',
            )}
            aria-hidden
          >
            {shownMode === 'cut' ? teaserText : SAMPLE_TEXT}
          </p>
          {shownMode === 'cut' && (
            <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-tg-link/10 px-2.5 py-1 text-[11.5px] font-semibold text-tg-link">
              Ещё <ChevronRight className="h-3 w-3" aria-hidden />
            </span>
          )}
        </div>
      </div>
      <p className="mt-2 text-[11.5px] leading-snug text-tg-hint">
        {applyTo === 'long'
          ? 'Тизер применится только к лонгридам (600+ символов); короткие и медийные посты видны целиком.'
          : applyTo === 'text'
            ? 'Тизер применится только к текстовым постам без медиа; посты с фото/видео — целиком.'
            : 'Тизер применится ко всем постам канала, длиннее порога.'}
      </p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Общие мелочи (локальные хелперы вкладки)                             */
/* ------------------------------------------------------------------ */

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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12.5px] font-semibold text-tg-text2">{label}</span>
      {children}
    </label>
  )
}
