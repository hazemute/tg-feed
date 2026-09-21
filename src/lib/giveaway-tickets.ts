import { randomInt } from 'crypto'
import { db } from '@/lib/db'
import { emitAppEvent } from '@/lib/events'
import { sendBotNotification } from '@/lib/bot-notify'
import { getBotUsername } from '@/lib/tg-bot'

/**
 * БИЛЕТНАЯ СИСТЕМА РОЗЫГРЫШЕЙ (v5.46).
 *
 * Участник = строка GiveawayEntry (создаётся кнопкой «Участвовать», первым
 * выполненным заданием или входом в миниапп-розыгрыш). Баланс билетов —
 * GiveawayEntry.ticketsCount (@default(0)). В взвешенном рандоме участвуют
 * ТОЛЬКО записи с ticketsCount > 0: «человек не участвует, пока не заработал
 * первый билет».
 *
 * Задания (Giveaway.tasks, настраиваются при создании розыгрыша в боте):
 *  • activity — открыть Mini App и пролистать swipeGoal постов (просмотры
 *    /api/view с начала розыгрыша, дедуп по (userId, postId) на уровне БД);
 *  • promo — ввести секретный промокод розыгрыша (бот или миниапп);
 *  • referral — пригласить referralGoal друзей по ссылке t.me/<bot>?start=ref_<id>;
 *    «друг успешен», когда открыл Mini App (POST /api/auth активирует приглашение);
 *  • boost — отдать Premium-голос (буст) каналу boostChannel (проверка
 *    getUserChatBoosts — бот должен быть админом канала).
 *
 * Идемпотентность выдачи — UNIQUE(giveawayId, userId, task) на GiveawayTicket:
 * двойной клик/гонка воркеров не даст второй билет за то же задание.
 */

export type GiveawayTaskKind = 'activity' | 'promo' | 'referral' | 'boost' | 'forward'
export type AwardTask = GiveawayTaskKind | 'manual'

export type GiveawayTask = {
  kind: GiveawayTaskKind
  enabled: boolean
  /** сколько билетов даёт задание (можно больше 1) */
  tickets: number
  /** activity: сколько постов пролистать */
  swipeGoal?: number
  /** referral: сколько друзей-приглашённых */
  referralGoal?: number
  /** boost: канал для буста (без @) */
  boostChannel?: string
  /** кастомное название для поста/бота (опционально) */
  label?: string
}

export type TaskDone = { task: string; tickets: number; at: string }

export const DEFAULT_BOOST_CHANNEL = 'SnapTeamDev'
export const DEFAULT_SWIPE_GOAL = 25
export const DEFAULT_REFERRAL_GOAL = 3

/* ------------------------------- парсинг ------------------------------- */

export function parseTasks(json: string | null | undefined): GiveawayTask[] {
  try {
    const v = JSON.parse(json || '[]') as unknown
    if (!Array.isArray(v)) return []
    return v.filter(
      (t): t is GiveawayTask =>
        !!t && typeof t === 'object' &&
        typeof (t as GiveawayTask).kind === 'string' &&
        ['activity', 'promo', 'referral', 'boost', 'forward'].includes((t as GiveawayTask).kind),
    )
  } catch {
    return []
  }
}

export function serializeTasks(list: GiveawayTask[]): string {
  return JSON.stringify(
    list.map((t) => ({
      kind: t.kind,
      enabled: t.enabled !== false,
      tickets: Math.max(1, Math.min(100, Math.round(t.tickets || 1))),
      ...(t.kind === 'activity'
        ? { swipeGoal: Math.max(1, Math.min(100_000, Math.round(t.swipeGoal || DEFAULT_SWIPE_GOAL))) }
        : {}),
      ...(t.kind === 'referral'
        ? { referralGoal: Math.max(1, Math.min(1000, Math.round(t.referralGoal || DEFAULT_REFERRAL_GOAL))) }
        : {}),
      ...(t.kind === 'boost' ? { boostChannel: (t.boostChannel || DEFAULT_BOOST_CHANNEL).replace(/^@/, '') } : {}),
      ...(t.label ? { label: t.label.slice(0, 80) } : {}),
    })),
  )
}

