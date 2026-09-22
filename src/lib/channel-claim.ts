import { db } from '@/lib/db'
import { getChatInfo } from '@/lib/tg-bot'

/**
 * v5.80 — ПРИВЯЗКА КАНАЛА ДОБАВЛЕНИЕМ БОТА (вместо кода-слова).
 *
 * Старый флоу («опубликуй код постом») требовал от владельца постить мусор
 * в свой канал и ждал обхода веб-превью. Новый:
 *  1. Юзер вводит @юзернейм канала в «Мой канал» → claimStart.
 *  2. Создаётся черновик канала (status moderation) + заявка
 *     `claim_pending:<uname>` → { userId, at } (KV BotSetting, TTL 48ч).
 *  3. Юзер тапает «Добавить бота в канал» — deep link t.me/<bot>?startchannel&admin
 *     открывает нативный пикер Telegram; владелец выбирает канал и выдаёт права.
 *  4. Бот становится админом → Telegram шлёт my_chat_member → вебхук завершает
 *     заявку (claim-status дополнительно самопроверяет права — покрывает случай,
 *     когда бот был админом ещё ДО заявки и апдейт не придёт).
 *  5. Канал получает claimedById + status active; аватар/подписчики докачиваются
 *     из Bot API; новые посты канала летят в ленту вебхуком (channel_post).
 *
 * Приватные каналы (без @username) привязать нельзя — флоу строится на
 * публичных каналах, как и весь каталог ленты.
 */

const PENDING_TTL_MS = 48 * 3600_000

export function normalizeChannelUsername(raw: string): string {
  return raw
    .replace(/^@/, '')
    .replace(/^https?:\/\/t\.me\//, '')
    .replace(/\/+$/, '')
    .trim()
    .toLowerCase()
}

export function pendingKey(username: string): string {
  return `claim_pending:${username}`
}

/** Заявка на привязку: кто и когда просил канал. Last-wins — повторный claimStart перезаписывает. */
export async function setPendingClaim(username: string, userId: string): Promise<void> {
  const value = JSON.stringify({ userId, at: new Date().toISOString() })
  await db.botSetting
    .upsert({ where: { key: pendingKey(username) }, create: { key: pendingKey(username), value }, update: { value } })
}

/**
 * Снять заявку: вернуть userId заявителя и удалить ключ.
 * null — заявки нет / просрочена / некорректна (тогда ключ тоже подчищается).
 */
export async function popPendingClaim(username: string): Promise<string | null> {
  const raw = await db.botSetting.findUnique({ where: { key: pendingKey(username) } }).catch(() => null)
  if (!raw) return null
  await db.botSetting.delete({ where: { key: pendingKey(username) } }).catch(() => {})
  try {
    const parsed = JSON.parse(raw.value) as { userId?: string; at?: string }
    const at = Date.parse(parsed.at ?? '')
    if (typeof parsed.userId === 'string' && parsed.userId.startsWith('tg_') && Number.isFinite(at) && Date.now() - at <= PENDING_TTL_MS) {
      return parsed.userId
    }
  } catch {
    /* битый JSON — ключ уже удалён */
  }
  return null
}

/**
 * Финал привязки: владение подтверждено (бот — админ канала).
 * Идемпотентно для уже привязанного тем же юзером; false — канал занят другим.
 */
export async function completeChannelClaim(
  username: string,
  userId: string,
  extra?: { chatId?: string; title?: string },
): Promise<{ ok: boolean; channelId?: string; title?: string; takenByOther?: boolean }> {
  const channel = await db.channel.findUnique({
    where: { username },
    select: { id: true, title: true, claimedById: true },
  })
  if (!channel) return { ok: false }
  if (channel.claimedById && channel.claimedById !== userId) return { ok: false, takenByOther: true }

  await db.channel.update({
    where: { id: channel.id },
    data: {
      claimedById: userId,
      claimedAt: new Date(),
      status: 'active',
      ...(extra?.chatId ? { tgId: extra.chatId } : {}),
      ...(extra?.title ? { title: extra.title.slice(0, 120) } : {}),
    },
  })

  // Вечная аватарка/описание/подписчики из Bot API — фоном, ответ не ждём
  void getChatInfo(username)
    .then((info) => {
      if (!info) return
      return db.channel
        .update({
          where: { id: channel.id },
          data: {
            ...(info.photoFileId ? { photoFileId: info.photoFileId, avatarFetchedAt: new Date() } : {}),
            ...(info.members ? { membersCount: info.members } : {}),
            ...(info.description ? { description: info.description.slice(0, 500) } : {}),
          },
        })
        .catch(() => {})
    })
    .catch(() => {})

  return { ok: true, channelId: channel.id, title: channel.title }
}

/** Deep link «добавить бота в канал» — нативный пикер Telegram с выдачей прав админа */
export function claimDeepLink(botUsername: string): string {
  return `https://t.me/${botUsername.replace(/^@/, '')}?startchannel&admin`
}
