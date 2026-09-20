import { db } from '@/lib/db'
import { activeGiveaways, awardTicket, FORWARD_SOURCES_GOAL } from '@/lib/giveaway-tickets'
import { invalidatePersonalSignals } from '@/lib/feed'
import { getChatInfo } from '@/lib/tg-bot'
import { isValidChannelUsername } from '@/lib/server'

/**
 * ПРОФИЛЬ ИСТОЧНИКОВ РЕКОМЕНДАЦИЙ (v5.50) — механика «В один клик».
 *
 * Юзер пересылает боту по одному свежему посту из своих любимых каналов
 * («читаю каждый день»). Бот из forward_origin извлекает канал и складывает
 * его в профиль юзера (UserSource). Профиль — самый честный сигнал вкуса:
 *   1) персональная лента получает сильную аффинити-прибавку по этим каналам
 *      и их категориям (feed.ts loadPersonalSignals);
 *   2) канал из каталога приоритетно обновляется парсером (свежие посты
 *      любимого источника — сразу в ленту);
 *   3) новый публичный канал создаётся на модерации и получает первичный
 *      парс — каталог растёт из реальных привычек читателей;
 *   4) на 5-м уникальном канале юзер получает билет во все активные розыгрыши
 *      (системное задание 'forward', работает даже без конфига задания).
 */

/** Максимум каналов в профиле юзера (анти-абьюз: сбор «всего подряд») */
export const FORWARD_SOURCE_CAP = 40

export type ForwardChannel = { tgId: string; title: string; username: string | null }

export type CollectResult = {
  added: boolean
  /** уникальных каналов в профиле после операции */
  total: number
  /** сейчас впервые достигнут порог в 5 каналов → пора выдавать билет */
  crossedGoal: boolean
  /** публичный канал, которого нет в каталоге → кандидат на создание */
  newCandidate: ForwardChannel | null
  /** достигнут кап профиля — канал не записан */
  atCap: boolean
}

type TgOriginChat = { id?: number; title?: string; username?: string }

/**
 * Извлечь канал из пересланного сообщения. Поддержаны оба формата Bot API:
 * forward_origin.chat (современный) и forward_from_chat (легаси-клиенты).
 * Пересылки от юзеров/ботов/скрытых — не каналы → null.
 */
export function extractForwardChannel(msg: {
  forward_origin?: { type?: string; chat?: TgOriginChat }
  forward_from_chat?: TgOriginChat
  forward_from?: TgOriginChat
}): ForwardChannel | null {
  const origin = msg.forward_origin
  if (origin && origin.type === 'channel' && origin.chat?.id != null) {
    return normalizeOriginChat(origin.chat)
  }
  // Легаси: сообщения, пересланные со старых клиентов / Bot API < 7.0
  const legacy = msg.forward_from_chat ?? msg.forward_from
  if (legacy?.id != null && typeof legacy.id === 'number' && legacy.id < 0) {
    // id < 0 — канал/группа; у постов каналов id всегда -100...
    return normalizeOriginChat(legacy)
  }
  return null
}

function normalizeOriginChat(chat: TgOriginChat): ForwardChannel | null {
  if (chat.id == null) return null
  const username = (chat.username ?? '').replace(/^@/, '').trim() || null
  return {
    tgId: String(chat.id),
    title: (chat.title ?? username ?? 'Канал').trim().slice(0, 128) || 'Канал',
    username: username ? username.toLowerCase() : null,
  }
}

/**
 * Записать пересланный канал в профиль юзера. Идемпотентно (unique userId+tgId),
 * обновляет название/связку с каталогом при изменениях.
 */
