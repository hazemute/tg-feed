'use client'

import { useCallback, useEffect, useState } from 'react'
import { BadgeCheck, Crown, Loader2, RefreshCw, Send, Star } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { formatCount, pluralRu } from '@/lib/format'
import { haptic, openTelegram } from '@/lib/tg'
import type { ChannelDTO } from '@/lib/types'
import { Avatar } from '@/components/tg/Avatar'

const CREATOR = 'tgfeed_creator'

function statusBadge(ch: ChannelDTO) {
  if (ch.isPremium)
    return (
      <span className="flex items-center gap-1 text-[12px] font-medium text-[#b7791f]">
        <Star className="h-3 w-3 fill-[#e8a33d] text-[#e8a33d]" /> Премиум
      </span>
    )
  if (ch.status === 'moderation')
    return (
      <span className="flex items-center gap-1.5 text-[12px] text-[#b7791f]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#e8a33d]" /> На модерации
      </span>
    )
  return (
    <span className="flex items-center gap-1.5 text-[12px] text-tg-green">
      <span className="h-1.5 w-1.5 rounded-full bg-tg-green" /> Активен
    </span>
  )
}

/** Вкладка «Админам»: добавление канала, модерация, продвижение и реклама */
export function AdminTab() {
  const { user } = useApp()
  const [username, setUsername] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [myChannels, setMyChannels] = useState<ChannelDTO[] | null>(null)
  const [parsing, setParsing] = useState(false)

  const loadMine = useCallback(() => {
    if (!user) return
    api<{ items: ChannelDTO[] }>(`/api/admin/channels?userId=${encodeURIComponent(user.id)}`)
      .then((d) => setMyChannels(d.items))
      .catch(() => setMyChannels([]))
  }, [user?.id])  

  useEffect(() => {
    loadMine()
  }, [loadMine])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!user || !username.trim() || submitting) return
    setSubmitting(true)
    setResult(null)
    try {
      const r = await api<{ message: string }>('/api/admin/add_channel', {
        method: 'POST',
        body: JSON.stringify({ userId: user.id, username }),
      })
      setResult({ ok: true, message: r.message })
      setUsername('')
      loadMine()
      haptic('success')
      toast.success('Канал отправлен на модерацию')
    } catch (err) {
      setResult({ ok: false, message: (err as Error).message })
      haptic('error')
    } finally {
      setSubmitting(false)
    }
  }

  const runParser = async () => {
    if (parsing || !user) return
    setParsing(true)
    try {
      const r = await api<{ results: { username: string; added: number; error?: string }[] }>(
        // Ручной запуск — пользовательский эндпоинт с авторизацией по userId;
        // /api/parse — служебный для cron-сервиса (защищён CRON_SECRET)
        '/api/parse/run',
        { method: 'POST', body: JSON.stringify({ userId: user.id }) },
      )
      const added = r.results.reduce((s, x) => s + x.added, 0)
      const errors = r.results.filter((x) => x.error).length
      toast.success(`Парсинг завершён: +${added} постов${errors ? `, ошибок: ${errors}` : ''}`)
      loadMine()
    } catch {
      toast.error('Парсер недоступен — попробуйте позже')
    } finally {
      setParsing(false)
    }
  }

  return (
    <div className="no-scrollbar h-full overflow-y-auto overscroll-contain pb-6">
      <div className="px-4 pb-3 pt-3">
        <h2 className="text-[20px] font-bold tracking-tight">Для админов каналов</h2>
        <p className="mt-0.5 text-[13px] text-tg-gray">
          Добавьте канал в ленту, продвигайте его и зарабатывайте
        </p>
      </div>

      {/* Добавление канала */}
      <section className="px-4">
        <div className="rounded-xl bg-tg-section p-4">
          <h3 className="text-[15px] font-semibold">Добавить свой канал</h3>
          <p className="mt-0.5 text-[13px] leading-snug text-tg-gray">
            Введите публичный @юзернейм канала — после модерации его посты попадут в ленту
          </p>
          <form onSubmit={submit} className="mt-3 flex gap-2">
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="@my_channel"
              aria-label="Юзернейм канала"
              className="h-10 min-w-0 flex-1 rounded-xl border-transparent bg-background px-3.5 text-[14px] outline-none placeholder:text-tg-gray-light focus:border-tg-blue"
            />
            <button
              type="submit"
              disabled={submitting || !username.trim()}
              className={cn(
                'flex h-10 shrink-0 items-center gap-1.5 rounded-xl px-3.5 text-[13px] font-medium transition active:scale-95',
                submitting || !username.trim()
                  ? 'cursor-not-allowed bg-tg-sep text-tg-gray'
                  : 'bg-tg-blue text-white hover:bg-tg-blue-dark',
              )}
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Отправить
            </button>
          </form>
          {result && (
            <p
              className={cn(
                'mt-3 rounded-lg p-2.5 text-[13px] leading-snug',
                result.ok ? 'bg-background text-foreground' : 'bg-background text-[#c0392b]',
              )}
              role="status"
            >
              {result.ok && <BadgeCheck className="mr-1 inline h-4 w-4 text-tg-green" />}
              {result.message}
            </p>
          )}
        </div>
      </section>

      {/* Мои каналы */}
      <section className="px-4 pt-4">
        <h3 className="px-1 pb-1.5 text-[13px] font-semibold uppercase tracking-wide text-tg-gray">
          Мои каналы
        </h3>
        <div className="overflow-hidden rounded-xl bg-tg-section">
          {myChannels === null ? (
            <div className="p-4 text-[13px] text-tg-gray">Загрузка…</div>
          ) : myChannels.length === 0 ? (
            <div className="p-4 text-[13px] leading-snug text-tg-gray">
              Вы ещё не добавляли каналы. Отправьте первый — он появится здесь.
            </div>
          ) : (
            myChannels.map((ch) => (
              <div
                key={ch.id}
                className="flex items-center gap-3 border-b border-background px-3.5 py-2.5 last:border-b-0"
              >
                <Avatar name={ch.title} color={ch.avatarColor} size={42} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium leading-snug">{ch.title}</div>
                  <div className="flex items-center gap-2 text-[12px] text-tg-gray">
                    {statusBadge(ch)}
                    <span>·</span>
                    <span>
                      {ch.postsCount ?? 0}{' '}
                      {pluralRu(ch.postsCount ?? 0, 'пост', 'поста', 'постов')}
                    </span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        <button
          type="button"
          onClick={runParser}
          disabled={parsing}
          className="mt-2.5 flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-tg-sep bg-background text-[13px] font-medium text-tg-blue transition hover:bg-tg-section active:scale-[0.99]"
        >
          <RefreshCw className={cn('h-4 w-4', parsing && 'animate-spin')} />
          {parsing ? 'Забираем посты из Telegram…' : 'Проверить новые посты (парсер t.me/s)'}
        </button>
      </section>

      {/* Продвижение */}
      <section className="px-4 pt-5">
        <h3 className="px-1 pb-1.5 text-[13px] font-semibold uppercase tracking-wide text-tg-gray">
          Продвижение
        </h3>
        <div className="rounded-xl bg-tg-section p-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#e8a33d]/15">
              <Crown className="h-5 w-5 text-[#b7791f]" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[15px] font-semibold">Закреп в ленте · 7 дней</span>
                <span className="shrink-0 text-[15px] font-bold">990 ₽</span>
              </div>
              <ul className="mt-2 space-y-1.5 text-[13px] leading-snug text-tg-gray">
                <li>· Посты канала поднимаются в топ ленты</li>
                <li>· До 3× больше охвата и подписок</li>
                <li>· Значок ★ Premium рядом с названием</li>
              </ul>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              haptic('light')
              openTelegram(CREATOR)
            }}
            className="mt-3.5 h-10 w-full rounded-xl bg-tg-blue text-[14px] font-medium text-white transition hover:bg-tg-blue-dark active:scale-[0.98]"
          >
            Написать создателю @{CREATOR}
          </button>
          <p className="mt-2 text-center text-[12px] leading-snug text-tg-gray">
            Оплата переводом на карту (СБП). Активация вручную после подтверждения.
          </p>
        </div>
      </section>

      {/* Реклама */}
      <section className="px-4 pt-5">
        <h3 className="px-1 pb-1.5 text-[13px] font-semibold uppercase tracking-wide text-tg-gray">
          Реклама в ленте
        </h3>
        <div className="flex items-center gap-3 rounded-xl bg-tg-section p-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[15px] font-semibold">Рекламный слот</span>
              <span className="shrink-0 text-[15px] font-bold">от 5 000 ₽</span>
            </div>
            <p className="mt-1 text-[13px] leading-snug text-tg-gray">
              Каждый 10-й пост в ленте — рекламная карточка. Фиксированная цена, прямой контакт.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            haptic('light')
            openTelegram(CREATOR)
          }}
          className="mt-2.5 h-10 w-full rounded-xl border border-tg-blue text-[14px] font-medium text-tg-blue transition hover:bg-tg-blue/5 active:scale-[0.98]"
        >
          Забронировать слот
        </button>
      </section>
    </div>
  )
}
