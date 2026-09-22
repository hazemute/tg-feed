'use client'

import { api } from '@/lib/api'

/**
 * v5.85 — серверная отметка «онбординг показан» (POST /api/user/onboarded).
 *
 * localStorage в Telegram-клиентах ненадёжен: Desktop/iOS могут чистить
 * хранилище между сессиями, из-за чего гайд и тутор вылезали при каждом
 * заходе. Вызов идёт fire-and-forget при показе гайда/тура; отметка живёт
 * на User.onboardedAt и приходит в user.onboarded из /api/auth.
 * Модульный guard: один запрос за сессию страницы, ошибки молча глотаются
 * (локальные флаги localStorage остаются главным механизмом в сессии).
 */
let sent = false

export function markOnboardedServer(): void {
  if (sent) return
  sent = true
  void api('/api/user/onboarded', { method: 'POST' }).catch(() => {
    // сеть моргнула — попробуем при следующем показе в этой сессии
    sent = false
  })
}