export function parseTasksDone(json: string | null | undefined): TaskDone[] {
  try {
    const v = JSON.parse(json || '[]') as unknown
    return Array.isArray(v)
      ? v.filter(
          (t): t is TaskDone =>
            !!t && typeof t === 'object' && typeof (t as TaskDone).task === 'string',
        )
      : []
  } catch {
    return []
  }
}

/** Человекочитаемое название задания */
export function taskTitle(t: GiveawayTask): string {
  if (t.label) return t.label
  switch (t.kind) {
    case 'activity':
      return `Пролистай ${t.swipeGoal ?? DEFAULT_SWIPE_GOAL} постов в Mini App`
    case 'promo':
      return 'Введи секретный промокод'
    case 'referral':
      return `Пригласи ${t.referralGoal ?? DEFAULT_REFERRAL_GOAL} ${plural(t.referralGoal ?? DEFAULT_REFERRAL_GOAL, 'друга', 'друзей', 'друзей')} по своей ссылке`
    case 'boost':
      return `Отдай буст каналу @${t.boostChannel || DEFAULT_BOOST_CHANNEL}`
    case 'forward':
      return `Перешли боту по одному посту из ${FORWARD_SOURCES_GOAL} любимых каналов`
  }
}

/** Сколько уникальных каналов нужно переслать боту для билета (механика «В один клик») */
export const FORWARD_SOURCES_GOAL = 5

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

const TASK_ICON: Record<GiveawayTaskKind, string> = {
  activity: '📱',
  promo: '🔑',
  referral: '🤝',
  boost: '🚀',
  forward: '📬',
}

/* ------------------------------ активные ------------------------------ */

type ActiveGiveaway = {
  id: string
  title: string
  tasks: string
  promoCode: string | null
  startAt: Date
  endAt: Date
  losersRewardSwipes: number
}

let activeCache: { at: number; rows: ActiveGiveaway[] } | null = null

/** Активные розыгрыши (кэш 15с — вызывается на каждом батче просмотров) */
export async function activeGiveaways(): Promise<ActiveGiveaway[]> {
  const now = Date.now()
  if (activeCache && now - activeCache.at < 15_000) return activeCache.rows
  const rows = await db.giveaway.findMany({
    where: { status: 'active', startAt: { lte: new Date() }, endAt: { gt: new Date() } },
    select: {
      id: true,
      title: true,
      tasks: true,
      promoCode: true,
      startAt: true,
      endAt: true,
      losersRewardSwipes: true,
    },
  })
  activeCache = { at: now, rows }
  return rows
}

export function invalidateActiveCache(): void {
  activeCache = null
}

/* --------------------------- выдача билета --------------------------- */

export type AwardResult = {
  ok: boolean
  /** true — билет(ы) начислены сейчас; false — уже были или отказ */
  awarded: boolean
  reason?: 'ended' | 'task_disabled' | 'already' | 'no_giveaway' | 'db'
  ticketsCount?: number
  giveawayTitle?: string
}

/**
 * Начислить билет(ы) за задание. Идемпотентно: повторный вызов вернёт
 * awarded:false (уникальность тикета в БД). Создаёт запись участника при
 * первом билете (ticketsCount стартует с 0 — @default(0)).
 */
