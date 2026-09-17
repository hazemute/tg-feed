'use client'

import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  BarChart3,
  Eye,
  Heart,
  Loader2,
  Megaphone,
  Radio,
  RefreshCw,
  ShieldCheck,
  Sparkle,
  Wallet,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { haptic, openTelegram } from '@/lib/tg'
import { formatCount } from '@/lib/format'
import type {
  CategoryDTO,
  MyChannelDTO,
  MyChannelResponse,
  PostDTO,
} from '@/lib/types'
import { Avatar } from '@/components/tg/Avatar'

const CREATOR = 'tgfeed_creator'

/** Копейки → «350 ₽» (без дробной части, когда она нулевая) */
function formatKop(kop: number): string {
  const rub = kop / 100
  return Number.isInteger(rub) ? `${formatCount(rub)} ₽` : `${rub.toFixed(2).replace('.', ',')} ₽`
}

const STATUS_LABEL: Record<string, string> = {
  moderation: 'На модерации',
  active: 'Крутится',
  paused: 'Пауза',
  completed: 'Завершена',
  rejected: 'Отклонена',
}

const STATUS_STYLE: Record<string, string> = {
  moderation: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  active: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  paused: 'bg-tg-sep text-tg-hint',
  completed: 'bg-tg-sep text-tg-hint',
  rejected: 'bg-red-500/15 text-red-700 dark:text-red-300',
}

type Tab = 'stats' | 'display' | 'ads'

export function MyChannelTab() {
  const user = useApp((s) => s.user)
  const categories = useApp((s) => s.categories)
  const [data, setData] = useState<MyChannelResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [section, setSection] = useState<Tab>('stats')

  const load = useCallback(async () => {
    try {
      const r = await api<MyChannelResponse>('/api/mychannel')
      setData(r)
      setActiveId((prev) => prev ?? r.channels[0]?.id ?? null)
    } catch {
      toast.error('Не удалось загрузить канал')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const active = data?.channels.find((c) => c.id === activeId) ?? data?.channels[0] ?? null

  return (
    <div className="h-full overflow-y-auto overscroll-contain pb-28">
      {/* Шапка вкладки */}
      <header className="px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[22px] font-bold leading-tight text-tg-text">Мой канал</h1>
            <p className="mt-0.5 text-[13px] leading-snug text-tg-hint">
              Статистика, показ постов и реклама вашего канала
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              haptic('light')
              setLoading(true)
              load()
            }}
            aria-label="Обновить"
            className="flex h-10 w-10 items-center justify-center rounded-full text-tg-hint active:bg-tg-surface"
          >
            <RefreshCw className={cn('h-5 w-5', loading && 'animate-spin')} />
          </button>
        </div>
      </header>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-tg-hint" />
        </div>
      ) : !active ? (
        <ClaimCard onDone={load} />
      ) : (
        <>
          {/* Переключатель каналов (если привязано несколько) */}
          {data && data.channels.length > 1 && (
            <div className="no-scrollbar mb-3 flex gap-2 overflow-x-auto px-4">
              {data.channels.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    haptic('light')
                    setActiveId(c.id)
                  }}
                  className={cn(
                    'flex shrink-0 items-center gap-2 rounded-full px-3 py-1.5 text-[13px] font-medium transition active:scale-95',
                    c.id === active.id ? 'bg-tg-link text-white' : 'bg-tg-surface text-tg-text2',
                  )}
                >
                  <Avatar name={c.title} color={c.avatarColor} src={c.avatarUrl} size={20} />
                  {c.title}
                </button>
              ))}
            </div>
          )}

          {/* Секции: Статистика · Показ · Реклама */}
          <div className="mx-4 flex rounded-xl bg-tg-surface p-1">
            {(
              [
                ['stats', 'Статистика'],
                ['display', 'Показ'],
                ['ads', 'Реклама'],
              ] as Array<[Tab, string]>
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  haptic('light')
                  setSection(id)
                }}
                className={cn(
                  'relative flex-1 rounded-lg py-2 text-[13.5px] font-semibold transition',
                  section === id ? 'text-tg-text' : 'text-tg-hint',
                )}
              >
                {section === id && (
                  <motion.span
                    layoutId="mychannel-segment"
                    className="absolute inset-0 rounded-lg bg-tg-bg shadow-sm"
                    transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                  />
                )}
                <span className="relative z-10">{label}</span>
              </button>
            ))}
          </div>

          <div className="mt-3 px-4">
            {section === 'stats' && <StatsSection channel={active} />}
            {section === 'display' && (
              <DisplaySection channel={active} categories={categories} onSaved={load} />
            )}
            {section === 'ads' && (
              <AdsSection channel={active} data={data!} reload={load} />
            )}
          </div>
        </>
      )}
      {!user && <div className="h-10" />}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Привязка канала: код-слово вместо ручной модерации                  */
