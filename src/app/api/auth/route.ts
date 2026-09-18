import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { validateInitData } from '@/lib/tg-auth'
import { signSession } from '@/lib/session'
import { getBotUsername, getUserPhotoFileId } from '@/lib/tg-bot'
import { adminUids, isMaintenanceOn } from '@/lib/maintenance'
import { err, parseJsonArray, readJson } from '@/lib/server'
import { guardAuth, guardIp } from '@/lib/guard'
import { migrateGuestUserData } from '@/lib/auth-user'
import type { UserDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

type Body = {
  initData?: unknown
  tgUser?: {
    id?: unknown
    username?: unknown
    first_name?: unknown
    last_name?: unknown
    photo_url?: unknown
    is_premium?: unknown
    language_code?: unknown
  }
  deviceId?: unknown
}

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
}

function bool(v: unknown): boolean {
  return v === true
}

/** photoUrl приходит с клиента — принимаем только https и доверенные хосты Telegram */
const PHOTO_HOST_RE = /^(?:t\.me|(?:[a-z0-9-]+\.)?telegram\.org|(?:[a-z0-9-]+\.)?telesco\.pe)$/i

function safePhotoUrl(v: unknown): string | null {
  const raw = str(v, 512)
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' || !PHOTO_HOST_RE.test(u.hostname)) return null
    return raw
  } catch {
    return null
  }
}

/**
 * GET /api/auth — проверка текущей Bearer-сессии (сайт: вебхук бота выдал
 * tg-сессию, Mini App пере-выдаёт её POST'ом). Возвращает тот же контракт,
 * что POST: { user, maintenance } — чтобы загрузка приложения шла одним путём.
 */
export async function GET(request: Request) {
  const g = guardAuth(request)
  if (!g.ok) return g.res
  try {
    const user = await db.user.findUnique({ where: { id: g.uid } })
    if (!user) return err('user not found', 401)
    const maintenanceActive = await isMaintenanceOn()
    const dto: UserDTO = {
      id: user.id,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      photoUrl: user.photoUrl,
      isGuest: user.isGuest,
      isPremium: user.isPremium,
      languageCode: user.languageCode,
      categories: parseJsonArray(user.categories),
    }
    return NextResponse.json({
      user: dto,
      maintenance: {
        active: maintenanceActive,
        canBypass: adminUids().includes(user.id) || user.bypassMaintenance,
      },
    })
  } catch (e) {
    console.error('[auth] me failed', e)
    return err('auth failed', 500)
  }
}

/**
 * POST /api/auth
 * body: { initData?: string, tgUser?: {...}, deviceId?: string }
 *
 * Режимы входа:
 *  1) initData + TELEGRAM_BOT_TOKEN → полная HMAC-проверка Telegram (+ свежесть
 *     auth_date ≤ 24ч) → доверенный пользователь isGuest=false.
 *  2) initData без bot-токена (песочница/демо) → доверяем initDataUnsafe.user,
 *     помечаем isGuest=true (непроверенный — бот ему не пишет).
 *  3) Ничего нет → гость по deviceId (гостевой аккаунт).
 *
 * Ответ: { user, token, bot } — токен сессии (JWT HS256, 30 дней) клиент
 * обязан присылать заголовком Authorization: Bearer на все API-запросы.
 */
export async function POST(request: Request) {
  // Анти-брутфорс: 10 попыток в минуту с одного IP
  const ip = guardIp(request, { limit: 10, windowMs: 60_000, bucket: 'auth' })
  if (!ip.ok) return ip.res

  try {
    const body = await readJson<Body>(request)
    const botToken = process.env.TELEGRAM_BOT_TOKEN

    let id: string | null = null
    let username: string | null = null
    let firstName: string | null = null
    let lastName: string | null = null
    let photoUrl: string | null = null
    let isPremium = false
    let languageCode: string | null = null
    let verified = false // прошёл ли пользователь HMAC-проверку Telegram

    const tgUser = body?.tgUser
    const initData = typeof body?.initData === 'string' ? body.initData : ''

    if (initData && botToken) {
      const u = validateInitData(initData, botToken)
      if (u) {
        id = `tg_${u.id}`
        username = str(u.username, 64)
        firstName = str(u.first_name, 128)
        lastName = str(u.last_name, 128)
        photoUrl = safePhotoUrl(u.photo_url)
        isPremium = u.is_premium === true
        languageCode = str(u.language_code, 10)
        verified = true
      }
    } else if (initData && tgUser && typeof tgUser.id === 'number' && tgUser.id > 0) {
      // Демо-среда без bot token: доверяем initDataUnsafe, но НЕ помечаем как проверенного
      id = `tg_${tgUser.id}`
      username = str(tgUser.username, 64)
      firstName = str(tgUser.first_name, 128)
      lastName = str(tgUser.last_name, 128)
      photoUrl = safePhotoUrl(tgUser.photo_url)
      isPremium = bool(tgUser.is_premium)
      languageCode = str(tgUser.language_code, 10)
      verified = false
    }

    // Аватар: photo_url из initData живёт ~1 час, поэтому при наличии bot-токена
    // берём вечный file_id последнего фото профиля (рендер через /api/avatar/[uid]).
    // ВАЖНО: при сбое Bot API не затираем прежний аватар (update ниже перезаписывает
    // photoUrl только если есть новое значение).
    if (id?.startsWith('tg_') && botToken) {
      const tgId = Number(id.slice('tg_'.length))
      if (Number.isInteger(tgId) && tgId > 0) {
        const fileId = await getUserPhotoFileId(tgId)
        if (fileId) photoUrl = `tgfile:${fileId}`
      }
    }

    if (!id) {
      const raw = typeof body?.deviceId === 'string' ? body.deviceId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) : ''
      if (!raw) return err('deviceId required')
      id = `guest_${raw}`
      firstName = 'Гость'
    }

    const isGuest = !verified

    const user = await db.user.upsert({
      where: { id },
      update: {
        username,
        firstName,
        lastName,
        ...(photoUrl ? { photoUrl } : {}),
        isGuest,
        isPremium,
        languageCode,
      },
      create: { id, username, firstName, lastName, photoUrl, isGuest, isPremium, languageCode, categories: '[]' },
    })

    // Гость с историей стал verified — переносим его данные в настоящий аккаунт
    if (verified && typeof body?.deviceId === 'string') {
      const rawDevice = body.deviceId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
      if (rawDevice) await migrateGuestUserData(`guest_${rawDevice}`, user.id)
    }

    const token = signSession(user.id, isGuest)
    const botUsername = await getBotUsername()

    // Статус техработ для клиента: экран техработ показывается только тем,
    // у кого нет допуска (админы из ADMIN_TG_IDS + галка bypassMaintenance)
    const maintenanceActive = await isMaintenanceOn()
    const maintenance = {
      active: maintenanceActive,
      canBypass: adminUids().includes(user.id) || user.bypassMaintenance,
    }

    const dto: UserDTO = {
      id: user.id,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      photoUrl: user.photoUrl,
      isGuest: user.isGuest,
      isPremium: user.isPremium,
      languageCode: user.languageCode,
      categories: parseJsonArray(user.categories),
    }

    return NextResponse.json({ user: dto, token, bot: botUsername ? { username: botUsername } : null, maintenance })
  } catch (e) {
    console.error('[auth]', e)
    return err('auth failed', 500)
  }
}