export async function awardTicket(opts: {
  giveawayId: string
  userId: string
  task: AwardTask
  /** переопределение количества (для manual/настройки) — иначе из конфига задания */
  tickets?: number
  note?: string
  /** снимок для создания entry, если юзер ещё не участник */
  tgId?: number
  username?: string
  firstName?: string
}): Promise<AwardResult> {
  const g = await db.giveaway.findUnique({
    where: { id: opts.giveawayId },
    select: { id: true, title: true, status: true, endAt: true, tasks: true },
  })
  if (!g) return { ok: false, awarded: false, reason: 'no_giveaway' }
  if (g.status !== 'active' || g.endAt.getTime() <= Date.now()) {
    return { ok: false, awarded: false, reason: 'ended' }
  }

  // Количество билетов: из конфига задания (для manual — как передали).
  // 'forward' — СИСТЕМНОЕ задание (механика «В один клик», v5.50): работает
  // даже если организатор не добавил его в конфиг розыгрыша (профиль источников
  // улучшает рекомендации всему сервису — награда не зависит от настроек),
  // но если в конфиге задано — берём оттуда.
  let tickets = Math.max(1, Math.round(opts.tickets ?? 1))
  if (opts.task !== 'manual' && opts.task !== 'forward') {
    const cfg = parseTasks(g.tasks).find((t) => t.kind === opts.task && t.enabled)
    if (!cfg) return { ok: false, awarded: false, reason: 'task_disabled' }
    tickets = Math.max(1, Math.round(cfg.tickets || 1))
  } else if (opts.task === 'forward') {
    const cfg = parseTasks(g.tasks).find((t) => t.kind === 'forward' && t.enabled)
    if (cfg) tickets = Math.max(1, Math.round(cfg.tickets || 1))
  }

  // Участник: создаём при отсутствии (гонка даблклика гасится unique)
  let entry = await db.giveawayEntry.findUnique({
    where: { giveawayId_userId: { giveawayId: g.id, userId: opts.userId } },
  })
  if (!entry) {
    try {
      entry = await db.giveawayEntry.create({
        data: {
          giveawayId: g.id,
          userId: opts.userId,
          tgId: opts.tgId != null ? String(opts.tgId) : null,
          username: opts.username ?? null,
          firstName: opts.firstName ?? null,
        },
      })
    } catch {
      entry = await db.giveawayEntry.findUnique({
        where: { giveawayId_userId: { giveawayId: g.id, userId: opts.userId } },
      })
      if (!entry) return { ok: false, awarded: false, reason: 'db' }
    }
  }

  // Тикет: уникальность (giveawayId, userId, task) = защита от повторной выдачи
  try {
    await db.giveawayTicket.create({
      data: {
        giveawayId: g.id,
        entryId: entry.id,
        userId: opts.userId,
        task: opts.task,
        tickets,
        note: opts.note?.slice(0, 200) ?? null,
      },
    })
  } catch {
    // P2002 — задание уже выполнено
    const fresh = await db.giveawayEntry.findUnique({
      where: { giveawayId_userId: { giveawayId: g.id, userId: opts.userId } },
      select: { ticketsCount: true },
    })
    return { ok: true, awarded: false, reason: 'already', ticketsCount: fresh?.ticketsCount ?? 0 }
  }

  // Баланс билетов + журнал выполненных заданий
  const done = parseTasksDone(entry.tasksDone)
  done.push({ task: opts.task, tickets, at: new Date().toISOString() })
  const updated = await db.giveawayEntry.update({
    where: { id: entry.id },
    data: { ticketsCount: { increment: tickets }, tasksDone: JSON.stringify(done) },
    select: { ticketsCount: true },
  })

  // Инбокс миниаппа + ЛС бота (fire-and-forget)
  notifyTicket(opts.userId, g.title, tickets, opts.task)

  return { ok: true, awarded: true, ticketsCount: updated.ticketsCount, giveawayTitle: g.title }
}

function notifyTicket(
  userId: string,
  giveawayTitle: string,
  tickets: number,
  task: AwardTask,
): void {
  void (async () => {
    try {
      const ticketWord = plural(tickets, 'билет', 'билета', 'билетов')
      const title =
        task === 'manual'
          ? `🎁 Организатор начислил ${tickets} ${ticketWord}!`
          : task === 'forward'
            ? `📬 Каналы собраны — +${tickets} ${ticketWord}!`
            : `🎫 +${tickets} ${ticketWord} в розыгрыше!`
      const body =
        task === 'manual'
          ? `Розыгрыш «${giveawayTitle}»: билеты начислены организатором.`
          : task === 'forward'
            ? `Розыгрыш «${giveawayTitle}»: любимые каналы в профиле — лента станет точнее. Чем больше билетов — тем выше шанс победы!`
            : `Розыгрыш «${giveawayTitle}»: задание выполнено. Чем больше билетов — тем выше шанс победы!`
      await db.notification
        .create({
          data: { userId, type: 'system', title, body: body.slice(0, 200) },
        })
        .catch((e: { code?: string }) => {
          // v5.50: билет может быть начислен юзеру, который ещё НЕ открывал
          // Mini App (пересылки/рефералы из бота) — строки User нет, FK
          // Notification.userId роняет P2003. Инбокс-запись пропускаем:
          // ЛС бота и SSE всё равно уходят ниже. Прочие ошибки — логируем.
          if (e?.code !== 'P2003') console.error('[giveaway-tickets] notify inbox', e)
        })
      emitAppEvent('notif:new', { userId })
      sendBotNotification({
        userId,
        type: 'system',
        title,
        body: `${body} Удачи! 🍀`,
      })
    } catch (e) {
      console.error('[giveaway-tickets] notify', e)
    }
  })()
}

