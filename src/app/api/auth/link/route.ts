import crypto from 'node:crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardIp } from '@/lib/guard'
import { signSession } from '@/lib/session'
import { getBotUsername, getUserPhotoFileId } from '@/lib/tg-bot'
import { adminUids, isMaintenanceOn } from '@/lib/maintenance'
import type { UserDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

/** Вход на сайте через Telegram-бота («Вход по Telegram»).
 *
 *  POST — создать попытку входа: случайный токен + глубокая ссылка
 *         https://t.me/<bot>?start=login_<token> (живёт 15 минут).
 *  GET  ?token=… — опрос статуса клиентом раз в 2-3с:
 *         pending → confirmed (тогда финализируем вход) | expired.
 *
 *  Финализация: вебхук бота положил в попытку снимок tg-пользователя
 *  (callback_query.from — данные именно того, кто нажал «Войти» в боте).
 *  Здесь мы апсертим tg_<id> и выдаём JWT. Сессия для старта НЕ нужна
 *  (v5.20: гостей больше нет — сайт начинается с этого роута), секрет —
 *  сам случайный 48-hex токен попытки + подтверждение в чате бота.
 */

const LINK_TTL_MS = 15 * 60 * 1000

type TgUserSnapshot = {
  id: number
  username?: string
  first_name?: string
  last_name?: string
  photo_url?: string
  is_premium?: boolean
  language_code?: string
}

/** photo_url из Bot API — только https и доверенные хосты Telegram */
const PHOTO_HOST_RE = /^(?:t\.me|(?:[a-z0-9-]+\.)?telegram\.org|(?:[a-z0-9-]+\.)?telesco\.pe)$/i

function safePhotoUrl(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' || !PHOTO_HOST_RE.test(u.hostname)) return null
    return raw
  } catch {
    return null
  }
}

function parseCategories(raw: string): string[] {
  try {
    const arr = JSON.parse(raw) as unknown
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function userDto(u: {
  id: string
  username: string | null
  firstName: string | null
  lastName: string | null
  photoUrl: string | null
  isGuest: boolean
  isPremium: boolean
  languageCode: string | null
  categories: string
}): UserDTO {
  return {
    id: u.id,
    username: u.username,
    firstName: u.firstName,
    lastName: u.lastName,
    photoUrl: u.photoUrl,
    isGuest: u.isGuest,
    isPremium: u.isPremium,
    languageCode: u.languageCode,
    categories: parseCategories(u.categories),
  }
}

export async function POST(request: Request) {
  // Анти-абьюз: 6 ссылок в минуту с одного IP (сессия не нужна — гостей нет)
  const ip = guardIp(request, { limit: 6, windowMs: 60_000, bucket: 'auth-link' })
  if (!ip.ok) return ip.res

  try {
    await readJson(request).catch(() => ({}))
    const botUsername = await getBotUsername()
    if (!botUsername) return err('bot unavailable', 503)

    // Периодическая гигиена: подчищаем протухшие попытки (дёшево, по индексу)
    void db.loginAttempt
      .deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 60 * 60 * 1000) } } })
      .catch(() => {})

    const token = crypto.randomBytes(24).toString('hex')
    await db.loginAttempt.create({
      data: { id: token, expiresAt: new Date(Date.now() + LINK_TTL_MS) },
    })

    return NextResponse.json({
      token,
      url: `https://t.me/${botUsername}?start=login_${token}`,
      botUsername,
      expiresAt: new Date(Date.now() + LINK_TTL_MS).toISOString(),
    })
  } catch (e) {
    console.error('[auth/link] create failed', e)
    return err('failed to create login link', 500)
  }
}

const getSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{48}$/),
})

export async function GET(request: Request) {
  // Опрос без сессии: секрет — сам токен попытки (48 hex, неугадываемый);
  // от перебора — лимит по IP.
  const g = guardIp(request, { limit: 120, windowMs: 60_000, bucket: 'auth-link-poll' })
  if (!g.ok) return g.res

  try {
    const { searchParams } = new URL(request.url)
    const parsed = getSchema.safeParse({ token: searchParams.get('token') ?? '' })
    if (!parsed.success) return err('invalid token')

    const attempt = await db.loginAttempt.findUnique({ where: { id: parsed.data.token } })
    if (!attempt) return NextResponse.json({ status: 'expired' })
    if (attempt.status === 'pending' && attempt.expiresAt.getTime() < Date.now()) {
      return NextResponse.json({ status: 'expired' })
    }
    if ((attempt.status !== 'confirmed' && attempt.status !== 'used') || !attempt.tgUserJson) {
      return NextResponse.json({ status: 'pending' })
    }

    /*
     * confirmed/used → финализируем вход. ИДЕМПОТЕНТНО: клиент мог не получить
     * ответ прошлого запроса (сеть/таймаут) — повторный опрос просто достроит
     * вход (upsert no-op, миграция skipDuplicates, JWT пере-подписывается).
     * Статус 'used' ставим В КОНЦЕ и только как метку (не как замок).
     */

    let snap: TgUserSnapshot
    try {
      snap = JSON.parse(attempt.tgUserJson) as TgUserSnapshot
    } catch {
      return err('corrupted login data', 500)
    }
    if (typeof snap.id !== 'number' || snap.id <= 0) return err('corrupted login data', 500)

    const botToken = process.env.TELEGRAM_BOT_TOKEN
    let photoUrl = safePhotoUrl(snap.photo_url)
    // Вечный аватар через Bot API (file_id не протухает, в отличие CDN-ссылки)
    if (botToken) {
      const fileId = await getUserPhotoFileId(snap.id).catch(() => null)
      if (fileId) photoUrl = `tgfile:${fileId}`
    }

    const id = `tg_${snap.id}`
    const user = await db.user.upsert({
      where: { id },
      update: {
        username: snap.username?.slice(0, 64) ?? null,
        firstName: snap.first_name?.slice(0, 128) ?? null,
        lastName: snap.last_name?.slice(0, 128) ?? null,
        ...(photoUrl ? { photoUrl } : {}),
        isGuest: false,
        isPremium: snap.is_premium === true,
        languageCode: snap.language_code?.slice(0, 10) ?? null,
      },
      create: {
        id,
        username: snap.username?.slice(0, 64) ?? null,
        firstName: snap.first_name?.slice(0, 128) ?? null,
        lastName: snap.last_name?.slice(0, 128) ?? null,
        photoUrl,
        isGuest: false,
        isPremium: snap.is_premium === true,
        languageCode: snap.language_code?.slice(0, 10) ?? null,
        categories: '[]',
      },
    })

    // v5.20: гостей больше нет (стерилизованы) — миграция гостевой истории не нужна

    // Метка использования — best-effort (финализация выше уже идемпотентна)
    void db.loginAttempt
      .updateMany({ where: { id: attempt.id, status: 'confirmed' }, data: { status: 'used' } })
      .catch(() => {})

    const sessionToken = signSession(user.id, false)
    const maintenanceActive = await isMaintenanceOn()

    return NextResponse.json({
      status: 'confirmed',
      user: userDto(user),
      token: sessionToken,
      maintenance: {
        active: maintenanceActive,
        canBypass: adminUids().includes(user.id) || user.bypassMaintenance,
      },
    })
  } catch (e) {
    console.error('[auth/link] poll failed', e)
    return err('poll failed', 500)
  }
}