export async function collectForwardedSource(
  userId: string,
  ch: ForwardChannel,
): Promise<CollectResult> {
  const result: CollectResult = {
    added: false,
    total: 0,
    crossedGoal: false,
    newCandidate: null,
    atCap: false,
  }

  const existing = await db.userSource.findUnique({
    where: { userId_tgId: { userId, tgId: ch.tgId } },
    select: { id: true, title: true, username: true, channelId: true },
  })

  if (existing) {
    // Уже известен: синхронизируем метаданные (название могло смениться)
    const needUpdate =
      (ch.title && ch.title !== existing.title) ||
      (ch.username ?? null) !== existing.username
    if (needUpdate) {
      await db.userSource
        .update({
          where: { id: existing.id },
          data: {
            ...(ch.title !== existing.title ? { title: ch.title } : {}),
            ...(ch.username !== existing.username ? { username: ch.username } : {}),
          },
        })
        .catch(() => {})
    }
  } else {
    // Кап профиля: юзер «собирает всё подряд» — новые каналы не записываем,
    // но и не ругаемся (тихая защита; существующие продолжают обновляться)
    const currentCount = await db.userSource.count({ where: { userId } })
    if (currentCount >= FORWARD_SOURCE_CAP) {
      result.atCap = true
      result.total = currentCount
      return result
    }
    // Новый канал в профиле: ищем в каталоге по tgId или username
    const catalog = await db.channel.findFirst({
      where: {
        OR: [
          { tgId: ch.tgId },
          ...(ch.username ? [{ username: ch.username }] : []),
        ],
      },
      select: { id: true },
    })
    try {
      await db.userSource.create({
        data: {
          userId,
          tgId: ch.tgId,
          title: ch.title,
          username: ch.username,
          channelId: catalog?.id ?? null,
        },
      })
      result.added = true
      if (!catalog) {
        // Канала нет в каталоге — кандидат на создание (парсится снизу)
        result.newCandidate = ch
      }
    } catch {
      // P2002 (гонка параллельных форвардов одного канала) — не добавлен
    }
  }

  const total = await db.userSource.count({ where: { userId } })
  result.total = total
  result.crossedGoal = result.added && total >= FORWARD_SOURCES_GOAL && total - 1 < FORWARD_SOURCES_GOAL

  if (result.added) {
    // Лента перестраивается сразу, не дожидаясь TTL кэша сигналов
    invalidatePersonalSignals(userId)
  }
  return result
}

export type ForwardAwardSummary = {
  awardedGiveaways: string[]
  tickets: number
}

/**
 * Выдать билет за задание 'forward' во ВСЕ активные розыгрыши.
 * Задание системное: awardTicket не требует его в конфиге розыгрыша.
 */
export async function awardForwardTickets(user: {
  userId: string
  tgId?: number
  username?: string
  firstName?: string
}): Promise<ForwardAwardSummary> {
  const summary: ForwardAwardSummary = { awardedGiveaways: [], tickets: 0 }
  try {
    const gws = await activeGiveaways()
    for (const g of gws) {
      const r = await awardTicket({
        giveawayId: g.id,
        userId: user.userId,
        task: 'forward',
        note: `forward:${FORWARD_SOURCES_GOAL} каналов`,
        tgId: user.tgId,
        username: user.username,
        firstName: user.firstName,
      })
      if (r.awarded) {
        summary.awardedGiveaways.push(g.title)
        summary.tickets += r.ticketsCount ?? 0
      }
    }
  } catch (e) {
    console.error('[source-profile] awardForwardTickets', e)
  }
  return summary
}

/* --------------------------- парсер под источник --------------------------- */

/** Ротационный троттлинг «канал парсили недавно» (в памяти процесса) */
const recentParse = new Map<string, number>()
const PARSE_TTL_MS = 30 * 60_000
const RECENT_MAX = 500

function parseThrottled(key: string): boolean {
  const now = Date.now()
  const at = recentParse.get(key)
  if (at && now - at < PARSE_TTL_MS) return true
  if (recentParse.size >= RECENT_MAX) {
    for (const [k, t] of recentParse) if (now - t >= PARSE_TTL_MS) recentParse.delete(k)
    if (recentParse.size >= RECENT_MAX) {
      const first = recentParse.keys().next().value
      if (first !== undefined) recentParse.delete(first)
    }
  }
  recentParse.set(key, now)
  return false
}