/* ------------------------------------------------------------------ */

function ClaimCard({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('')
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState<'input' | 'code'>('input')
  const [code, setCode] = useState('')
  const [title, setTitle] = useState('')

  const start = async () => {
    if (username.trim().length < 3) {
      toast.error('Введите ссылку на канал или @username')
      return
    }
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
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не получилось — проверьте ссылку')
    } finally {
      setBusy(false)
    }
  }

  const verify = async () => {
    setBusy(true)
    try {
      await api('/api/mychannel', {
        method: 'POST',
        body: JSON.stringify({ action: 'claimVerify', username: username.trim(), code }),
      })
      haptic('success')
      toast.success('Канал привязан')
      onDone()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Код не найден — попробуйте ещё раз')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-4">
      <div className="rounded-2xl bg-tg-surface p-4">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-tg-link/10 text-tg-link">
          <Radio className="h-5.5 w-5.5" />
        </span>
        <h2 className="mt-3 text-[17px] font-bold text-tg-text">Привяжите свой канал</h2>
        <p className="mt-1 text-[13.5px] leading-snug text-tg-text2">
          Подключите канал к Tg Swipe и получите статистику читателей, гибкие настройки
          показа постов и рекламный кабинет с оплатой за результат.
        </p>

        <AnimatePresence mode="wait">
          {stage === 'input' ? (
            <motion.div
              key="input"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              className="mt-4"
            >
              <label htmlFor="claim-username" className="mb-1.5 block text-[12px] font-medium text-tg-hint">
                Ссылка на канал
              </label>
              <input
                id="claim-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="@durov или t.me/durov"
                autoComplete="off"
                spellCheck={false}
                className="h-11 w-full rounded-xl bg-tg-bg px-3.5 text-[15px] text-tg-text outline-none ring-1 ring-tg-sep placeholder:text-tg-hint/70 focus:ring-tg-link"
              />
              <button
                type="button"
                onClick={start}
                disabled={busy}
                className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-tg-link text-[15px] font-semibold text-white transition active:scale-[0.98] disabled:opacity-60"
              >
                {busy ? <Loader2 className="h-4.5 w-4.5 animate-spin" /> : null}
                Получить код-слово
              </button>
            </motion.div>
          ) : (
            <motion.div
              key="code"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              className="mt-4"
            >
              <div className="rounded-xl bg-tg-bg p-3.5 ring-1 ring-tg-sep">
                <div className="text-[12px] font-medium text-tg-hint">
                  Шаг 1. Опубликуйте этот код постом в канале{title ? ` «${title}»` : ''}
                </div>
                <div className="mt-1.5 select-all text-center text-[20px] font-bold tracking-wide text-tg-link">
                  {code}
                </div>
                <div className="mt-1.5 text-[12px] leading-snug text-tg-hint">
                  Шаг 2. Вернитесь сюда и нажмите «Проверить». Код проверяется по последним
                  постам канала — постить может только владелец. После проверки пост с кодом
                  можно удалить.
                </div>
              </div>
              <button
                type="button"
                onClick={verify}
                disabled={busy}
                className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-tg-link text-[15px] font-semibold text-white transition active:scale-[0.98] disabled:opacity-60"
              >
                {busy ? <Loader2 className="h-4.5 w-4.5 animate-spin" /> : <ShieldCheck className="h-4.5 w-4.5" />}
                Проверить
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Статистика канала                                                   */
/* ------------------------------------------------------------------ */

function StatsSection({ channel }: { channel: MyChannelDTO }) {
  const s = channel.stats
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 rounded-2xl bg-tg-surface p-4">
        <Avatar name={channel.title} color={channel.avatarColor} src={channel.avatarUrl} size={54} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[16px] font-bold text-tg-text">{channel.title}</div>
          <div className="mt-0.5 truncate text-[13px] text-tg-hint">
            @{channel.username} · {formatCount(channel.subscribersCount)} подписчиков
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <StatCard icon={<Radio className="h-4 w-4" />} value={formatCount(s.posts)} label="постов в ленте" />
        <StatCard
          icon={<Eye className="h-4 w-4" />}
          value={formatCount(channel.subscribersCount)}
          label="читателей в Telegram"
        />
        <StatCard icon={<BarChart3 className="h-4 w-4" />} value={formatCount(s.views24h)} label="просмотров / 24ч" />
        <StatCard icon={<Heart className="h-4 w-4" />} value={formatCount(s.likes)} label="лайков" />
      </div>

      <div className="rounded-2xl bg-tg-surface p-4">
        <div className="text-[12px] font-semibold uppercase tracking-wide text-tg-hint">
          Что дают эти цифры
        </div>
        <p className="mt-1.5 text-[13px] leading-snug text-tg-text2">
          Просмотры за 24 часа — это читатели, которые видели ваши посты в Tg Swipe.
          Настройте показ постов во вкладке «Показ»: обрезка с призывом подписаться
          превращает читателей в подписчиков канала.
        </p>
      </div>
    </div>
  )
}

function StatCard({ icon, value, label }: { icon: React.ReactNode; value: string; label: string }) {
  return (
    <div className="rounded-2xl bg-tg-surface p-3.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-tg-link/10 text-tg-link">
        {icon}
      </span>
      <div className="mt-2 text-[19px] font-bold leading-none text-tg-text">{value}</div>
      <div className="mt-1 text-[11.5px] leading-tight text-tg-hint">{label}</div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Настройки показа: тизер постов                                      */
/* ------------------------------------------------------------------ */

const TEASER_OPTIONS: Array<{ id: 'none' | 'cut' | 'blur'; title: string; note: string }> = [
  {
    id: 'none',
    title: 'Показывать полностью',
    note: 'читатель видит весь текст прямо в ленте — удобно, но подписываться незачем',
  },
  {
    id: 'cut',
    title: 'Обрезать с призывом',
    note: 'первые абзацы в ленте, полный текст — в вашем канале. Лучший баланс',
  },
  {
    id: 'blur',
    title: 'Размытый текст',
    note: 'жёсткий вариант: текст виден, но размыт. Максимальная конверсия в подписку',
  },
]

function DisplaySection({
  channel,
  categories,
  onSaved,
}: {
  channel: MyChannelDTO
  categories: CategoryDTO[]
  onSaved: () => void
}) {
  const [mode, setMode] = useState(channel.teaserMode)
  const [limit, setLimit] = useState(channel.teaserLimit)
  const [categorySlug, setCategorySlug] = useState(channel.categorySlug)
  const [busy, setBusy] = useState(false)

  const dirty = mode !== channel.teaserMode || limit !== channel.teaserLimit || categorySlug !== channel.categorySlug

  const save = async () => {
    setBusy(true)
    try {
      await api('/api/mychannel', {
        method: 'POST',
        body: JSON.stringify({
          action: 'settings',
          channelId: channel.id,
          teaserMode: mode,
          teaserLimit: limit,
          categorySlug,
        }),
      })
      haptic('success')
      toast.success('Настройки сохранены')
      onSaved()
    } catch {
      toast.error('Не удалось сохранить')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-2xl bg-tg-surface p-4">
        <div className="text-[15.5px] font-bold text-tg-text">Как показывать посты в ленте</div>
        <div className="mt-3 space-y-2.5">
          {TEASER_OPTIONS.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => {
                haptic('light')
                setMode(o.id)
              }}
              className={cn(
                'flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition',
                mode === o.id ? 'border-tg-link bg-tg-link/5' : 'border-tg-sep bg-tg-bg',
              )}
            >
              <span
                className={cn(
                  'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2',
                  mode === o.id ? 'border-tg-link' : 'border-tg-sep',
                )}
              >
                {mode === o.id && <span className="h-2.5 w-2.5 rounded-full bg-tg-link" />}
              </span>
              <span>
                <span className="block text-[14.5px] font-semibold text-tg-text">{o.title}</span>
                <span className="mt-0.5 block text-[12.5px] leading-snug text-tg-hint">{o.note}</span>
              </span>
            </button>
          ))}
        </div>

        {mode === 'cut' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-4">
            <div className="flex items-baseline justify-between">
              <label htmlFor="teaser-limit" className="text-[13px] font-medium text-tg-text2">
                Сколько символов показывать
              </label>
              <span className="text-[13px] font-bold text-tg-link tabular-nums">{limit}</span>
            </div>
            <input
              id="teaser-limit"
              type="range"
              min={60}
              max={600}
              step={20}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="mt-2 w-full accent-tg-link"
            />
          </motion.div>
        )}
      </div>

      <div className="rounded-2xl bg-tg-surface p-4">
        <div className="text-[15.5px] font-bold text-tg-text">Категория в каталоге</div>
        <div className="mt-2.5 flex flex-wrap gap-2">
          {categories.map((c) => (
            <button
              key={c.slug}
              type="button"
              onClick={() => {
                haptic('light')
                setCategorySlug(c.slug)
              }}
              className={cn(
                'rounded-full px-3.5 py-2 text-[13px] font-medium transition active:scale-95',
                categorySlug === c.slug ? 'bg-tg-link text-white' : 'bg-tg-bg text-tg-text2',
              )}
            >
              {c.title}
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={save}
        disabled={busy || !dirty}
        className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-tg-link text-[15px] font-bold text-white transition active:scale-[0.98] disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-4.5 w-4.5 animate-spin" /> : null}
        Сохранить
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Реклама: эскроу-баланс, CPA-кампании                                */
/* ------------------------------------------------------------------ */

function AdsSection({
  channel,
  data,
  reload,
}: {
  channel: MyChannelDTO
  data: MyChannelResponse
  reload: () => void
}) {
  const [creating, setCreating] = useState(false)
  const balance = data.advertiser.balanceKop

  return (
    <div className="space-y-3">
      {/* Баланс эскроу */}
      <div className="rounded-2xl bg-tg-surface p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-tg-star/15 text-tg-star">
              <Wallet className="h-4.5 w-4.5" />
            </span>
            <div>
              <div className="text-[12px] font-medium text-tg-hint">Рекламный баланс</div>
              <div className="text-[20px] font-bold leading-tight text-tg-text">
                {formatKop(balance)}
              </div>
            </div>
          </div>
          <TopUpButton />
        </div>
        <p className="mt-2.5 text-[12.5px] leading-snug text-tg-text2">
          Бюджет кампании списывается с баланса сразу и крутится до последнего перехода:
          платите за уникальных читателей, а не за «показы из воздуха».
        </p>
      </div>

      {/* Кнопка создания + форма */}
      {creating ? (
        <CampaignForm
          channel={channel}
          onCancel={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            reload()
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            haptic('light')
            setCreating(true)
          }}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-tg-link text-[15px] font-bold text-white transition active:scale-[0.98]"
        >
          <Megaphone className="h-4.5 w-4.5" />
          Создать кампанию
        </button>
      )}

      {/* Список кампаний */}
      {channel.campaigns.length === 0 ? (
        <div className="rounded-2xl bg-tg-surface p-4 text-center">
          <Sparkle className="mx-auto h-5 w-5 text-tg-hint" />
          <p className="mt-2 text-[13px] leading-snug text-tg-text2">
            Кампаний пока нет. Создайте первую — карточка вашего канала появится в лентах
            читателей, а платёж спишется только за реальных людей.
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {channel.campaigns.map((c) => (
            <CampaignCard key={c.id} campaign={c} reload={reload} />
          ))}
        </div>
      )}
    </div>
  )
}

function TopUpButton() {
  return (
    <button
      type="button"
      onClick={() => {
        haptic('light')
        openTelegram(`https://t.me/${CREATOR}`)
      }}
      className="rounded-full bg-tg-star/15 px-4 py-2 text-[13px] font-semibold text-tg-star transition active:scale-95"
    >
      Пополнить
    </button>
  )
}

function CampaignForm({
  channel,
  onCancel,
  onCreated,
}: {
  channel: MyChannelDTO
  onCancel: () => void
  onCreated: () => void
}) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [cta, setCta] = useState('Подписаться')
  const [link, setLink] = useState(`https://t.me/${channel.username}`)
  const [cpc, setCpc] = useState(300)
  const [budget, setBudget] = useState(5000)
  const [busy, setBusy] = useState(false)

  const recommended = channel.subscribersCount > 5000 ? 500 : 300

  const submit = async () => {
    if (title.trim().length < 4 || body.trim().length < 4) {
      toast.error('Заполните заголовок и текст карточки')
      return
    }
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
      toast.success('Кампания отправлена на модерацию')
      onCreated()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось создать кампанию')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-2xl bg-tg-surface p-4">
      <div className="text-[15.5px] font-bold text-tg-text">Новая кампания</div>

      <div className="mt-3 space-y-3">
        <Field label="Заголовок карточки">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={80}
            placeholder={channel.title}
            className={inputCls}
          />
        </Field>
        <Field label="Текст карточки">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={200}
            rows={2}
            placeholder={`Коротко о канале «${channel.title}»: почему стоит подписаться`}
            className={cn(inputCls, 'h-auto py-2.5')}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Кнопка">
            <input value={cta} onChange={(e) => setCta(e.target.value)} maxLength={24} className={inputCls} />
          </Field>
          <Field label="Цена за переход">
            <div className="relative">
              <input
                type="number"
                min={100}
                max={10000}
                step={50}
                value={cpc / 100}
                onChange={(e) => setCpc(Math.round(Number(e.target.value) * 100))}
                className={cn(inputCls, 'pr-8')}
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] text-tg-hint">
                ₽
              </span>
            </div>
          </Field>
        </div>
        <p className="-mt-1 text-[12px] leading-snug text-tg-hint">
          Рекомендуем {recommended / 100} ₽ — по вашей категории и охвату. Чем выше цена,
          тем чаще карточка выигрывает ротацию.
        </p>
        <Field label="Бюджет кампании">
          <div className="relative">
            <input
              type="number"
              min={50}
              max={50000}
              step={50}
              value={budget / 100}
              onChange={(e) => setBudget(Math.round(Number(e.target.value) * 100))}
              className={cn(inputCls, 'pr-8')}
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] text-tg-hint">
              ₽
            </span>
          </div>
        </Field>
        <p className="-mt-1 text-[12px] leading-snug text-tg-hint">
          Хватит примерно на {Math.floor(budget / cpc)} переходов · ссылка: {link}
        </p>

        <div className="flex gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            className="h-11 flex-1 rounded-xl bg-tg-sep/50 text-[14.5px] font-semibold text-tg-text2 transition active:scale-[0.98]"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="flex h-11 flex-[1.6] items-center justify-center gap-2 rounded-xl bg-tg-link text-[14.5px] font-bold text-white transition active:scale-[0.98] disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-4.5 w-4.5 animate-spin" /> : null}
            Отправить
          </button>
        </div>
      </div>
    </div>
  )
}

const inputCls =
  'h-10 w-full rounded-xl bg-tg-bg px-3.5 text-[14.5px] text-tg-text outline-none ring-1 ring-tg-sep placeholder:text-tg-hint/70 focus:ring-tg-link'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[12px] font-medium text-tg-hint">{label}</div>
      {children}
    </div>
  )
}

function CampaignCard({ campaign, reload }: { campaign: PostCampaignDTO; reload: () => void }) {
  const [busy, setBusy] = useState(false)
  const ctr = campaign.impressions > 0 ? (campaign.clicks / campaign.impressions) * 100 : 0
  const progress = campaign.budgetKop > 0 ? Math.min(100, (campaign.spentKop / campaign.budgetKop) * 100) : 0

  const act = async (action: 'pause' | 'resume' | 'cancel') => {
    if (action === 'cancel' && !window.confirm('Завершить кампанию и вернуть остаток бюджета?')) return
    setBusy(true)
    try {
      await api('/api/campaigns', {
        method: 'PATCH',
        body: JSON.stringify({ id: campaign.id, action }),
      })
      haptic('light')
      reload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не получилось')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-2xl bg-tg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[14.5px] font-bold text-tg-text">{campaign.title}</div>
          <div className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-tg-hint">
            {campaign.body}
          </div>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold',
            STATUS_STYLE[campaign.status] ?? 'bg-tg-sep text-tg-hint',
          )}
        >
          {STATUS_LABEL[campaign.status] ?? campaign.status}
        </span>
      </div>

      {/* Расход бюджета */}
      <div className="mt-3">
        <div className="flex items-baseline justify-between text-[12px] text-tg-hint">
          <span>
            {formatKop(campaign.spentKop)} из {formatKop(campaign.budgetKop)} · {campaign.costPerClickKop / 100} ₽ за переход
          </span>
          <span className="tabular-nums">{Math.round(progress)}%</span>
        </div>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-tg-sep/60">
          <div
            className="h-full rounded-full bg-tg-link transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-1.5 text-center">
        <Metric v={formatCount(campaign.impressions)} l="показов" />
        <Metric v={formatCount(campaign.clicks)} l="переходов" />
        <Metric v={`${ctr.toFixed(1)}%`} l="CTR" />
        <Metric v={formatCount(campaign.rawClicks - campaign.clicks)} l="повторов" />
      </div>

      {(campaign.status === 'active' || campaign.status === 'paused') && (
        <div className="mt-3 flex gap-2">
          {campaign.status === 'active' ? (
            <MiniBtn onClick={() => act('pause')} disabled={busy}>
              Пауза
            </MiniBtn>
          ) : (
            <MiniBtn onClick={() => act('resume')} disabled={busy}>
              Возобновить
            </MiniBtn>
          )}
          <MiniBtn onClick={() => act('cancel')} disabled={busy} danger>
            Завершить
          </MiniBtn>
        </div>
      )}
      {campaign.status === 'rejected' && campaign.note && (
        <p className="mt-2.5 rounded-lg bg-tg-bg p-2.5 text-[12px] leading-snug text-tg-hint">
          Причина: {campaign.note}
        </p>
      )}
    </div>
  )
}

type PostCampaignDTO = MyChannelDTO['campaigns'][number]

function Metric({ v, l }: { v: string; l: string }) {
  return (
    <div className="rounded-lg bg-tg-bg py-2">
      <div className="text-[13.5px] font-bold leading-none text-tg-text tabular-nums">{v}</div>
      <div className="mt-0.5 text-[10px] leading-tight text-tg-hint">{l}</div>
    </div>
  )
}

function MiniBtn({
  children,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'h-9 flex-1 rounded-lg text-[13px] font-semibold transition active:scale-95 disabled:opacity-50',
        danger ? 'bg-red-500/10 text-red-600 dark:text-red-400' : 'bg-tg-sep/50 text-tg-text2',
      )}
    >
      {children}
    </button>
  )
}
