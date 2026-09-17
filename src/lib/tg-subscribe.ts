'use client'

import { toast } from 'sonner'
import { api } from '@/lib/api'
import { haptic, openTelegram } from '@/lib/tg'

/**
 * ПОДПИСКА В ОДИН ТАП = подписка в самом Telegram.
 *
 * Telegram не позволяет боту подписывать пользователя на каналы автоматически —
 * и это правильно с точки зрения спама. Поэтому флоу такой:
 *  1. Пользователь жмёт [+] в миниаппе — локальная подписка создаётся
 *     (она управляет лентой: колокольчик, скрытие, рекомендации).
 *  2. Миниапп открывает канал в клиенте Telegram — остаётся нажать родную
 *     «Подписаться».
 *  3. Когда пользователь возвращается, мы тихо сверяем членство через Bot API
 *     (если бот состоит в канале) и подтверждаем подписку тостом.
 */

type PendingVerify = { username: string; since: number; attempts: number }

const pending = new Map<string, PendingVerify>()
const VERIFY_LIFETIME_MS = 3 * 60_000 // если не вернулся за 3 минуты — забываем
const MAX_ATTEMPTS = 3
let listenerBound = false

function bindFocusListener(): void {
  if (listenerBound || typeof window === 'undefined') return
  listenerBound = true

  const check = async () => {
    if (pending.size === 0) return
    const now = Date.now()
    for (const [key, p] of pending) {
      if (now - p.since > VERIFY_LIFETIME_MS || p.attempts >= MAX_ATTEMPTS) {
        pending.delete(key)
        continue
      }
      if (now - p.since < 1500) continue // мгновенные фокусы (свитч-апп туда-обратно)
      p.attempts++
      try {
        const r = await api<{ verified: boolean; checkable: boolean }>('/api/subscribe/verify', {
          method: 'POST',
          body: JSON.stringify({ username: p.username }),
        })
        if (r.verified) {
          pending.delete(key)
          haptic('success')
          toast.success(`Вы в канале @${p.username} — подписка подтверждена`)
        } else if (!r.checkable) {
          // боту нечем проверить (не админ канала) — молча ждём ещё попытку,
          // локальная подписка уже работает
          if (p.attempts >= MAX_ATTEMPTS) pending.delete(key)
        }
        // checkable && !verified — пользователь ещё не подписался; проверим при следующем фокусе
      } catch {
        // сеть/лимиты — попробуем при следующем фокусе
      }
    }
  }

  window.addEventListener('focus', () => void check())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check()
  })
}

/**
 * Вызывается ПОСЛЕ создания локальной подписки: открывает канал в Telegram
 * и планирует тихую проверку членства при возврате в миниапп.
 */
export function openChannelToJoin(username: string): void {
  const clean = username.replace(/^@/, '')
  bindFocusListener()
  pending.set(clean.toLowerCase(), { username: clean, since: Date.now(), attempts: 0 })
  toast('Остался один шаг', {
    description: `Нажмите «Подписаться» в открывшемся канале @${clean}`,
    duration: 5000,
  })
  openTelegram(clean)
}