/**
 * Приоритетный парсинг пересланного канала («запускает под них твой парсер»):
 *  • канал есть в каталоге → обновить свежие посты вне очереди шедулера;
 *  • канала нет и он публичный → создать (модерация) + первичный парс,
 *    чтобы контент был готов к моменту одобрения.
 * Fire-and-forget: вебхук не ждёт сеть t.me.
 */
export function kickSourceParse(ch: ForwardChannel): void {
  void (async () => {
    const uname = ch.username
    if (!uname || !isValidChannelUsername(uname)) return // приватные не парсятся
    if (parseThrottled(`@${uname}`)) return

    const existing = await db.channel
      .findUnique({ where: { username: uname }, select: { id: true, status: true } })
      .catch(() => null)

    if (existing) {
      const { runParser } = await import('@/lib/parse-engine')
      runParser(5, uname, undefined, 20_000, 1).catch(() => {})
      return
    }

    // Нового канала нет в каталоге: создаём на модерации (юзер-инпут —
    // доверять нельзя, админ смотрит в панели как claim-каналы)
    const info = await getChatInfo(uname).catch(() => null)
    if (!info && !ch.title) return // канал не существует/приватный — не мусорим
    const cat =
      (await db.category
        .findFirst({ where: { slug: 'other' }, select: { id: true } })
        .catch(() => null)) ??
      (await db.category.findFirst({ select: { id: true } }).catch(() => null))
    if (!cat) return // без категорий каталог не функционирует

    const created = await db.channel
      .create({
        data: {
          tgId: info?.id ?? ch.tgId,
          title: (info?.title ?? ch.title).slice(0, 120),
          username: uname,
          description: info?.description?.slice(0, 500) ?? null,
          photoFileId: info?.photoFileId ?? null,
          membersCount: info?.members ?? null,
          membersFetchedAt: info ? new Date() : null,
          categoryId: cat.id,
          status: 'moderation',
        },
        select: { id: true },
      })
      .catch(() => null)
    if (!created) return

    // Связываем источники юзеров с созданным каналом (персонализация без ремонта)
    await db.userSource
      .updateMany({
        where: { OR: [{ tgId: ch.tgId }, { username: uname }], channelId: null },
        data: { channelId: created.id },
      })
      .catch(() => {})
    // Разбросанные ранее источники без связки получают channelId → аффинити сразу
    invalidatePersonalSignalsByChannelSource(ch.tgId)

    const { runParser } = await import('@/lib/parse-engine')
    runParser(10, uname, undefined, 25_000, 1).catch(() => {})
  })().catch((e) => console.error('[source-profile] kickSourceParse', e))
}

/** Точечный сброс кэша сигналов для юзеров, у которых канал без связки */
async function invalidatePersonalSignalsByChannelSource(tgId: string): Promise<void> {
  try {
    const rows = await db.userSource.findMany({
      where: { tgId, channelId: { not: null } },
      select: { userId: true },
      take: 50,
    })
    for (const r of rows) invalidatePersonalSignals(r.userId)
  } catch {
    // кэш и так протухнет по TTL
  }
}

/* ------------------------------ сводка для API ----------------------------- */

export type UserSourcesSummary = {
  count: number
  goal: number
  /** названия последних каналов (для чипов в UI) */
  channels: string[]
}

/** Сводка профиля источников для миниаппа (/api/giveaway и будущие экраны) */
export async function userSourcesSummary(userId: string): Promise<UserSourcesSummary> {
  const [count, rows] = await Promise.all([
    db.userSource.count({ where: { userId } }),
    db.userSource.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { title: true },
    }),
  ])
  return {
    count,
    goal: FORWARD_SOURCES_GOAL,
    channels: rows.map((r) => r.title).filter(Boolean),
  }
}
