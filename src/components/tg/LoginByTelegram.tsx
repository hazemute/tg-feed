'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, Globe, Loader2, RefreshCw, Send, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api, setSessionToken } from '@/lib/api'
import { useApp } from '@/lib/store'
import { haptic, userAvatarUrl } from '@/lib/tg'
import { BottomSheet } from '@/components/tg/BottomSheet'
import { Avatar } from '@/components/tg/Avatar'
import type { UserDTO } from '@/lib/types'

type LinkResponse = { token: string; url: string; botUsername: string; expiresAt: string }

type PollResponse =
  | { status: 'pending' | 'expired' }
  | { status: 'confirmed'; user: UserDTO; token: string }

/**
 * «Вход по Telegram» для самостоятельного сайта (и для гостей миниаппы):
 * создаём одноразовую ссылку на бота → пользователь жмёт в боте «Войти» →
 * сайт подхватывает вход опросом и молча подменяет гостевую сессию на tg.
 */
export function LoginByTelegram({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { setUser, user: tgUser } = useApp()
  const [phase, setPhase] = useState<'creating' | 'waiting' | 'expired' | 'done'>('creating')
  const [link, setLink] = useState<LinkResponse | null>(null)
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const createLink = useCallback(async () => {
    setPhase('creating')
    setLink(null)
    stopPolling()
    try {
      const r = await api<LinkResponse>('/api/auth/link', { method: 'POST' })
      setLink(r)
      setPhase('waiting')
    } catch (e) {
      toast.error((e as Error).message || 'Не удалось создать ссылку входа')
      onClose()
    }
  }, [onClose, stopPolling])

  useEffect(() => {
    if (!open) return
    // setTimeout: setState не в теле эффекта (react-hooks/set-state-in-effect)
    const t = setTimeout(() => void createLink(), 0)
    return () => {
      clearTimeout(t)
      stopPolling()
    }
  }, [open, createLink, stopPolling])

  // Опрос статуса: как только бот подтвердил «Войти» — подменяем сессию
  useEffect(() => {
    if (phase !== 'waiting' || !link) return
    let alive = true
    let inFlight = false
    const poll = async () => {
      if (inFlight) return // предыдущий запрос ещё летит — не плодим параллельные
      inFlight = true
      try {
        const r = await api<PollResponse>(`/api/auth/link?token=${encodeURIComponent(link.token)}`)
        if (!alive) return
        if (r.status === 'confirmed') {
          stopPolling()
          setSessionToken(r.token)
          setUser(r.user)
          setPhase('done')
          haptic('success')
          toast.success('Вы вошли через Telegram')
          setTimeout(() => window.location.reload(), 900)
        } else if (r.status === 'expired') {
          stopPolling()
          setPhase('expired')
        }
      } catch {
        /* сеть моргнула — продолжаем опрос */
      } finally {
        inFlight = false
      }
    }
    const t = setInterval(poll, 2500)
    timerRef.current = t
    void poll()
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [phase, link, setUser, stopPolling])

  const copy = async () => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link.url)
      setCopied(true)
      haptic('light')
      setTimeout(() => setCopied(false), 1600)
    } catch {
      toast.error('Не удалось скопировать')
    }
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Вход по Telegram"
      subtitle="Подтверждение через нашего бота — без паролей"
      zClass="z-[95]"
    >
      {/* Шаги */}
      <ol className="space-y-2.5">
        <Step n={1} done={phase === 'waiting' || phase === 'done'}>
          Нажмите <b>«Открыть Telegram»</b> — откроется чат с ботом @tgswipe_bot
        </Step>
        <Step n={2} done={phase === 'done'}>
          В чате нажмите кнопку <b>«✅ Войти на сайт»</b>
        </Step>
        <Step n={3} done={phase === 'done'}>
          Готово — профиль Telegram появится на сайте автоматически
        </Step>
      </ol>

      {/* Кнопки действия */}
      {phase === 'waiting' || phase === 'creating' ? (
        <>
          <a
            href={link?.url ?? '#'}
            onClick={(e) => {
              if (!link) e.preventDefault()
              else haptic('light')
            }}
            target="_blank"
            rel="noreferrer"
            aria-disabled={!link}
            className={cn(
              'mt-4 flex h-[52px] w-full items-center justify-center gap-2 rounded-2xl text-[15.5px] font-bold text-white transition active:scale-[0.98]',
              link ? 'bg-tg-link' : 'pointer-events-none bg-tg-link/50',
            )}
          >
            {phase === 'creating' ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <Send className="h-5 w-5" />
            )}
            Открыть Telegram
          </a>
          <button
            type="button"
            onClick={copy}
            disabled={!link}
            className="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-2xl bg-tg-surface text-[14px] font-semibold text-tg-text2 transition active:scale-[0.98] disabled:opacity-60"
          >
            {copied ? <Check className="h-4 w-4 text-tg-link" /> : <Copy className="h-4 w-4" />}
            {copied ? 'Ссылка скопирована' : 'Скопировать ссылку'}
          </button>

          {/* Ждём подтверждения */}
          <div className="mt-4 flex items-center justify-center gap-2.5 rounded-2xl bg-tg-surface/60 py-3.5">
            {phase === 'waiting' ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin text-tg-link" aria-hidden />
                <span className="text-[13.5px] font-medium text-tg-hint">
                  Ждём подтверждения в Telegram…
                </span>
              </>
            ) : (
              <span className="text-[13.5px] text-tg-hint">Создаём ссылку входа…</span>
            )}
          </div>
        </>
      ) : phase === 'expired' ? (
        <div className="mt-4 text-center">
          <p className="text-[13.5px] leading-relaxed text-tg-hint">
            Ссылка входа устарела (живёт 15 минут). Создайте новую — это займёт секунду.
          </p>
          <button
            type="button"
            onClick={() => void createLink()}
            className="mx-auto mt-3 flex h-11 items-center justify-center gap-2 rounded-2xl bg-tg-link px-5 text-[14.5px] font-semibold text-white transition active:scale-[0.98]"
          >
            <RefreshCw className="h-4 w-4" />
            Новая ссылка
          </button>
        </div>
      ) : (
        <div className="mt-4 flex flex-col items-center rounded-2xl bg-tg-link/[0.07] py-5">
          <Avatar
            name={
              [tgUser?.firstName, tgUser?.lastName].filter(Boolean).join(' ') || 'Tg Swipe'
            }
            color="#0a84ff"
            src={tgUser ? userAvatarUrl(tgUser.id, tgUser.photoUrl) : null}
            size={56}
          />
          <div className="mt-2.5 flex items-center gap-1.5 text-[15px] font-bold text-tg-text">
            <Check className="h-4.5 w-4.5 text-tg-link" />
            Вы вошли
          </div>
          <span className="mt-1 text-[12.5px] text-tg-hint">Обновляем страницу…</span>
        </div>
      )}

      {/* Приватность */}
      <p className="mt-4 flex items-start gap-2 pb-1 text-[11.5px] leading-snug text-tg-hint">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-tg-link" aria-hidden />
        Мы получаем только публичный профиль: имя, @username и аватар. Пароль Telegram не
        запрашивается никогда.
      </p>
      <p className="flex items-center gap-1.5 pb-1 text-[11.5px] leading-snug text-tg-hint">
        <Globe className="h-3.5 w-3.5 shrink-0" aria-hidden />
        Ссылка одноразовая и действует 15 минут.
      </p>
    </BottomSheet>
  )
}

function Step({
  n,
  done,
  children,
}: {
  n: number
  done?: boolean
  children: React.ReactNode
}) {
  return (
    <li className="flex items-start gap-3">
      <span
        className={cn(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-bold',
          done ? 'bg-tg-link text-white' : 'bg-tg-surface text-tg-hint',
        )}
        aria-hidden
      >
        {done ? <Check className="h-3.5 w-3.5" /> : n}
      </span>
      <span className="pt-0.5 text-[13.5px] leading-snug text-tg-text2 [&_b]:font-semibold">
        {children}
      </span>
    </li>
  )
}

