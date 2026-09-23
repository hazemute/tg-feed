'use client'

/**
 * v6.1: РАЗДЕЛ «Доход» кабинета канала (ChannelTab → CHANNEL_SECTIONS).
 *
 * Четыре карточки-блока:
 *   1. Верификация — галочка на 30 дней (с баланса или счётом Platega).
 *   2. Буст каталога — канал пиннится в топ каталога (1 день / 7 дней).
 *   3. Платные подписчики — цена за месяц, выгоды, статистика и шпаргалка.
 *   4. Биржа взаимопиара — входящие/исходящие заявки + кандидаты.
 *
 * Данные: GET /api/mychannel/monetize (кэш 15с, как у /api/mychannel);
 * после каждого POST — инвалидация кэша и перезагрузка. method:'card'
 * возвращает redirect — тост «Счёт создан, открываем оплату» + window.open.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  BadgeCheck,
  Check,
  Crown,
  Handshake,
  Loader2,
  Rocket,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api, apiCached, invalidateApiCache } from '@/lib/api'
import { haptic } from '@/lib/tg'
import { formatCount } from '@/lib/format'
import { Avatar } from '@/components/tg/Avatar'
import type { MyChannelDTO } from '@/lib/types'

/* ----------------------------- Типы ответа ----------------------------- */

type MonetizeChannel = {
  id: string
  title: string
  username: string
  avatarColor: string
  avatarUrl: string | null
  photoFileId: string | null
  verifiedAdmin: boolean
  verifiedPaid: boolean
  verifiedUntil: string | null
  boostActive: boolean
  boostUntil: string | null
  membershipPriceKop: number | null
  memberBenefits: string | null
  membersCount: number
  audience: number
}

type CrossChannel = {
  id: string
  title: string
  username: string
  avatarColor: string
  avatarUrl: string | null
  photoFileId: string | null
  audience: number
}

type MonetizeData = {
  ok: true
  verify: { priceKop: number; days: number }
  boost: { plans: { id: 'd1' | 'd7'; days: number; priceKop: number; label: string }[] }
  membership: {
    presets: number[]
    minKop: number
    maxKop: number
    authorShare: number
    income30Kop: number
  }
  channels: MonetizeChannel[]
  crosspromo: {
    incoming: { id: string; message: string | null; createdAt: string; channel: CrossChannel }[]
    outgoing: {
      id: string
      status: 'PENDING' | 'ACCEPTED' | 'DECLINED'
      createdAt: string
      message: string | null
      channel: CrossChannel
    }[]
    candidates: CrossChannel[]
  }
  wallet: { balanceKop: number }
  methods: { card: boolean; stars: boolean; ton: boolean; sbp: boolean }
}

/* ----------------------------- Хелперы ----------------------------- */

/** Деньги из копеек: 49000 → «490 ₽», 123456 → «1 234,56 ₽» */
function fmtRub(kop: number): string {
  const v = Math.abs(kop) / 100
  const int = Math.floor(v)
  const frac = Math.round((v - int) * 100)
  const intSpaced = String(int).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return frac > 0 ? `${intSpaced},${String(frac).padStart(2, '0')} ₽` : `${intSpaced} ₽`
}

/** «активна до 12 марта» */
function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
}

function StatusPill({ tone, children }: { tone: 'ok' | 'off'; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-bold leading-none',
        tone === 'ok' ? 'bg-emerald-500/15 text-emerald-600' : 'bg-tg-surface2 text-tg-hint',
      )}
    >
      {children}
    </span>
  )
}

/** Компактный выбор способа оплаты (С баланса / Картой) — как пилюли кабинета */
function MethodPicker({
  value,
  onChange,
  disabled,
}: {
  value: 'balance' | 'card'
  onChange: (m: 'balance' | 'card') => void
  disabled?: boolean
}) {
  return (
    <div className="flex gap-1.5" role="radiogroup" aria-label="Способ оплаты">
      {(
        [
          { id: 'balance', label: 'С баланса' },
          { id: 'card', label: 'Картой' },
        ] as const
      ).map((m) => (
        <button
          key={m.id}
          type="button"
          role="radio"
          aria-checked={value === m.id}
          disabled={disabled}
          onClick={() => {
            haptic('light')
            onChange(m.id)
          }}
          className={cn(
            'flex h-8 items-center rounded-full px-3 text-[12.5px] font-semibold transition active:scale-95 disabled:opacity-50',
            value === m.id ? 'bg-tg-link text-white' : 'bg-tg-surface2 text-tg-hint',
          )}
        >
          {m.label}
        </button>
      ))}
    </div>
  )
}

