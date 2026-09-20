/**
 * Edge-совместимая проверка сессии (Web Crypto вместо node:crypto).
 * Используется ТОЛЬКО в middleware.ts — формат подписи полностью совпадает
 * с src/lib/session.ts (HS256, base64url): токен, выпущенный /api/auth,
 * проверяется здесь без Node-зависимостей.
 *
 * Секрет: AUTH_SECRET, либо та же производная sha256('tgfeed-session|bot|cron'),
 * что и в session.ts (считается через crypto.subtle, кэшируется в модуле).
 */

export type EdgeSession = {
  uid: string
  guest: boolean
  exp: number
}

const enc = new TextEncoder()

let cachedSecret: string | null = null

/**
 * v5.54: синхронно с session.ts — в проде без AUTH_SECRET/BOT-токена/CRON_SECRET
 * «публичный» секрет запрещён (fail-closed), в dev/песочнице — разрешён.
 */
async function deriveSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret
  const explicit = process.env.AUTH_SECRET?.trim()
  if (explicit) {
    cachedSecret = explicit
    return explicit
  }
  const parts = [process.env.TELEGRAM_BOT_TOKEN ?? '', process.env.CRON_SECRET ?? '']
    .filter(Boolean)
    .join('|')
  if (!parts && process.env.NODE_ENV === 'production') {
    throw new Error(
      '[session-edge] AUTH_SECRET/TELEGRAM_BOT_TOKEN/CRON_SECRET не заданы в production — сессии отключены (fail-closed)',
    )
  }
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`tgfeed-session|${parts}`))
  // session.ts использует hex-дайджест как секрет — повторяем байт в байт
  cachedSecret = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return cachedSecret
}

function toB64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Подпись HS256 → base64url (совпадает с session.ts) */
async function hmacB64url(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data))
  return toB64url(new Uint8Array(sig))
}

/** Сравнение в постоянном времени (Edge не имеет timingSafeEqual) */
function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/**
 * Проверить Bearer-токен сессии. Возвращает {uid, demo} или null.
 * Подпись и срок действия обязательны.
 */
export async function verifySessionEdge(
  token: string | null | undefined,
): Promise<EdgeSession | null> {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, payload, signature] = parts

  try {
    const secret = await deriveSecret()
    const expected = await hmacB64url(`${header}.${payload}`, secret)
    if (!safeEqual(fromB64url(signature), fromB64url(expected))) return null

    const parsed = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as {
      uid?: unknown
      demo?: unknown
      guest?: unknown
      exp?: unknown
      iat?: unknown
    }
    if (typeof parsed.uid !== 'string' || !parsed.uid) return null
    if (typeof parsed.exp !== 'number' || parsed.exp < Math.floor(Date.now() / 1000)) return null
    if (typeof parsed.iat !== 'number') return null
    return {
      uid: String(parsed.uid),
      guest: parsed.guest === true || parsed.demo === true,
      exp: typeof parsed.exp === 'number' ? parsed.exp : 0,
    }
  } catch {
    return null
  }
}

/** Bearer-токен из заголовка Authorization */
export function bearerToken(request: Request): string | null {
  const auth = request.headers.get('authorization') ?? ''
  return auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() || null : null
}
