import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { validateInitData } from '@/lib/tg-auth'
import { signSession } from '@/lib/session'
import { getBotUsername, getUserPhotoFileId } from '@/lib/tg-bot'
import { adminUids, isMaintenanceOn, isReleased } from '@/lib/maintenance'
import { err, parseJsonArray, readJson } from '@/lib/server'
import { guardAuth, guardIp } from '@/lib/guard'
import { effectiveTier } from '@/lib/tiers'
import { parseBadges } from '@/lib/badges'
import { activateReferrals } from '@/lib/giveaway-tickets'
import type { UserDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

type Body = {
  initData?: unknown
}

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
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
    const [maintenanceActive, released] = await Promise.all([isMaintenanceOn(), isReleased()])
    const canBypass = adminUids().includes(user.id) || user.bypassMaintenance
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
      tier: effectiveTier(user),
      tierUntil: user.tierUntil?.toISOString() ?? null,
      badges: parseBadges(user.badges),
      style: { palette: user.profilePalette, bg: user.profileBg, frame: user.profileFrame },
      createdAt: user.createdAt.toISOString(),
    }
    return NextResponse.json({
      user: dto,
      maintenance: {
        active: maintenanceActive,
        canBypass,
      },
      release: { released, canBypass },
    })
  } catch (e) {
    console.error('[auth] me failed', e)
    return err('auth failed', 500)
  }
}

/**
 * POST /api/auth
 * body: { initData?: string }
 *
 * ЕДИНСТВЕННЫЙ режим входа: initData + TELEGRAM_BOT_TOKEN → полная HMAC-проверка
 * Telegram (+ свежесть auth_date ≤ 24ч). Никаких гостей и демо-доверия
 * initDataUnsafe — приложение боевое (v5.20).
 *
 * Ответ: { user, token, bot } — токен сессии (JWT HS256, 30 дней) клиент
 * обязан присылать заголовком Authorization: Bearer на все API-запросы.
 * Без валидного initData → 401 { error: 'telegram_required' } — сайт показывает
 * экран входа через бота.
 */
export async function POST(request: Request) {
  // Анти-брутфорс: 10 попыток в минуту с одного IP
  const ip = guardIp(request, { limit: 10, windowMs: 60_000, bucket: 'auth' })
  if (!ip.ok) return ip.res

  try {
    const body = await readJson<Body>(request)
    const botToken = process.env.TELEGRAM_BOT_TOKEN
    const initData = typeof body?.initData === 'string' ? body.initData : ''

    if (!initData || !botToken) return err('telegram_required', 401)

    const u = validateInitData(initData, botToken)
    if (!u) return err('telegram_invalid', 401)

    const id = `tg_${u.id}`
    const username = str(u.username, 64)
    const firstName = str(u.first_name, 128)
    const lastName = str(u.last_name, 128)
    let photoUrl = safePhotoUrl(u.photo_url)
    const isPremium = u.is_premium === true
    const languageCode = str(u.language_code, 10)

    // Аватар: photo_url из initData живёт ~1 час, поэтому берём вечный file_id
    // последнего фото профиля (рендер через /api/avatar/[uid]).
    // ВАЖНО: при сбое Bot API не затираем прежний аватар (update ниже перезаписывает
    // photoUrl только если есть новое значение).
    //
    // СКОРОСТЬ (v5.52 — «вход до секунды»): getUserPhotoFileId (Bot API, 0.3-2с)
    // БОЛЬШЕ НЕ БЛОКИРУЕТ ОТВЕТ — аватар догоняет фоново (fire-and-forget update
    // фото в БД). Вход = только upsert + настройки (1-2 RTT), аватарка подтянется
    // на следующем кадре профиля/ленты. Бот-токен/429 больше не могут задерживать
    // вход каждому открывшему миниапп.
    const tgId = Number(id.slice('tg_'.length))
    const [botUsername, maintenanceActive, released, user] = await Promise.all([
      getBotUsername(),
      isMaintenanceOn(),
      isReleased(),
      db.user.upsert({
        where: { id },
        update: {
          username,
          firstName,
          lastName,
          isGuest: false,
          isPremium,
          languageCode,
        },
        create: { id, username, firstName, lastName, isGuest: false, isPremium, languageCode, categories: '[]' },
      }),
    ])
    if (Number.isInteger(tgId) && tgId > 0) {
      void getUserPhotoFileId(tgId)
        .then((fileId) => {
          if (!fileId) return
          photoUrl = `tgfile:${fileId}`
          return db.user
            .update({ where: { id }, data: { photoUrl: `tgfile:${fileId}` } })
            .catch(() => {})
        })
        .catch(() => {})
    }
    // v5.46: юзер открыл Mini App → активируем его реферальные приглашения
    // (задание «пригласи друзей» у пригласивших) — fire-and-forget
    void activateReferrals(user.id, tgId)
    const maintenance = {
      active: maintenanceActive,
      canBypass: adminUids().includes(user.id) || user.bypassMaintenance,
    }
    const release = { released, canBypass: maintenance.canBypass }

    const token = signSession(user.id, false)

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
      tier: effectiveTier(user),
      tierUntil: user.tierUntil?.toISOString() ?? null,
      badges: parseBadges(user.badges),
      style: { palette: user.profilePalette, bg: user.profileBg, frame: user.profileFrame },
      createdAt: user.createdAt.toISOString(),
    }

    return NextResponse.json({ user: dto, token, bot: botUsername ? { username: botUsername } : null, maintenance, release })
  } catch (e) {
    console.error('[auth]', e)
    return err('auth failed', 500)
  }
}
