'use client'

import { useCallback, useEffect, useState } from 'react'
import { Bot, Loader2, PlugZap, RefreshCw, Send, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

import { panelFetch } from './api'
import type { TabProps } from './bits'

type BotSlot = { slot: string; label: string; emoji: string; customEmojiId: string }

type BotConfig = {
  business: { id: string; userId: number; isEnabled: boolean; updatedAt: string } | null
  slots: BotSlot[]
  ownerChatId: number
  premiumCount: number
}

const VIA_LABEL: Record<string, string> = {
  business: 'через premium-аккаунт (business) — эмодзи анимированные',
  bot_premium: 'самим ботом (кастом-эмодзи применены)',
  bot_plain: 'обычным текстом (премиум недоступен — эмодзи стандартные)',
}

export function BotTab({ tick, onSettled }: TabProps) {
  const [data, setData] = useState<BotConfig | null>(null)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [businessId, setBusinessId] = useState('')
  const [via, setVia] = useState<string | null>(null)

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

  const runTest = async () => {
    setTesting(true)
    setVia(null)
    try {
      const r = await panelFetch<{ ok: boolean; via: string }>('/api/panel/bot', { json: { action: 'test' } })
      setVia(VIA_LABEL[r.via] ?? r.via)
      toast.success('Тест отправлен в чат владельца')
    } catch (e) {
      toast.error((e as Error).message || 'Тест не удался')
    } finally {
      setTesting(false)
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
            </p>
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

          {/* Слоты эмодзи */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-slate-800">Слоты эмодзи</h3>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
                премиум-слотов: {data.premiumCount}/{data.slots.length}
              </span>
            </div>
            <p className="max-w-2xl text-xs leading-relaxed text-slate-500">
              Перешлите сообщение с нужным премиум-эмодзи боту <b>@username_to_id_bot</b> или возьмите
              custom_emoji_id через @idstickerbot → «Custom Emoji». Вставьте ID в слот — тексты бота
              заменяют соответствующее эмодзи на анимированное. Пусто → обычное эмодзи.
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
            <span className="text-xs text-slate-500">→ чат {data.ownerChatId}</span>
            {via && <span className="text-xs font-medium text-emerald-700">ушло {via}</span>}
          </div>
        </>
      )}
    </section>
  )
}
