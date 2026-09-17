import crypto from 'crypto'
import { INIT_DATA_MAX_AGE_SEC } from '@/lib/session'

export type TgUserPayload = {
  id: number
  username?: string
  first_name?: string
  last_name?: string
  photo_url?: string
  is_premium?: boolean
  language_code?: string
}

/**
 * Валидация Telegram WebApp initData (hash по спецификации Telegram).
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Усиления безопасности:
 *  - сравнение hash в постоянном времени (timingSafeEqual) — защита от timing-атак;
 *  - проверка auth_date: initData старше INIT_DATA_MAX_AGE_SEC отклоняется
 *    (защита от replay устаревших подписанных данных).
 */
export function validateInitData(
  initData: string,
  botToken: string,
  maxAgeSec = INIT_DATA_MAX_AGE_SEC,
): TgUserPayload | null {
  try {
    const params = new URLSearchParams(initData)
    const hash = params.get('hash')
    if (!hash) return null
    params.delete('hash')

    // Сортировка СТРОГО в байтовом порядке (спецификация Telegram) —
    // localeCompare зависит от локали и может дать иной порядок для не-букв
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')

    const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest()
    const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex')

    const a = Buffer.from(computed, 'hex')
    const b = Buffer.from(hash, 'hex')
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null

    // Свежесть: Telegram присылает auth_date (unix sec)
    const authDate = Number(params.get('auth_date'))
    if (!Number.isFinite(authDate) || authDate <= 0) return null
    const ageSec = Math.floor(Date.now() / 1000) - authDate
    if (ageSec > maxAgeSec || ageSec < -300) return null

    const userRaw = params.get('user')
    if (!userRaw) return null
    const user = JSON.parse(userRaw) as TgUserPayload
    if (typeof user?.id !== 'number' || !Number.isInteger(user.id) || user.id <= 0) return null
    // Ограничение длины строковых полей (защита от переполнения БД)
    if (user.username && user.username.length > 64) user.username = user.username.slice(0, 64)
    if (user.first_name && user.first_name.length > 128)
      user.first_name = user.first_name.slice(0, 128)
    if (user.last_name && user.last_name.length > 128) user.last_name = user.last_name.slice(0, 128)
    if (user.language_code && user.language_code.length > 10)
      user.language_code = user.language_code.slice(0, 10)
    return user
  } catch {
    return null
  }
}