function CardHead({
  icon: Icon,
  title,
  right,
}: {
  icon: typeof BadgeCheck
  title: string
  right?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-tg-link/12">
        <Icon className="h-5 w-5 text-tg-link" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 text-[15.5px] font-bold text-tg-text">{title}</span>
      {right}
    </div>
  )
}

/* ----------------------------- Секция ----------------------------- */

export function MonetizeSection({
  channel,
  onReload,
}: {
  channel: MyChannelDTO | null
  onReload?: () => void
}) {
  const [data, setData] = useState<MonetizeData | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  /** Ключ выполняемого действия (verify / boost:d1 / mem / off / cross:…) — блокирует кнопки */
  const [busy, setBusy] = useState<string | null>(null)
  const [method, setMethod] = useState<'balance' | 'card'>('balance')

  const load = useCallback(async () => {
    try {
      const r = await apiCached<MonetizeData>('/api/mychannel/monetize', 15_000)
      setData(r)
      setFailed(false)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** POST + тост + перезагрузка состояния (и кабинета сверху, если передан onReload) */
  const act = useCallback(
    async (
      body: Record<string, unknown>,
      successMsg: string,
      key: string,
      extra?: (r: { via?: 'balance' | 'card'; redirect?: string }) => void,
    ) => {
      if (busy) return
      setBusy(key)
      try {
        const r = await api<{ ok: true; via?: 'balance' | 'card'; redirect?: string }>(
          '/api/mychannel/monetize',
          { method: 'POST', body: JSON.stringify(body) },
        )
        haptic('success')
        if (r.via === 'card' && r.redirect) {
          toast.success('Счёт создан, открываем оплату')
          window.open(r.redirect, '_blank', 'noopener')
        } else {
          toast.success(successMsg)
        }
        extra?.(r)
        invalidateApiCache('/api/mychannel/monetize')
        await load()
        onReload?.()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Не получилось')
      } finally {
        setBusy(null)
      }
    },
    [busy, load, onReload],
  )

  /* Состояние активного канала из ответа монетизации (фолбэк — DTO кабинета) */
  const mc = data?.channels.find((c) => c.id === channel?.id) ?? null
  const chId = channel?.id ?? null

  const verifiedActive = mc
    ? mc.verifiedAdmin || Boolean(mc.verifiedUntil && new Date(mc.verifiedUntil).getTime() > Date.now())
    : Boolean(channel && (channel.verifiedAdmin || channel.verified))
  const verifiedUntil = mc?.verifiedUntil ?? channel?.verifiedUntil ?? null
  const boostActive = mc ? mc.boostActive : Boolean(channel?.boostActive)
  const boostUntil = mc?.boostUntil ?? channel?.boostUntil ?? null
  const memPrice = mc ? mc.membershipPriceKop : (channel?.membershipPriceKop ?? null)
  const memBenefits = mc ? mc.memberBenefits : (channel?.memberBenefits ?? null)

  /* Заглушка: канал не привязан */
  if (!channel || !chId) {
    return (
      <div className="flex flex-col items-center gap-2.5 rounded-2xl border border-tg-sep/50 bg-tg-surface/70 px-4 py-10 text-center">
        <span className="flex size-14 items-center justify-center rounded-full bg-tg-link/10 text-tg-link" aria-hidden>
          <Crown className="size-7" strokeWidth={1.7} />
        </span>
        <p className="text-[15px] font-semibold text-tg-text">Сначала привяжите канал</p>
        <p className="max-w-[300px] text-[13px] leading-snug text-tg-hint">
          Верификация, буст и платные подписчики появятся после привязки @канала в разделе «Мой канал»
        </p>
      </div>
    )
  }

  /* Скелетон / сбой */
  if (loading && !data) {
    return (
      <div className="space-y-3" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="tg-shimmer h-32 rounded-2xl" />
        ))}
      </div>
    )
  }
  if (failed && !data) {
    return (
      <button
        type="button"
        onClick={() => {
          haptic('light')
          setLoading(true)
          void load()
        }}
        className="w-full rounded-2xl bg-tg-surface px-4 py-5 text-[14px] font-medium text-tg-hint"
      >
        Не удалось загрузить · Повторить
      </button>
    )
  }

  const verifyPrice = data?.verify.priceKop ?? 49_000
  const verifyDays = data?.verify.days ?? 30
  const balanceKop = data?.wallet.balanceKop ?? 0
  const income30 = data?.membership.income30Kop ?? 0
  const sharePct = Math.round((data?.membership.authorShare ?? 0.7) * 100)
  const defaultPreset = data?.membership.presets[0] ?? 4_900

  return (
    <div className="space-y-3.5">
      {/* 1 — Верификация */}
      <section className="rounded-2xl border border-tg-sep/50 bg-tg-surface/70 p-4">
        <CardHead
          icon={BadgeCheck}
          title="Верификация"
          right={
            verifiedActive ? (
              <StatusPill tone="ok">
                <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
                Активна{verifiedUntil ? ` до ${fmtDay(verifiedUntil)}` : ''}
              </StatusPill>
            ) : (
              <StatusPill tone="off">Не активна</StatusPill>
            )
          }
        />
        <p className="mt-2.5 text-[13px] leading-snug text-tg-hint">
          Галочка в каталоге и у названия канала. {fmtRub(verifyPrice)} / {verifyDays} дней ·
          на балансе {fmtRub(balanceKop)}
        </p>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <MethodPicker value={method} onChange={setMethod} disabled={busy !== null} />
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => {
              haptic('light')
              void act(
                { action: 'buyVerify', channelId: chId, method },
                'Верификация активирована',
                'verify',
              )
            }}
            className="press flex h-10 min-w-[140px] items-center justify-center gap-1.5 rounded-full bg-tg-link px-5 text-[14px] font-bold text-white transition active:scale-[0.98] disabled:opacity-60"
          >
            {busy === 'verify' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            Активировать
          </button>
        </div>
      </section>

      {/* 2 — Буст каталога */}
      <section className="rounded-2xl border border-tg-sep/50 bg-tg-surface/70 p-4">
        <CardHead
          icon={Rocket}
          title="Буст каталога"
          right={
            boostActive ? (
              <StatusPill tone="ok">
                <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
                {boostUntil ? `Активен до ${fmtDay(boostUntil)}` : 'Активен'}
              </StatusPill>
            ) : (
              <StatusPill tone="off">Не активен</StatusPill>
            )
          }
        />
        <p className="mt-2.5 text-[13px] leading-snug text-tg-hint">
          Канал закрепляется в топе каталога «Поиска», пока буст активен.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {(data?.boost.plans ?? [
            { id: 'd1' as const, days: 1, priceKop: 14_900, label: '1 день' },
            { id: 'd7' as const, days: 7, priceKop: 59_900, label: '7 дней' },
          ]).map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={busy !== null}
              onClick={() => {
                haptic('light')
                void act(
                  { action: 'buyBoost', channelId: chId, plan: p.id, method },
                  `Буст на ${p.label} включён`,
                  `boost:${p.id}`,
                )
              }}
              className="flex h-auto min-h-[64px] flex-col items-center justify-center gap-0.5 rounded-xl bg-tg-surface2 px-3 py-2.5 transition active:scale-[0.97] disabled:opacity-60"
            >
              {busy === `boost:${p.id}` ? (
                <Loader2 className="h-4.5 w-4.5 animate-spin text-tg-link" aria-hidden />
              ) : (
                <>
                  <span className="text-[14px] font-bold text-tg-text">{p.label}</span>
                  <span className="text-[12.5px] font-semibold text-tg-link">
                    {fmtRub(p.priceKop)}
                  </span>
                </>
              )}
            </button>
          ))}
        </div>
        <div className="mt-2.5">
          <MethodPicker value={method} onChange={setMethod} disabled={busy !== null} />
        </div>
      </section>

      {/* 3 — Платные подписчики */}
      <MembershipCard
        channelId={chId}
        priceKop={memPrice}
        benefits={memBenefits}
        membersCount={mc?.membersCount ?? 0}
        income30Kop={income30}
        sharePct={sharePct}
        presets={data?.membership.presets ?? [4_900, 9_900, 19_900, 29_900]}
        minKop={data?.membership.minKop ?? 2_900}
        maxKop={data?.membership.maxKop ?? 299_900}
        defaultPresetKop={defaultPreset}
        busy={busy}
        act={act}
      />

      {/* 4 — Биржа взаимопиара */}
      <CrosspromoCard
        channelId={chId}
        data={data}
        busy={busy}
        act={act}
      />
    </div>
  )
}

