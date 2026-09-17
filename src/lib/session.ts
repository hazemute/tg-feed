import crypto from 'crypto'

/**
 * Сессии Tg Swipe: компактный JWT (HS256) без внешних зависимостей.
 *
 * Поток: POST /api/auth проверяет Telegram initData (HMAC по спецификации
 * Telegram) либо гостевой deviceId → выдаёт токен сессии. Клиент хранит токен
 * и присылает его заголовком Authorization: Bearer <token> на каждый запрос.
 * Идентификатор пользователя берётся ТОЛЬКО из подписанной сессии —
 * подмена userId в query/body больше не даёт доступа к чужим данным.
 */

export type SessionPayload = {
  uid: string // id пользователя (tg_<tgId> или guest_<deviceId>)
  guest: boolean // true — гость (без HMAC-проверки); в старых JWT поле называлось demo
  iat: number // issued at (unix sec)
  exp: number // expires at (unix sec)
}

/** TTL сессии по умолчанию: 30 дней */
export const SESSION_TTL_SEC = 30 * 24 * 60 * 60

/** Максимальный возраст initData на момент проверки (защита от replay) */
export const INIT_DATA_MAX_AGE_SEC = 24 * 60 * 60

function getSecret(): string {
  const explicit = process.env.AUTH_SECRET?.trim()
  if (explicit) return explicit
  // Фолбэк: детерминированная производная от служебных секретов окружения.
  const parts = [process.env.TELEGRAM_BOT_TOKEN ?? '', process.env.CRON_SECRET ?? '']
    .filter(Boolean)
    .join('|')
  return crypto.createHash('sha256').update(`tgfeed-session|${parts}`).digest('hex')
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function b64urlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4))
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

function hmac(data: string): string {
  return b64url(crypto.createHmac('sha256', getSecret()).update(data).digest())
}

/** Подпись сессии → JWT-токен (header.payload.signature) */
export function signSession(uid: string, guest: boolean, ttlSec = SESSION_TTL_SEC): string {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(
    JSON.stringify({ uid, guest, iat: now, exp: now + Math.max(60, Math.floor(ttlSec)) }),
  )
  const signature = hmac(`${header}.${payload}`)
  return `${header}.${payload}.${signature}`
}

/** Проверка подписи и срока действия токена (сравнение в постоянном времени) */
export function verifySession(token: string | null | undefined): SessionPayload | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, payload, signature] = parts

  const expected = hmac(`${header}.${payload}`)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null

  try {
    const parsed = JSON.parse(b64urlDecode(payload).toString('utf8')) as SessionPayload & { demo?: unknown }
    if (typeof parsed.uid !== 'string' || !parsed.uid) return null
    if (typeof parsed.exp !== 'number' || parsed.exp < Math.floor(Date.now() / 1000)) return null
    if (typeof parsed.iat !== 'number') return null
    return { uid: parsed.uid, guest: parsed.guest === true || parsed.demo === true, iat: parsed.iat, exp: parsed.exp }
  } catch {
    return null
  }
}

/**
 * Достать сессию из запроса. Принимается ТОЛЬКО заголовок Authorization: Bearer —
 * userId из query/body игнорируется на всех защищённых роутах.
 */
export function getSession(request: Request): SessionPayload | null {
  const auth = request.headers.get('authorization') ?? ''
  if (!auth.startsWith('Bearer ')) return null
  return verifySession(auth.slice('Bearer '.length).trim())
}