/* ------------------------- прогресс заданий ------------------------- */

/** Сколько постов юзер пролистал с начала розыгрыша (просмотры /api/view) */
export async function activityProgress(giveawayId: string, startAt: Date, userId: string): Promise<number> {
  return db.postView.count({
    where: { userId, createdAt: { gte: startAt } },
  })
}

/** Сколько друзей юзера реально открыли Mini App */
export async function referralProgress(referrerUserId: string): Promise<number> {
  return db.giveawayReferral.count({
    where: { referrerUserId, activatedAt: { not: null } },
  })
}

/** Уже есть билет за задание? */
export async function hasTicket(giveawayId: string, userId: string, task: string): Promise<boolean> {
  const row = await db.giveawayTicket.findUnique({
    where: { giveawayId_userId_task: { giveawayId, userId, task } },
    select: { id: true },
  })
  return row !== null
}

export type UserCtx = { id: string; tgId?: number; username?: string; firstName?: string }

/**
 * Ленивая проверка ВСЕХ заданий юзера по всем активным розыгрышам (activity +
 * referral — они «дозревают» сами; promo/boost требуют явного действия).
 * Вызывается: после батча просмотров (view), после активации реферала (auth),
 * из GET /api/giveaway (открыл миниапп — досчитали).
 */
export async function checkAndAwardAuto(user: UserCtx): Promise<void> {
  try {
    if (user.id.startsWith('guest_')) return
    const gws = await activeGiveaways()
    if (gws.length === 0) return
    for (const g of gws) {
      const tasks = parseTasks(g.tasks)
      const activity = tasks.find((t) => t.kind === 'activity' && t.enabled)
      if (activity && activity.swipeGoal) {
        if (!(await hasTicket(g.id, user.id, 'activity'))) {
          const seen = await activityProgress(g.id, g.startAt, user.id)
          if (seen >= activity.swipeGoal) {
            await awardTicket({
              giveawayId: g.id,
              userId: user.id,
              task: 'activity',
              tgId: user.tgId,
              username: user.username,
              firstName: user.firstName,
            })
          }
        }
      }
      const referral = tasks.find((t) => t.kind === 'referral' && t.enabled)
      if (referral && referral.referralGoal) {
        if (!(await hasTicket(g.id, user.id, 'referral'))) {
          const invited = await referralProgress(user.id)
          if (invited >= referral.referralGoal) {
            await awardTicket({
              giveawayId: g.id,
              userId: user.id,
              task: 'referral',
              tgId: user.tgId,
              username: user.username,
              firstName: user.firstName,
            })
          }
        }
      }
    }
  } catch (e) {
    console.error('[giveaway-tickets] checkAndAwardAuto', e)
  }
}

/**
 * Проверить буст пользователя каналу и выдать билет за задание boost.
 * Возвращает человекочитаемый результат для бота/миниаппа.
 */
