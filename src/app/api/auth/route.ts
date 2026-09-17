import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { validateInitData } from '@/lib/tg-auth'
import { signSession } from '@/lib/session'
import { getBotUsername, getUserPhotoFileId } from '@/lib/tg-bot'
import { adminUids, isMaintenanceOn } from '@/lib/maintenance'
import { err, parseJsonArray, readJson } from '@/lib/server'
import { guardIp } from '@/lib/guard'
import type { UserDTO } from '@/lib/types'

/**
 * Гость стал verified-пользователем: переносим его данные из demo-строки
 * (лайки/закладки/просмотры/подписки/интересы/граница уведомлений), чтобы
 * история, накопленная до HMAC-подтверждения, не потерялась. Demo-строка
 * удаляется после переноса. Ошибка миграции НЕ ломает вход (try/catch снаружи).
 */
async function migrateDemoUserData(demoId: string, targetId: string): Promise<void> {
  try {
    const demo = await db.user.findUnique({ where: { id: demoId } })
    if (!demo || demo.id === targetId) return

    await db.$transaction(async (tx) => {
      const [subs, likes, bookmarks, views] = await Promise.all([
        tx.subscription.findMany({ where: { userId: demoId } }),
        tx.like.findMany({ where: { userId: demoId } }),
        tx.bookmark.findMany({ where: { userId: demoId } }),
        tx.postView.findMany({ where: { userId: demoId } }),
      ])

      if (subs.length > 0) {
        await tx.subscription.createMany({
          data: subs.map((s) => ({
            userId: targetId,
            channelId: s.channelId,
            hidden: s.hidden,
            notify: s.notify,
            createdAt: s.createdAt,
          })),
          skipDuplicates: true,
        })
        await tx.subscription.deleteMany({ where: { userId: demoId } })
      }
      if (likes.length > 0) {
        await tx.like.createMany({
          data: likes.map((l) => ({ userId: targetId, postId: l.postId, createdAt: l.createdAt })),
          skipDuplicates: true,
        })
        await tx.like.deleteMany({ where: { userId: demoId } })
      }
      if (bookmarks.length > 0) {
        await tx.bookmark.createMany({
          data: bookmarks.map((b) => ({
            userId: targetId,
            postId: b.postId,
            createdAt: b.createdAt,
            readAt: b.readAt,
          })),
          skipDuplicates: true,
        })
        await tx.bookmark.deleteMany({ where: { userId: demoId } })
      }
      if (views.length > 0) {
        await tx.postView.createMany({
          data: views.map((v) => ({ userId: targetId, postId: v.postId, createdAt: v.createdAt })),
          skipDuplicates: true,
        })
        await tx.postView.deleteMany({ where: { userId: demoId } })
      }

      await tx.user.update({
        where: { id: targetId },
        data: {
          ...(demo.categories !== '[]' && { categories: demo.categories }),
          ...(demo.lastSeenNotifiedAt && { lastSeenNotifiedAt: demo.lastSeenNotifiedAt }),
        },
      })

      await tx.user.delete({ where: { id: demoId } })
    })
  } catch (e) {
    console.error('[auth] demo migration failed (non-fatal)', e)
  }
}

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
 * POST /api/auth
 * body: { initData?: string, tgUser?: {...}, deviceId?: string }
 *
 * Режимы входа:
 *  1) initData + TELEGRAM_BOT_TOKEN → полная HMAC-проверка Telegram (+ свежесть
 *     auth_date ≤ 24ч) → доверенный пользователь isDemo=false.
 *  2) initData без bot-токена (песочница/демо) → доверяем initDataUnsafe.user,
 *     помечаем isDemo=true (непроверенный — бот ему не пишет).
 *  3) Ничего нет → гость по deviceId (isDemo=true).
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
      id = `demo_${raw}`
      firstName = 'Гость'
    }

    const isDemo = !verified

    const user = await db.user.upsert({
      where: { id },
      update: {
        username,
        firstName,
        lastName,
        ...(photoUrl ? { photoUrl } : {}),
        isDemo,
        isPremium,
        languageCode,
      },
      create: { id, username, firstName, lastName, photoUrl, isDemo, isPremium, languageCode, categories: '[]' },
    })

    // Гость с историей стал verified — переносим его данные в настоящий аккаунт
    if (verified && typeof body?.deviceId === 'string') {
      const rawDevice = body.deviceId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
      if (rawDevice) await migrateDemoUserData(`demo_${rawDevice}`, user.id)
    }

    const token = signSession(user.id, isDemo)
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
      isDemo: user.isDemo,
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