/* --------------------- Карточка «Платные подписчики» --------------------- */

function MembershipCard({
  channelId,
  priceKop,
  benefits,
  membersCount,
  income30Kop,
  sharePct,
  presets,
  minKop,
  maxKop,
  defaultPresetKop,
  busy,
  act,
}: {
  channelId: string
  priceKop: number | null
  benefits: string | null
  membersCount: number
  income30Kop: number
  sharePct: number
  presets: number[]
  minKop: number
  maxKop: number
  defaultPresetKop: number
  busy: string | null
  act: MonetizeSectionAct
}) {
  /* null — значение ещё не трогали locally: показываем то, что на сервере */
  const [priceRub, setPriceRub] = useState<string | null>(null)
  const [benefitsDraft, setBenefitsDraft] = useState<string | null>(null)

  const effPrice = priceRub ?? (priceKop != null ? String(priceKop / 100) : String(defaultPresetKop / 100))
  const effBenefits = benefitsDraft ?? (benefits ?? '')
  const enabled = priceKop != null

  const save = () => {
    const rub = Number(String(effPrice).replace(',', '.'))
    if (!Number.isFinite(rub) || rub <= 0) {
      toast.error('Укажите цену подписки')
      return
    }
    const kop = Math.round(rub * 100)
    if (kop < minKop) {
      toast.error(`Минимум ${fmtRub(minKop)} в месяц`)
      return
    }
    if (kop > maxKop) {
      toast.error(`Максимум ${fmtRub(maxKop)} в месяц`)
      return
    }
    haptic('light')
    void act(
      { action: 'membershipSave', channelId, priceKop: kop, benefits: effBenefits.trim() || undefined },
      'Платная подписка включена',
      'mem',
    )
  }

  const turnOff = () => {
    haptic('light')
    void act(
      { action: 'membershipSave', channelId, priceKop: null },
      'Платная подписка выключена',
      'mem-off',
    )
  }

  return (
    <section className="rounded-2xl border border-tg-sep/50 bg-tg-surface/70 p-4">
      <CardHead
        icon={Crown}
        title="Платные подписчики"
        right={
          enabled ? (
            <StatusPill tone="ok">
              <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
              Включена · {fmtRub(priceKop)}/мес
            </StatusPill>
          ) : (
            <StatusPill tone="off">Выключена</StatusPill>
          )
        }
      />

      {/* Статистика */}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-tg-surface2 px-3.5 py-2.5">
          <div className="text-[11.5px] leading-none text-tg-hint">Платных подписчиков</div>
          <div className="mt-1.5 text-[18px] font-bold leading-none text-tg-text">
            {formatCount(membersCount)}
          </div>
        </div>
        <div className="rounded-xl bg-tg-surface2 px-3.5 py-2.5">
          <div className="text-[11.5px] leading-none text-tg-hint">Доход за 30 дней</div>
          <div className="mt-1.5 text-[18px] font-bold leading-none text-tg-text">
            {fmtRub(income30Kop)}
          </div>
        </div>
      </div>

      {/* Цена: пресеты + своя */}
      <div className="mt-3.5">
        <div className="text-[12.5px] font-semibold text-tg-text2">Цена за месяц</div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {presets.map((kop) => {
            const rub = kop / 100
            const active = Number(String(effPrice).replace(',', '.')) === rub
            return (
              <button
                key={kop}
                type="button"
                aria-pressed={active}
                disabled={busy !== null}
                onClick={() => {
                  haptic('light')
                  setPriceRub(String(rub))
                }}
                className={cn(
                  'flex h-9 items-center rounded-full px-3.5 text-[13px] font-semibold transition active:scale-95 disabled:opacity-50',
                  active ? 'bg-tg-link text-white' : 'bg-tg-surface2 text-tg-text2',
                )}
              >
                {fmtRub(kop)}
              </button>
            )
          })}
        </div>
        <div className="relative mt-2">
          <input
            type="number"
            inputMode="decimal"
            min={minKop / 100}
            max={maxKop / 100}
            value={effPrice}
            onChange={(e) => setPriceRub(e.target.value)}
            disabled={busy !== null}
            aria-label="Своя цена подписки в рублях за месяц"
            className="h-11 w-full rounded-xl border border-tg-sep bg-tg-bg pl-3.5 pr-16 text-[15px] font-semibold text-tg-text outline-none transition placeholder:font-normal placeholder:text-tg-hint focus:border-tg-link disabled:opacity-60"
            placeholder="Своя цена"
          />
          <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[13px] text-tg-hint">
            ₽/мес
          </span>
        </div>
      </div>

      {/* Выгоды подписчика */}
      <div className="mt-3">
        <div className="text-[12.5px] font-semibold text-tg-text2">Что получает подписчик</div>
        <textarea
          value={effBenefits}
          onChange={(e) => setBenefitsDraft(e.target.value.slice(0, 300))}
          disabled={busy !== null}
          rows={2}
          maxLength={300}
          aria-label="Что получает платный подписчик"
          placeholder="Закрытые посты, чат с автором, ранний доступ…"
          className="mt-2 w-full resize-none rounded-xl border border-tg-sep bg-tg-bg px-3.5 py-2.5 text-[14px] leading-snug text-tg-text outline-none transition placeholder:text-tg-hint focus:border-tg-link disabled:opacity-60"
        />
      </div>

      {/* Кнопки */}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={save}
          className="press flex h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full bg-tg-link text-[14.5px] font-bold text-white transition active:scale-[0.98] disabled:opacity-60"
        >
          {busy === 'mem' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {enabled ? 'Сохранить' : `Включить · ${fmtRub(Math.round(Number(String(effPrice).replace(',', '.') || 0) * 100))}`}
        </button>
        {enabled && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={turnOff}
            className="flex h-11 shrink-0 items-center justify-center gap-1 rounded-full bg-tg-surface2 px-4 text-[13.5px] font-semibold text-tg-hint transition active:scale-95 disabled:opacity-60"
          >
            {busy === 'mem-off' ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <X className="h-4 w-4" aria-hidden />
            )}
            Выключить
          </button>
        )}
      </div>

      {/* Шпаргалка */}
      <p className="mt-3 rounded-xl bg-tg-link/10 px-3.5 py-2.5 text-[12.5px] leading-snug text-tg-text2">
        Вы получаете {sharePct}% с каждой подписки — выплата сразу на кошелёк. Закрытые посты
        помечайте в разделе «Промо».
      </p>
    </section>
  )
}