export async function checkBoostTask(
  giveawayId: string,
  user: UserCtx & { tgId: number },
): Promise<{ ok: boolean; message: string }> {
  const g = await db.giveaway.findUnique({
    where: { id: giveawayId },
    select: { id: true, title: true, status: true, endAt: true, tasks: true },
  })
  if (!g || g.status !== 'active' || g.endAt.getTime() <= Date.now()) {
    return { ok: false, message: 'Розыгрыш не активен' }
  }
  const cfg = parseTasks(g.tasks).find((t) => t.kind === 'boost' && t.enabled)
  if (!cfg) return { ok: false, message: 'В этом розыгрыше нет задания с бустом' }
  if (await hasTicket(g.id, user.id, 'boost')) {
    return { ok: true, message: '✅ Буст уже засчитан — билет твой!' }
  }
  const { getUserChatBoosts } = await import('@/lib/tg-bot')
  const boosts = await getUserChatBoosts(cfg.boostChannel || DEFAULT_BOOST_CHANNEL, user.tgId)
  if (boosts === null) {
    return {
      ok: false,
      message: `⏳ Не получилось проверить буст (бот должен быть админом @${cfg.boostChannel || DEFAULT_BOOST_CHANNEL}). Попробуй чуть позже.`,
    }
  }
  if (boosts <= 0) {
    return {
      ok: false,
      message: `🚀 Буст не найден. Добавь канал @${cfg.boostChannel || DEFAULT_BOOST_CHANNEL} в свои бусты и нажми «Проверить» снова!`,
    }
  }
  const r = await awardTicket({
    giveawayId: g.id,
    userId: user.id,
    task: 'boost',
    tgId: user.tgId,
    username: user.username,
    firstName: user.firstName,
    note: `boosts=${boosts} @${cfg.boostChannel || DEFAULT_BOOST_CHANNEL}`,
  })
  if (r.awarded) return { ok: true, message: `✅ Буст засчитан — +${cfg.tickets} 🎫!` }
  return { ok: true, message: 'Буст уже был засчитан ранее' }
}

/**
 * Ввести промокод розыгрыша. Код сверяется с активными розыгрышами
 * (case-insensitive). Билет за задание promo.
 */
export async function redeemPromoCode(
  user: UserCtx,
  code: string,
): Promise<{ ok: boolean; message: string; ticketsCount?: number }> {
  const clean = code.trim()
  if (clean.length < 3 || clean.length > 64) {
    return { ok: false, message: 'Промокод выглядит неправильно' }
  }
  const gws = (await activeGiveaways()).filter((g) => g.promoCode)
  if (gws.length === 0) return { ok: false, message: 'Сейчас нет активных розыгрышей с промокодом' }
  const g = gws.find((x) => x.promoCode!.toLowerCase() === clean.toLowerCase())
  if (!g) return { ok: false, message: '❌ Такой промокод не подходит' }
  if (await hasTicket(g.id, user.id, 'promo')) {
    return { ok: true, message: '🔑 Промокод уже был использован — билет уже у тебя!' }
  }
  const r = await awardTicket({
    giveawayId: g.id,
    userId: user.id,
    task: 'promo',
    tgId: user.tgId,
    username: user.username,
    firstName: user.firstName,
    note: clean,
  })
  if (r.awarded) {
    const cfg = parseTasks(g.tasks).find((t) => t.kind === 'promo' && t.enabled)
    return { ok: true, message: `✅ Промокод принят: +${cfg?.tickets ?? 1} 🎫!`, ticketsCount: r.ticketsCount }
  }
  return { ok: true, message: 'Промокод уже был засчитан' }
}

/* --------------------------- реферальные ссылки --------------------------- */

/** Ссылка приглашения: t.me/<bot>?start=ref_<tgId> */
export async function referralLinkFor(tgId: number): Promise<string | null> {
  const username = await getBotUsername()
  if (!username) return null
  return `https://t.me/${username}?start=ref_${tgId}`
}

/**
 * Друг перешёл по ссылке: бот вызывает при /start ref_<referrerTgId>.
 * Дедуп по (referrer, invited); самоприглашение запрещено.
 */
export async function recordReferral(
  referrerTgId: number,
  invitedTgId: number,
): Promise<{ ok: boolean; already: boolean }> {
  if (!Number.isInteger(referrerTgId) || !Number.isInteger(invitedTgId)) return { ok: false, already: false }
  if (referrerTgId <= 0 || invitedTgId <= 0 || referrerTgId === invitedTgId) {
    return { ok: false, already: false }
  }
  try {
    await db.giveawayReferral.create({
      data: { referrerUserId: `tg_${referrerTgId}`, invitedTgId: String(invitedTgId) },
    })
    return { ok: true, already: false }
  } catch {
    return { ok: true, already: true } // P2002 — уже приглашал
  }
}

