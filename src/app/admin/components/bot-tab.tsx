'use client'

import { useCallback, useEffect, useState } from 'react'
import { Bot, Inbox, ImageIcon, Loader2, PlugZap, RefreshCw, Send, Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

import { panelFetch } from './api'
import type { TabProps } from './bits'

type BotSlot = { slot: string; label: string; emoji: string; customEmojiId: string }

type CapturedEmoji = {
  id: string
  emoji: string
  fromId: number
  fromName: string
  at: string
}

type BotConfig = {
  business: { id: string; userId: number; isEnabled: boolean; updatedAt: string } | null
  slots: BotSlot[]
  captured: CapturedEmoji[]
  ownerChatId: number
  premiumCount: number
  dmNotifyOff: boolean
}

const VIA_LABEL: Record<string, string> = {
  business: 'через premium-аккаунт (business) — эмодзи анимированные',
  bot_premium: 'самим ботом (кастом-эмодзи применены)',
  bot_plain: 'обычным текстом (премиум недоступен — эмодзи стандартные)',
}

/** Причина, почему тест владельцу не может уйти через business (ограничение Telegram) */
const SELF_SEND_HINT =
  'Telegram запрещает отправку «самому себе»: через посредника бот пишет от вашего имени, а адресат — вы. ' +
  'Анимированные эмодзи через посредника работают только в ваших личных чатах с другими людьми. ' +
  'Для анимации в сообщениях бота нужен Fragment-username у бота.'

export function BotTab({ tick, onSettled }: TabProps) {
  const [data, setData] = useState<BotConfig | null>(null)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [businessId, setBusinessId] = useState('')
  const [via, setVia] = useState<string | null>(null)
  const [viaWarn, setViaWarn] = useState<string | null>(null)
  const [bcChecking, setBcChecking] = useState(false)
  const [bcVerdict, setBcVerdict] = useState<string | null>(null)
  const [probing, setProbing] = useState(false)
  const [photoTesting, setPhotoTesting] = useState(false)
  const [adoptSlot, setAdoptSlot] = useState<Record<string, string>>({})

  const load = useCallback(() => {
    setFailed(false)
    panelFetch<BotConfig>('/api/panel/bot')
      .then((d) => {
        setData(d)
        setBusinessId(d.business?.isEnabled ? d.business.id : '')
      })
      .catch(() => setFailed(true))
      .finally(() => onSettled())
  }, [onSettled])

  useEffect(load, [load, tick])

  const saveSlot = async (slot: string, customEmojiId: string) => {
    setSaving(slot)
    try {
      await panelFetch('/api/panel/bot', { json: { action: 'slot', slot, customEmojiId } })
      toast.success(customEmojiId ? 'Слот сохранён — эмодзи проверены в Telegram' : 'Слот очищен — обычное эмодзи')
      load()
    } catch (e) {
      toast.error((e as Error).message || 'Не удалось сохранить')
    } finally {
      setSaving(null)
    }
  }

  const adoptCaptured = async (c: CapturedEmoji, slot: string) => {
    if (!slot) {
      toast.error('Выберите слот для переноса')
      return
    }
    setSaving(`adopt-${c.id}`)
    try {
      await panelFetch('/api/panel/bot', {
        json: { action: 'adopt', slot, customEmojiId: c.id, emoji: c.emoji },
      })
      toast.success(`${c.emoji} → слот «${slot}» — символ эмодзи слота обновлён`)
      load()
    } catch (e) {
      toast.error((e as Error).message || 'Не удалось перенести в слот')
    } finally {
      setSaving(null)
    }
  }

  const forgetCaptured = async (c: CapturedEmoji) => {
    setSaving(`forget-${c.id}`)
    try {
      await panelFetch('/api/panel/bot', { json: { action: 'forget', customEmojiId: c.id } })
      toast.success('Запись удалена из захваченных')
      load()
    } catch (e) {
      toast.error((e as Error).message || 'Не удалось удалить')
    } finally {
      setSaving(null)
    }
  }

  /** v6.1.1: рубильник ВСЕХ ЛС-уведомлений (глобальный антиспам) */
  const toggleDmNotify = async () => {
    if (!data) return
    const off = !data.dmNotifyOff
    setSaving('dm_notify')
    try {
      await panelFetch('/api/panel/bot', { json: { action: 'dm_notify', off } })
      setData({ ...data, dmNotifyOff: off })
      toast.success(off ? 'ЛС-уведомления заглушены — бот молчит во всех личках' : 'ЛС-уведомления включены')
    } catch (e) {
      toast.error((e as Error).message || 'Не удалось изменить')
    } finally {
      setSaving(null)
    }
  }

  const runRichProbe = async () => {
    setProbing(true)
    try {
      const r = await panelFetch<{ ok: boolean; raw: { ok?: boolean; description?: string } | null }>(
        '/api/panel/bot',
        { json: { action: 'richprobe' } },
      )
      if (r.raw?.ok) toast.success('Rich-сообщение отправлено — проверьте чат (кнопки со стилями)')
      else toast.error(`Telegram: ${r.raw?.description ?? 'sendRichMessage недоступен'}`)
    } catch (e) {
      toast.error((e as Error).message || 'Проба не удалась')
    } finally {
      setProbing(false)
    }
  }

  const runPhotoTest = async () => {
    setPhotoTesting(true)
    try {
      const r = await panelFetch<{ ok: boolean; via: string }>('/api/panel/bot', {
        json: { action: 'testphoto' },
      })
      toast.success(`Фото-/start отправлен (${r.via === 'photo' ? 'картинка + подпись' : 'текстом — фолбэк'})`)
    } catch (e) {
      toast.error((e as Error).message || 'Фото-тест не удался')
    } finally {
      setPhotoTesting(false)
    }
  }

  const runTest = async () => {
    setTesting(true)
    setVia(null)
    setViaWarn(null)
    try {
      const r = await panelFetch<{
        ok: boolean
        via: string
        businessError?: string | null
        premiumError?: string | null
      }>('/api/panel/bot', { json: { action: 'test' } })
      setVia(VIA_LABEL[r.via] ?? r.via)
      if (r.via !== 'business' && r.businessError?.includes('must not be sent to self')) {
        setViaWarn(SELF_SEND_HINT)
      } else if (r.via !== 'business' && r.businessError) {
        setViaWarn(`business-канал: ${r.businessError}`)
      }
      toast.success('Тест отправлен в чат владельца')
    } catch (e) {
      toast.error((e as Error).message || 'Тест не удался')
    } finally {
      setTesting(false)
    }
  }

  const checkBusiness = async () => {
    setBcChecking(true)
    setBcVerdict(null)
    try {
      const r = await panelFetch<{
        ok: boolean
        telegram: { ok?: boolean; result?: { is_enabled?: boolean; rights?: { can_reply?: boolean } }; description?: string } | null
        note?: string
      }>('/api/panel/bot', { json: { action: 'getbc' } })
      const t = r.telegram
      if (!t) setBcVerdict(r.note ?? 'Telegram не вернул ответ')
      else if (t.ok && t.result)
        setBcVerdict(
          `Telegram: подключение ${t.result.is_enabled ? 'активно' : 'выключено'}${
            t.result.rights?.can_reply === false ? ', без права писать' : ', право писать есть'
          }`,
        )
      else setBcVerdict(`Telegram: ошибка — ${t.description ?? 'неизвестно'}`)
    } catch (e) {
      setBcVerdict((e as Error).message || 'Проверка не удалась')
    } finally {
      setBcChecking(false)
    }
  }

  const saveBusiness = async () => {
    setSaving('business')
    try {
      await panelFetch('/api/panel/bot', { json: { action: 'business', id: businessId || null } })
      toast.success(businessId ? 'Business-connection задан' : 'Business-connection сброшен')
      load()
    } catch (e) {
      toast.error((e as Error).message || 'Не удалось сохранить')
    } finally {
      setSaving(null)
    }
  }

  return (
    <section className="space-y-6" aria-label="Бот">
      <header className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700">
          <Bot className="size-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-slate-900">Премиум-эмодзи бота</h2>
          <p className="text-xs text-slate-500">
            Кастом-эмодзи в сообщениях бота: слоты → custom_emoji_id из премиум-паков
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          aria-label="Обновить"
          className="ml-auto flex size-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"
        >
          <RefreshCw className={cn('size-4', !data && !failed && 'animate-spin')} aria-hidden />
        </button>
      </header>

      {failed && (
        <p className="text-sm text-red-600" role="alert">
          Не удалось загрузить конфигурацию — попробуйте «Обновить».
        </p>
      )}

      {data && (
        <>
          {/* Подключение посредника */}
          <div className="space-y-2 border-b border-slate-200 pb-5">
            <div className="flex items-center gap-2">
              <PlugZap className="size-4 text-slate-500" aria-hidden />
              <h3 className="text-sm font-semibold text-slate-800">Premium-аккаунт-посредник</h3>
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-[11px] font-medium',
                  data.business?.isEnabled
                    ? 'bg-emerald-50 text-emerald-700'
                    : 'bg-slate-100 text-slate-500',
                )}
              >
                {data.business?.isEnabled ? 'подключён' : 'не подключён'}
              </span>
            </div>
            <p className="max-w-2xl text-xs leading-relaxed text-slate-500">
              Кастом-эмодзи бот отправляет от имени вашего премиум-аккаунта (Telegram Business).
              Подключение: Telegram → Настройки → <b>Telegram Business</b> → Чат-боты → подключите бота.
              Webhook сам сохранит connection_id. Либо вставьте его вручную ниже.
              {data.business && (
                <span className="mt-1 block font-mono text-[11px] text-slate-400">
                  id: {data.business.id || '—'} · user: {data.business.userId} · {data.business.updatedAt.slice(0, 10)}
                </span>
              )}
              <span className="mt-1 block">
                ⚠️ Посредник пишет от вашего имени в ваши личные диалоги — сообщения «самому себе» Telegram
                запрещает, поэтому тест в этот чат всегда уходит обычным текстом. Анимация в сообщениях
                бота всем пользователям возможна только с Fragment-username у бота.
              </span>
            </p>
            {bcVerdict && <p className="text-xs font-medium text-slate-700">{bcVerdict}</p>}
            <button
              type="button"
              onClick={() => void checkBusiness()}
              disabled={bcChecking}
              className="h-8 rounded-md border border-slate-200 px-3 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-50"
            >
              {bcChecking ? 'Проверяем…' : 'Проверить у Telegram'}
            </button>
            <div className="flex max-w-xl items-center gap-2">
              <input
                value={businessId}
                onChange={(e) => setBusinessId(e.target.value)}
                placeholder="business_connection_id (необязательно — приходит сам)"
                className={cn(
                  'h-10 min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-100 px-3 text-sm text-slate-800 outline-none placeholder:text-slate-500 focus:border-emerald-400',
                )}
              />
              <button
                type="button"
                onClick={() => void saveBusiness()}
                disabled={saving === 'business'}
                className="flex h-10 items-center gap-1.5 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-50"
              >
                {saving === 'business' ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
                Сохранить
              </button>
              {data.business?.isEnabled && (
                <button
                  type="button"
                  onClick={() => {
                    setBusinessId('')
                    void saveBusiness()
                  }}
                  aria-label="Сбросить подключение"
                  title="Сбросить"
                  className="flex size-10 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:bg-red-50 hover:text-red-600"
                >
                  <Trash2 className="size-4" />
                </button>
              )}
            </div>
          </div>

          {/* v6.1.1: рубильник ЛС-уведомлений (глобальный антиспам) */}
          <div
            className={cn(
              'flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3',
              data.dmNotifyOff ? 'border-red-200 bg-red-50' : 'border-emerald-200 bg-emerald-50/60',
            )}
          >
            <div className="min-w-56">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                <Inbox className="size-4" />
                ЛС-уведомления от бота
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[11px] font-medium',
                    data.dmNotifyOff ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700',
                  )}
                >
                  {data.dmNotifyOff ? 'ЗАГЛУШЕНЫ' : 'включены'}
                </span>
              </h3>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-500">
                {data.dmNotifyOff
                  ? 'Бот молчит во всех личках: лайки/ответы/награды/достижения — только в инбоксе миниаппа. Реактивация и еженедельный дайджест продолжат приходить.'
                  : 'Лайки/ответы/награды дублируются в личку. Глобальный антиспам: 1 ЛС на комментарий в 6ч, ≤5 лайк-ЛС за 6ч, кап 4/мин — единый лимит на все инстансы.'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void toggleDmNotify()}
              disabled={saving === 'dm_notify'}
              className={cn(
                'flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-medium text-white transition disabled:opacity-50',
                data.dmNotifyOff ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700',
              )}
            >
              {saving === 'dm_notify' ? <Loader2 className="size-4 animate-spin" /> : <Inbox className="size-4" />}
              {data.dmNotifyOff ? 'Включить ЛС' : 'Заглушить ЛС'}
            </button>
          </div>

          {/* Слоты эмодзи */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-slate-800">Слоты эмодзи</h3>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
                премиум-слотов: {data.premiumCount}/{data.slots.length}
              </span>
            </div>
            <p className="max-w-2xl text-xs leading-relaxed text-slate-500">
              Официальный способ узнать custom_emoji_id: отправьте боту в личку сообщение с нужным
              премиум-эмодзи (или перешлите его) — ID появится в «Захваченных» ниже, а вам в чат придёт
              список. Также можно взять ID через @idstickerbot → «Custom Emoji». Вставьте ID в слот —
              тексты бота заменяют соответствующее эмодзи на анимированное. Пусто → обычное эмодзи.
            </p>
            <div className="overflow-hidden rounded-lg border border-slate-200">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-3 py-2 font-medium">Эмодзи</th>
                    <th className="px-3 py-2 font-medium">Слот</th>
                    <th className="px-3 py-2 font-medium">custom_emoji_id</th>
                    <th className="px-3 py-2" aria-hidden />
                  </tr>
                </thead>
                <tbody>
                  {data.slots.map((s) => (
                    <tr key={s.slot} className="border-b border-slate-100 last:border-0">
                      <td className="px-3 py-2 text-lg leading-none">{s.emoji}</td>
                      <td className="px-3 py-2">
                        <span className="font-medium text-slate-800">{s.label}</span>
                        <span className="ml-1.5 font-mono text-[11px] text-slate-400">{s.slot}</span>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          defaultValue={s.customEmojiId}
                          placeholder="—"
                          aria-label={`custom_emoji_id для ${s.label}`}
                          className="h-9 w-full min-w-40 rounded-md border border-slate-200 bg-slate-100 px-2.5 font-mono text-xs text-slate-800 outline-none placeholder:text-slate-400 focus:border-emerald-400"
                          data-slot-input={s.slot}
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => {
                            const input = document.querySelector<HTMLInputElement>(`[data-slot-input="${s.slot}"]`)
                            void saveSlot(s.slot, input?.value.trim() ?? '')
                          }}
                          disabled={saving === s.slot}
                          className="flex h-8 items-center gap-1 rounded-md bg-slate-100 px-2.5 text-xs font-medium text-slate-700 transition hover:bg-slate-200 disabled:opacity-50"
                        >
                          {saving === s.slot ? <Loader2 className="size-3 animate-spin" /> : null}
                          Сохранить
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Захваченные из сообщений */}
          <div className="space-y-3 border-t border-slate-200 pt-5">
            <div className="flex items-center gap-2">
              <Inbox className="size-4 text-slate-500" aria-hidden />
              <h3 className="text-sm font-semibold text-slate-800">Захваченные эмодзи</h3>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
                {data.captured.length}
              </span>
            </div>
            <p className="max-w-2xl text-xs leading-relaxed text-slate-500">
              Пользователь отправляет боту премиум-эмодзи → Telegram передаёт entity
              <code className="mx-1 rounded bg-slate-100 px-1 font-mono text-[11px]">custom_emoji</code>
              с custom_emoji_id — бот сохраняет ID. Владелец получает ответ списком ID, остальные — молча.
            </p>
            {data.captured.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-400">
                Пока пусто — отправьте боту сообщение с премиум-эмодзи
              </p>
            ) : (
              <div className="max-h-96 overflow-y-auto rounded-lg border border-slate-200">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-slate-50">
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="px-3 py-2 font-medium">Эмодзи</th>
                      <th className="px-3 py-2 font-medium">custom_emoji_id</th>
                      <th className="px-3 py-2 font-medium">От кого</th>
                      <th className="px-3 py-2 font-medium">В слот</th>
                      <th className="px-3 py-2" aria-hidden />
                    </tr>
                  </thead>
                  <tbody>
                    {data.captured.map((c) => (
                      <tr key={c.id} className="border-b border-slate-100 last:border-0">
                        <td className="px-3 py-2 text-lg leading-none">{c.emoji}</td>
                        <td className="max-w-52 truncate px-3 py-2 font-mono text-[11px] text-slate-600" title={c.id}>
                          {c.id}
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-500">
                          {c.fromName}
                          <span className="block text-[11px] text-slate-400">{c.at.slice(0, 10)}</span>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1.5">
                            <select
                              value={adoptSlot[c.id] ?? ''}
                              onChange={(e) => setAdoptSlot((m) => ({ ...m, [c.id]: e.target.value }))}
                              aria-label={`Слот для ${c.id}`}
                              className="h-8 max-w-40 rounded-md border border-slate-200 bg-slate-100 px-1.5 text-xs text-slate-700 outline-none focus:border-emerald-400"
                            >
                              <option value="">— слот —</option>
                              {data.slots.map((s) => (
                                <option key={s.slot} value={s.slot}>
                                  {s.emoji} {s.label}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              onClick={() => void adoptCaptured(c, adoptSlot[c.id] ?? '')}
                              disabled={saving === `adopt-${c.id}` || !(adoptSlot[c.id] ?? '')}
                              className="flex h-8 items-center gap-1 rounded-md bg-emerald-600 px-2.5 text-xs font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {saving === `adopt-${c.id}` ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
                              В слот
                            </button>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => void forgetCaptured(c)}
                            disabled={saving === `forget-${c.id}`}
                            aria-label="Удалить из захваченных"
                            title="Удалить"
                            className="flex size-8 items-center justify-center rounded-md text-slate-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                          >
                            {saving === `forget-${c.id}` ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Тест */}
          <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-5">
            <button
              type="button"
              onClick={() => void runTest()}
              disabled={testing}
              className="flex h-10 items-center gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-50"
            >
              {testing ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              Тест-сообщение владельцу
            </button>
            <button
              type="button"
              onClick={() => void runPhotoTest()}
              disabled={photoTesting}
              title="Отправить владельцу приветствие как на /start: картинка + премиум-подпись + кнопки"
              className="flex h-10 items-center gap-2 rounded-lg border border-emerald-600 px-4 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-50 disabled:opacity-50"
            >
              {photoTesting ? <Loader2 className="size-4 animate-spin" /> : <ImageIcon className="size-4" />}
              Фото-тест
            </button>
            <button
              type="button"
              onClick={() => void runRichProbe()}
              disabled={probing}
              title="Новый Bot API: sendRichMessage — кнопки со стилями + кастом-эмодзи внутри кнопки"
              className="flex h-10 items-center gap-2 rounded-lg border border-emerald-600 px-4 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-50 disabled:opacity-50"
            >
              {probing ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              Rich-проба (кнопки)
            </button>
            <span className="text-xs text-slate-500">→ чат {data.ownerChatId}</span>
            {via && (
              <span className={cn('text-xs font-medium', viaWarn ? 'text-amber-700' : 'text-emerald-700')}>
                ушло {via}
              </span>
            )}
            {viaWarn && <p className="w-full max-w-2xl text-xs leading-relaxed text-amber-700">{viaWarn}</p>}
          </div>
        </>
      )}
    </section>
  )
}