type MonetizeSectionAct = (
  body: Record<string, unknown>,
  successMsg: string,
  key: string,
  extra?: (r: { via?: 'balance' | 'card'; redirect?: string }) => void,
) => Promise<void>

/* --------------------- Карточка «Биржа взаимопиара» --------------------- */

const CROSS_STATUS: Record<string, { label: string; cls: string }> = {
  PENDING: { label: 'Ожидает ответа', cls: 'bg-amber-500/15 text-amber-600' },
  ACCEPTED: { label: 'Принята', cls: 'bg-emerald-500/15 text-emerald-600' },
  DECLINED: { label: 'Отклонена', cls: 'bg-tg-surface2 text-tg-hint' },
}

function CrosspromoCard({
  channelId,
  data,
  busy,
  act,
}: {
  channelId: string
  data: MonetizeData | null
  busy: string | null
  act: MonetizeSectionAct
}) {
  const incoming = data?.crosspromo.incoming ?? []
  const outgoing = data?.crosspromo.outgoing ?? []
  const candidates = data?.crosspromo.candidates ?? []

  return (
    <section className="rounded-2xl border border-tg-sep/50 bg-tg-surface/70 p-4">
      <CardHead icon={Handshake} title="Биржа взаимопиара" />
      <p className="mt-2.5 text-[13px] leading-snug text-tg-hint">
        Обменивайтесь постами с каналами близкой аудитории — заявка уйдёт владельцу канала.
      </p>

      {/* Входящие */}
      {incoming.length > 0 && (
        <div className="mt-3.5">
          <div className="text-[12.5px] font-semibold text-tg-text2">
            Входящие заявки · {incoming.length}
          </div>
          <div className="mt-2 space-y-2">
            {incoming.map((o) => (
              <div key={o.id} className="rounded-xl bg-tg-surface2 p-3">
                <div className="flex items-center gap-2.5">
                  <Avatar name={o.channel.title} color={o.channel.avatarColor} src={o.channel.avatarUrl} size={38} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-bold leading-tight text-tg-text">
                      {o.channel.title}
                    </div>
                    <div className="truncate text-[12px] text-tg-hint">
                      @{o.channel.username} · {formatCount(o.channel.audience)} подписчиков
                    </div>
                  </div>
                </div>
                {o.message && (
                  <p className="mt-2 text-[13px] leading-snug text-tg-text2">«{o.message}»</p>
                )}
                <div className="mt-2.5 flex gap-2">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => {
                      haptic('light')
                      void act(
                        { action: 'crosspromoRespond', offerId: o.id, accept: true },
                        'Заявка принята — договоритесь о постах',
                        `cross:${o.id}`,
                      )
                    }}
                    className="flex h-9 min-w-0 flex-1 items-center justify-center gap-1 rounded-full bg-tg-link text-[13px] font-bold text-white transition active:scale-[0.97] disabled:opacity-60"
                  >
                    {busy === `cross:${o.id}` ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    ) : (
                      <Check className="h-4 w-4" aria-hidden />
                    )}
                    Принять
                  </button>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => {
                      haptic('light')
                      void act(
                        { action: 'crosspromoRespond', offerId: o.id, accept: false },
                        'Заявка отклонена',
                        `cross:${o.id}`,
                      )
                    }}
                    className="flex h-9 items-center justify-center rounded-full bg-tg-bg px-4 text-[13px] font-semibold text-tg-hint transition active:scale-95 disabled:opacity-60"
                  >
                    Отклонить
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Исходящие */}
      {outgoing.length > 0 && (
        <div className="mt-3.5">
          <div className="text-[12.5px] font-semibold text-tg-text2">
            Мои заявки · {outgoing.length}
          </div>
          <div className="mt-2 space-y-2">
            {outgoing.map((o) => {
              const st = CROSS_STATUS[o.status] ?? CROSS_STATUS.PENDING
              return (
                <div key={o.id} className="flex items-center gap-2.5 rounded-xl bg-tg-surface2 p-2.5">
                  <Avatar name={o.channel.title} color={o.channel.avatarColor} src={o.channel.avatarUrl} size={34} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-bold leading-tight text-tg-text">
                      {o.channel.title}
                    </div>
                    <div className="truncate text-[11.5px] text-tg-hint">
                      @{o.channel.username} · {formatCount(o.channel.audience)} подписчиков
                    </div>
                  </div>
                  <span
                    className={cn(
                      'shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold leading-none',
                      st.cls,
                    )}
                  >
                    {st.label}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Кандидаты — горизонтальный скролл */}
      <div className="mt-3.5">
        <div className="text-[12.5px] font-semibold text-tg-text2">Возможные партнёры</div>
        {candidates.length === 0 ? (
          <p className="mt-2 text-[12.5px] leading-snug text-tg-hint">
            Пока нет каналов подходящего размера — они появятся, когда площадка вырастет.
          </p>
        ) : (
          <div
            className="no-scrollbar -mx-1 mt-2 flex gap-2 overflow-x-auto px-1 pb-1"
            data-hscroll
            role="list"
            aria-label="Возможные партнёры по взаимопиару"
          >
            {candidates.map((c) => (
              <div
                key={c.id}
                role="listitem"
                className="flex w-[136px] shrink-0 flex-col items-center gap-1.5 rounded-xl bg-tg-surface2 px-3 py-3 text-center"
              >
                <Avatar name={c.title} color={c.avatarColor} src={c.avatarUrl} size={44} />
                <span className="line-clamp-1 w-full text-[13px] font-bold leading-tight text-tg-text">
                  {c.title}
                </span>
                <span className="w-full truncate text-[11px] text-tg-hint">@{c.username}</span>
                <span className="text-[11px] leading-none text-tg-hint">
                  {formatCount(c.audience)} подписчиков
                </span>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => {
                    haptic('light')
                    void act(
                      { action: 'crosspromoSend', channelId, targetChannelId: c.id },
                      `Заявка отправлена «${c.title}»`,
                      `cross-send:${c.id}`,
                    )
                  }}
                  className="mt-0.5 flex h-8 w-full items-center justify-center gap-1 rounded-full bg-tg-link/12 text-[12.5px] font-bold text-tg-link transition active:scale-95 disabled:opacity-60"
                >
                  {busy === `cross-send:${c.id}` ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <Handshake className="h-3.5 w-3.5" aria-hidden />
                  )}
                  Предложить
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