/**
 * Друг открыл Mini App (POST /api/auth): активируем его приглашения и
 * досчитываем реферальное задание пригласившим.
 */
export async function activateReferrals(userId: string, tgId: number): Promise<void> {
  try {
    if (!Number.isInteger(tgId) || tgId <= 0) return
    const pending = await db.giveawayReferral.findMany({
      where: { invitedTgId: String(tgId), activatedAt: null },
      select: { id: true, referrerUserId: true },
    })
    if (pending.length === 0) return
    const now = new Date()
    await db.giveawayReferral.updateMany({
      where: { id: { in: pending.map((p) => p.id) } },
      data: { activatedAt: now, invitedUserId: userId },
    })
    // Пригласившим досчитываем задание referral (идемпотентно по unique-тикету)
    for (const p of pending) {
      await checkReferralTaskFor(p.referrerUserId)
    }
  } catch (e) {
    console.error('[giveaway-tickets] activateReferrals', e)
  }
}

/** Проверить и выдать билет referral одному пригласившему */
async function checkReferralTaskFor(referrerUserId: string): Promise<void> {
  const gws = await activeGiveaways()
  for (const g of gws) {
    const cfg = parseTasks(g.tasks).find((t) => t.kind === 'referral' && t.enabled)
    if (!cfg?.referralGoal) continue
    if (await hasTicket(g.id, referrerUserId, 'referral')) continue
    const invited = await referralProgress(referrerUserId)
    if (invited >= cfg.referralGoal) {
      const u = await db.user.findUnique({
        where: { id: referrerUserId },
        select: { id: true, username: true, firstName: true },
      })
      if (u) {
        await awardTicket({
          giveawayId: g.id,
          userId: u.id,
          task: 'referral',
          username: u.username ?? undefined,
          firstName: u.firstName ?? undefined,
        })
      }
    }
  }
}

/* --------------------- взвешенный честный рандом --------------------- */

export type WeightedCandidate = { userId: string; tickets: number }

/**
 * ЧЕСТНЫЙ ВЗВЕШЕННЫЙ РАНДОМ (криптостойкий randomInt).
 *
 * На каждое призовое место: случайный бросок по совокупному весу билетов,
 * победитель ИЗВЛЕКАЕТСЯ из пула (без возврата) — один пользователь не может
 * выиграть дважды ГАРАНТИРОВАННО конструкцией; Set-предохранитель исключает
 * дубли даже при баге вызывающего кода. Больше билетов — пропорционально
 * выше шанс на каждом броске.
 *
 * Пул: ТОЛЬКО участники с tickets > 0 (не заработал билет — не в розыгрыше).
 */
export function pickWinnersWeighted<T extends WeightedCandidate>(
  pool: T[],
  seats: number,
): T[] {
  const winners: T[] = []
  if (pool.length === 0 || seats <= 0) return winners
  const candidates = pool.filter((c) => Number.isFinite(c.tickets) && c.tickets > 0)
  if (candidates.length === 0) return winners
  const taken = new Set<string>()

  while (winners.length < seats && taken.size < candidates.length) {
    let total = 0
    for (const c of candidates) {
      if (taken.has(c.userId)) continue
      total += c.tickets
    }
    if (total <= 0) break
    // randomInt — криптостойкий генератор [0, total)
    let roll = randomInt(0, total)
    let chosen: T | null = null
    for (const c of candidates) {
      if (taken.has(c.userId)) continue
      roll -= c.tickets
      if (roll < 0) {
        chosen = c
        break
      }
    }
    // Паранойя округления: fallback — равномерный бросок по живым
    if (!chosen) {
      const alive = candidates.filter((c) => !taken.has(c.userId))
      chosen = alive[randomInt(0, alive.length)] ?? null
      if (!chosen) break
    }
    // Строгая уникальность победителей
    if (taken.has(chosen.userId)) continue
    taken.add(chosen.userId)
    winners.push(chosen)
  }
  return winners
}
