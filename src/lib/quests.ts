import { db } from '@/lib/db'
import { botEnabled, getUserChatBoosts, isTelegramMember } from '@/lib/tg-bot'
import { emitAppEvent } from '@/lib/events'
import { sendBotNotification } from '@/lib/bot-notify'
import { plural } from '@/lib/giveaway-tickets'
import { invalidateBalance } from '@/lib/balance-cache'
import { grantXp, XP_RULES } from '@/lib/xp'

/**
 * ЗАДАНИЯ С НАГРАДОЙ (v5.51, расширены в v5.70) — вкладка «Задания».
 *
 * Механика:
 *  • админ создаёт задание; виды (kind):
 *    - subscribe / join_chat — подписка на канал / вступление в чат. Проверка
 *      честная: Bot API getChatMember (бот должен быть админом цели). Цель —
 *      публичный @username ИЛИ числовой chat_id (приватный инвайт-чат: бот
 *      добавлен админом вручную, chat_id берётся из BotChat). Инвайт-ссылка
 *      без привязанного chat_id честно отвечает cannot_verify;
 *    - boost — отдать Premium-буст каналу (getUserChatBoosts, как в розыгрышах);
 *    - tiktok_follow — подписка в TikTok, проверяется VLM по скриншоту
 *      (отдельный роут /api/quests/[id]/tiktok-verify);
 *    - daily_checkin — ежедневный вход: автозачёт раз в сутки (UTC), серия
 *      7 дней подряд даёт бонус. Хранится в DailyCheckin (не QuestCompletion —
 *      там уникальная пара quest+user на все времена);
 *    - profile_setup — аватар и имя в профиле (поля User), автозачёт;
 *    - activity_milestone — счётчик просмотров постов (PostView), автозачёт;
 *    - referral — активированные рефералы (GiveawayReferral.activatedAt),
 *      автозачёт при нужном числе приглашённых.
 *  • юзер тапает «Получить N свайпов»: условие не выполнено → открываем ссылку
 *    (или подсказка), выполнено → награда начисляется АТОМАРНО (уникальная
 *    пара quest+user / условный updateMany, баланс ≥ 0);
 *  • УМНАЯ ЗАЩИТА ОТ ФАРМИНГА (только для членства): реверификация по расписанию
 *    перепроверяет подписку. Отписался → задание аннулируется НАВСЕГДА и
 *    списывается ДВОЙНАЯ награда (в пределах баланса — в минус не уводим);
 *  • проверка недоступна (бот не админ/429) → юзеру ничего не начисляем.
 *
 * ЭКОНОМИКА: 500 свайпов = 1 ₽. Лёгкие одноразовые задания суммарно ~750,
 * «тяжёлые» (TikTok/буст) — ещё ~550 с честной проверкой; ежедневные — 15.
 */

export type QuestKind =
  | 'subscribe'
  | 'join_chat'
  | 'tiktok_follow'
  | 'daily_checkin'
  | 'profile_setup'
  | 'boost'
  | 'activity_milestone'
  | 'referral'

export const QUEST_KINDS: QuestKind[] = [
  'subscribe',
  'join_chat',
  'tiktok_follow',
  'daily_checkin',
  'profile_setup',
  'boost',
  'activity_milestone',
  'referral',
]

export function isQuestKind(v: string): v is QuestKind {
  return QUEST_KINDS.includes(v as QuestKind)
}

/** Виды заданий, где награду реверифицируем (членство — можно «отписаться») */
export const REVERIFY_KINDS: QuestKind[] = ['subscribe', 'join_chat']

/** Иконка вида задания — зеркало для фронта и бота */
export const QUEST_KIND_META: Record<QuestKind, { emoji: string; label: string }> = {
  subscribe: { emoji: '📢', label: 'Подписка на канал' },
  join_chat: { emoji: '💬', label: 'Вступление в чат' },
  tiktok_follow: { emoji: '🎵', label: 'Подписка в TikTok' },
  daily_checkin: { emoji: '📅', label: 'Ежедневный вход' },
  profile_setup: { emoji: '👤', label: 'Заполнение профиля' },
  boost: { emoji: '🚀', label: 'Буст канала' },
  activity_milestone: { emoji: '📖', label: 'Активность в ленте' },
  referral: { emoji: '🤝', label: 'Пригласи друга' },
}

/* --------------------------- Нормализация цели --------------------------- */

const USERNAME_RE = /^[a-zA-Z](?:[a-zA-Z0-9_]{3,63})$/

export type QuestTarget = {
  type: 'username' | 'chat_id' | 'invite'
  /** username без @ | числовой chat_id строкой | полная инвайт-ссылка */
  value: string
  /** ссылка-кнопка по умолчанию ('' — показать нечего, нужен кастомный link) */
  link: string
}

/**
 * Привести ввод админа к каноничной цели:
 *  «https://t.me/Foo», «t.me/foo/», «@foo», «foo» → username «foo»;
 *  «-1001234567890», «123456789» → chat_id;
 *  «https://t.me/+AbCd…», «t.me/joinchat/AbCd…» → invite (полная ссылка).
 */
export function parseQuestTarget(raw: string): QuestTarget | null {
  let s = (raw ?? '').trim()
  if (!s) return null
  s = s.replace(/^https?:\/\//i, '').replace(/^www\./i, '')

  // Инвайт: t.me/+CODE или t.me/joinchat/CODE (приватный чат/канал)
  const inv = s.match(/^(?:(?:t|telegram)\.me)\/(\+|joinchat\/)([A-Za-z0-9_-]{6,})$/i)
  if (inv) {
    const link = inv[1] === '+' ? `https://t.me/+${inv[2]}` : `https://t.me/joinchat/${inv[2]}`
    return { type: 'invite', value: link, link }
  }

  // Числовой chat_id (группы/супергруппы отрицательные, каналы -100…)
  if (/^-?\d{6,}$/.test(s)) return { type: 'chat_id', value: String(Number(s)), link: '' }

  // Публичный @username
  if (/^(t|telegram)\.me\//i.test(s)) s = s.replace(/^(t|telegram)\.me\//i, '').split(/[/?#]/)[0]
  s = s.replace(/^@/, '').toLowerCase()
  if (!USERNAME_RE.test(s)) return null
  return { type: 'username', value: s, link: `https://t.me/${s}` }
}

/** Совместимость: старый хелпер (username-only) */
export function normalizeQuestTarget(raw: string): string | null {
  const t = parseQuestTarget(raw)
  return t && t.type === 'username' ? t.value : null
}

const TIKTOK_HANDLE_RE = /^[a-z0-9._]{2,30}$/

/** «https://tiktok.com/@Foo.bar», «@foo.bar», «foo.bar» → «foo.bar» */
export function normalizeTiktokHandle(raw: string): string | null {
  let s = (raw ?? '').trim().toLowerCase()
  if (!s) return null
  s = s.replace(/^https?:\/\//i, '').replace(/^www\./i, '')
  s = s.replace(/^(?:m\.)?tiktok\.com\//i, '')
  s = s.replace(/^@/, '').split(/[/?#]/)[0]
  return TIKTOK_HANDLE_RE.test(s) ? s : null
}

export function parseMilestoneTarget(target: string): { metric: 'posts'; goal: number } | null {
  const m = target.match(/^posts:(\d{1,5})$/) ?? target.match(/^(\d{1,5})$/)
  const goal = m ? Number(m[1]) : 0
  return goal > 0 ? { metric: 'posts', goal } : null
}

/**
 * Нормализация цели под вид задания (панель админа).
 * daily_checkin/profile_setup цели не требуют — пишем 'none'.
 */
export function normalizeQuestTargetForKind(
  raw: string,
  kind: QuestKind,
): { target: string; targetType: string } | null {
  switch (kind) {
    case 'subscribe':
    case 'boost': {
      const t = parseQuestTarget(raw)
      return t && t.type === 'username' ? { target: t.value, targetType: 'username' } : null
    }
    case 'join_chat': {
      const t = parseQuestTarget(raw)
      return t ? { target: t.value, targetType: t.type } : null
    }
    case 'tiktok_follow': {
      const h = normalizeTiktokHandle(raw)
      return h ? { target: h, targetType: 'tiktok' } : null
    }
    case 'daily_checkin':
    case 'profile_setup':
      return { target: 'none', targetType: 'none' }
    case 'activity_milestone': {
      const mt = parseMilestoneTarget(raw.trim())
      return mt ? { target: `posts:${mt.goal}`, targetType: 'metric' } : null
    }
    case 'referral': {
      const n = Math.round(Number(raw))
      return Number.isInteger(n) && n >= 1 && n <= 1000 ? { target: String(n), targetType: 'goal' } : null
    }
    default:
      return null
  }
}

/** Ссылка-кнопка для цели задания (учитывает вид). Автозачётные виды без цели
 *  (daily/profile/milestone/referral) ссылки не имеют — '' если нет кастомной */
export function questLinkFor(kind: string, target: string, custom?: string | null): string {
  if (custom && custom.trim()) return custom.trim()
  if (/^https?:\/\//i.test(target)) return target
  if (kind === 'tiktok_follow') return `https://tiktok.com/@${target.replace(/^@/, '')}`
  if (kind === 'subscribe' || kind === 'join_chat' || kind === 'boost') {
    // Числовой chat_id (приватный чат после bind_chat): ссылку t.me/-100…
    // сгенерировать нельзя — только кастомная (инвайт). Без неё кнопки нет.
    if (!target || target === 'none' || /^-?\d{6,}$/.test(target)) return ''
    return `https://t.me/${target.replace(/^@/, '')}`
  }
  return ''
}

/** Совместимость со старыми вызовами (подписка/чат) */
export function questLinkOf(target: string, custom?: string | null): string {
  return questLinkFor('subscribe', target, custom)
}

/* ------------------------------ Награждение ------------------------------ */

export type ClaimStatus =
  | 'done' // выполнено сейчас, награда начислена
  | 'already' // уже было выполнено ранее (для daily — уже зачтено сегодня)
  | 'revoked' // было отозвано (отписался) — повторно нельзя
  | 'not_member' // юзер не в канале/чате
  | 'no_boost' // буст не найден
  | 'not_done' // условие автозачётного задания пока не выполнено
  | 'need_screenshot' // tiktok_follow: нужен скриншот (роут tiktok-verify)
  | 'cannot_verify' // проверка недоступна (бот не админ цели / 429 / нет токена / инвайт без chat_id)
  | 'unavailable' // задание неактивно/удалено

export type ClaimResult = {
  status: ClaimStatus
  reward?: number
  bonus?: number
  balance?: number
  link?: string
  streak?: number
}

export function tgIdOf(userId: string): number | null {
  const tgId = Number(userId.startsWith('tg_') ? userId.slice(3) : NaN)
  return Number.isInteger(tgId) && tgId > 0 ? tgId : null
}

export function userProfileComplete(u: {
  photoUrl?: string | null
  firstName?: string | null
  lastName?: string | null
  username?: string | null
}): boolean {
  const hasPhoto = Boolean((u.photoUrl ?? '').trim())
  const hasName = Boolean((u.firstName ?? '').trim() || (u.lastName ?? '').trim() || (u.username ?? '').trim())
  return hasPhoto && hasName
}

async function milestoneProgress(userId: string, metric: string): Promise<number> {
  if (metric === 'posts') return db.postView.count({ where: { userId } })
  return 0
}

/** Сколько друзей юзера реально активировали приглашение (открыли миниапп) */
export async function referralProgress(userId: string): Promise<number> {
  return db.giveawayReferral.count({ where: { referrerUserId: userId, activatedAt: { not: null } } })
}

export type QuestProgress = { progress: number | null; goal: number | null; streak: number | null }

/** Прогресс для карточки (GET /api/quests): N из M, серия и т.п. */
export async function questProgressInfo(
  userId: string,
  q: { kind: string; target: string },
): Promise<QuestProgress> {
  if (q.kind === 'activity_milestone') {
    const mt = parseMilestoneTarget(q.target)
    if (!mt) return { progress: null, goal: null, streak: null }
    return { progress: await milestoneProgress(userId, mt.metric), goal: mt.goal, streak: null }
  }
  if (q.kind === 'referral') {
    const goal = Math.max(1, Math.round(Number(q.target)) || 1)
    return { progress: await referralProgress(userId), goal, streak: null }
  }
  if (q.kind === 'profile_setup') {
    const u = await db.user.findUnique({
      where: { id: userId },
      select: { photoUrl: true, firstName: true, lastName: true, username: true },
    })
    return { progress: u && userProfileComplete(u) ? 1 : 0, goal: 1, streak: null }
  }
  if (q.kind === 'daily_checkin') {
    const c = await db.dailyCheckin.findUnique({ where: { userId } })
    const today = new Date().toISOString().slice(0, 10)
    return {
      progress: c?.lastDate === today ? 1 : 0, // 1 = сегодня уже зачтено
      goal: null,
      streak: c?.streak ?? 0,
    }
  }
  return { progress: null, goal: null, streak: null }
}

/**
 * Атомарная выдача награды за одноразовое задание: completion (уникальная
 * пара quest+user страхует от двойного тапа) + increment + журнал — ОДНА
 * транзакция; баланс не уходит в минус (только increment). Используется и
 * обычным claim, и VLM-проверкой TikTok.
 */
export async function grantQuestCompletion(
  quest: { id: string; title: string; rewardSwp: number },
  userId: string,
): Promise<number | null> {
  const balance = await db
    .$transaction(async (tx) => {
      const created = await tx.questCompletion
        .create({
          data: {
            questId: quest.id,
            userId,
            status: 'done',
            rewardSwp: quest.rewardSwp,
            lastCheck: new Date(),
          },
        })
        .catch((e: { code?: string }) => {
          if (e?.code === 'P2002') return null // параллельный тап успел первым
          throw e
        })
      if (!created) return null
      const updated = await tx.user.update({
        where: { id: userId },
        data: { swipes: { increment: quest.rewardSwp } },
        select: { swipes: true },
      })
      await tx.balanceLog
        .create({
          data: {
            userId,
            kind: 'quest',
            currency: 'swp',
            amount: quest.rewardSwp,
            note: `Задание: ${quest.title}`,
          },
        })
        .catch(() => {})
      return updated.swipes
    })
    .catch((e: { code?: string }) => {
      if (e?.code === 'P2002') return null
      throw e
    })
  if (balance === null) return null

  await invalidateBalance(userId).catch(() => {})
  notifyQuestReward(userId, quest.title, quest.rewardSwp, balance)
  // v5.75: задание — +5 XP (геймификация: задания теперь качают и уровень)
  void grantXp(userId, 'quest', XP_RULES.quest, `Задание: ${quest.title}`)
  return balance
}

export async function claimQuest(userId: string, questId: string): Promise<ClaimResult> {
  const [user, quest] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: { id: true, swipes: true, photoUrl: true, firstName: true, lastName: true, username: true },
    }),
    db.quest.findUnique({ where: { id: questId } }),
  ])
  if (!user || !quest || !quest.active) return { status: 'unavailable' }

  const existing = await db.questCompletion.findUnique({
    where: { questId_userId: { questId, userId } },
  })
  if (existing) {
    return existing.status === 'done' ? { status: 'already' } : { status: 'revoked' }
  }

  // Гости не зарабатывают (свайпы гостей стерилизуются; фронт и так шлёт на логин)
  if (userId.startsWith('guest_')) return { status: 'cannot_verify' }

  const link = questLinkFor(quest.kind, quest.target, quest.link)

  /* --------- Ежедневный вход: автозачёт раз в сутки, серия 7 дней --------- */
  if (quest.kind === 'daily_checkin') return claimDailyQuest(user, quest)

  /* --------- TikTok: проверяется скриншотом через VLM (отдельный роут) --------- */
  if (quest.kind === 'tiktok_follow') return { status: 'need_screenshot', link }

  /* --------- Подписка на канал / вступление в чат --------- */
  if (quest.kind === 'subscribe' || quest.kind === 'join_chat') {
    // Приватный инвайт без привязанного chat_id: боту нечем проверить — честно
    // сообщаем «недоступно» (привяжется из админки, когда бот добавлен в чат).
    if (quest.targetType === 'invite') return { status: 'cannot_verify', link }
    const tgId = tgIdOf(userId)
    if (tgId === null) return { status: 'cannot_verify' }
    // target: @username ИЛИ числовой chat_id — isTelegramMember понимает оба
    const member = await isTelegramMember(quest.target, tgId)
    if (member === null) return { status: 'cannot_verify' }
    if (member === false) return { status: 'not_member', link }
    const balance = await grantQuestCompletion(quest, userId)
    return balance === null ? { status: 'already' } : { status: 'done', reward: quest.rewardSwp, balance }
  }

  /* --------- Буст канала (как в розыгрышах: getUserChatBoosts) --------- */
  if (quest.kind === 'boost') {
    const tgId = tgIdOf(userId)
    if (tgId === null) return { status: 'cannot_verify' }
    const boosts = await getUserChatBoosts(quest.target, tgId)
    if (boosts === null) return { status: 'cannot_verify', link }
    if (boosts <= 0) return { status: 'no_boost', link }
    const balance = await grantQuestCompletion(quest, userId)
    return balance === null ? { status: 'already' } : { status: 'done', reward: quest.rewardSwp, balance }
  }

  /* --------- Заполнение профиля (аватар + имя) --------- */
  if (quest.kind === 'profile_setup') {
    if (!userProfileComplete(user)) return { status: 'not_done' }
    const balance = await grantQuestCompletion(quest, userId)
    return balance === null ? { status: 'already' } : { status: 'done', reward: quest.rewardSwp, balance }
  }

  /* --------- Активность в ленте (просмотры постов) --------- */
  if (quest.kind === 'activity_milestone') {
    const mt = parseMilestoneTarget(quest.target)
    if (!mt) return { status: 'cannot_verify' }
    const progress = await milestoneProgress(userId, mt.metric)
    if (progress < mt.goal) return { status: 'not_done', link: '' }
    const balance = await grantQuestCompletion(quest, userId)
    return balance === null ? { status: 'already' } : { status: 'done', reward: quest.rewardSwp, balance }
  }

  /* --------- Пригласи друга (активированные рефералы) --------- */
  if (quest.kind === 'referral') {
    const goal = Math.max(1, Math.round(Number(quest.target)) || 1)
    const invited = await referralProgress(userId)
    if (invited < goal) return { status: 'not_done', link: '' }
    const balance = await grantQuestCompletion(quest, userId)
    return balance === null ? { status: 'already' } : { status: 'done', reward: quest.rewardSwp, balance }
  }

  return { status: 'cannot_verify' }
}

/* --------------------------- Ежедневный вход --------------------------- */

export const DAILY_STREAK_BONUS = 400 // за 7 дней подряд (v5.74: ×4 вслед за ценами ИИ)
export const DAILY_BONUS_EVERY = 7

function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10)
}

class DailyTakenError extends Error {}

/**
 * Ежедневный вход: зачёт раз в сутки (UTC) + серия. Серия 7 дней подряд
 * даёт бонус (+100 свайпов к базовой награде). Атомарность: создание записи
 * или условный updateMany (lastDate != сегодня) — параллельные тапы/автозачёт
 * не задвоят награду.
 */
async function claimDailyQuest(
  user: { id: string; swipes: number },
  quest: { id: string; title: string; rewardSwp: number },
): Promise<ClaimResult> {
  const today = utcDay()
  const existing = await db.dailyCheckin.findUnique({ where: { userId: user.id } })
  if (existing?.lastDate === today) {
    return { status: 'already', streak: existing.streak, balance: user.swipes }
  }

  const yesterday = utcDay(new Date(Date.now() - 86_400_000))
  const prevStreak = existing && existing.lastDate === yesterday ? existing.streak : 0
  const streak = prevStreak + 1
  const bonus = streak % DAILY_BONUS_EVERY === 0 ? DAILY_STREAK_BONUS : 0
  const reward = quest.rewardSwp + bonus

  const balance = await db
    .$transaction(async (tx) => {
      if (!existing) {
        await tx.dailyCheckin.create({
          data: { userId: user.id, streak, bestStreak: streak, lastDate: today, totalCheckins: 1 },
        })
      } else {
        const upd = await tx.dailyCheckin.updateMany({
          where: { userId: user.id, lastDate: { not: today } },
          data: {
            streak,
            bestStreak: Math.max(existing.bestStreak, streak),
            lastDate: today,
            totalCheckins: { increment: 1 },
          },
        })
        if (!upd.count) throw new DailyTakenError() // параллельный запрос успел первым
      }
      const updated = await tx.user.update({
        where: { id: user.id },
        data: { swipes: { increment: reward } },
        select: { swipes: true },
      })
      await tx.balanceLog
        .create({
          data: {
            userId: user.id,
            kind: 'quest',
            currency: 'swp',
            amount: reward,
            note: `Задание: ${quest.title}${bonus ? ` · серия ${streak} дн. (бонус +${DAILY_STREAK_BONUS})` : ''}`,
          },
        })
        .catch(() => {})
      return updated.swipes
    })
    .catch((e: unknown) => {
      if ((e as { code?: string })?.code === 'P2002' || e instanceof DailyTakenError) return null
      throw e
    })
  if (balance === null) {
    return { status: 'already', streak: existing?.streak ?? streak, balance: user.swipes }
  }

  await invalidateBalance(user.id).catch(() => {})
  notifyQuestReward(user.id, quest.title, reward, balance)
  // v5.75: ежедневный чек-ин — +3 XP
  void grantXp(user.id, 'checkin', XP_RULES.checkin, 'Ежедневный чек-ин')
  return { status: 'done', reward, bonus, balance, streak }
}

/* ------------------------- Уведомление о награде ------------------------- */

function notifyQuestReward(userId: string, title: string, reward: number, balance: number): void {
  void (async () => {
    try {
      const swpWord = plural(reward, 'свайп', 'свайпа', 'свайпов')
      const title2 = `✅ Задание выполнено: +${reward} ${swpWord}!`
      const body = `«${title}». Баланс: ${balance} ${plural(balance, 'свайп', 'свайпа', 'свайпов')}.`
      await db.notification
        .create({ data: { userId, type: 'system', title: title2, body: body.slice(0, 200) } })
        .catch(() => {})
      emitAppEvent('notif:new', { userId })
      sendBotNotification({ userId, type: 'system', title: title2, body })
    } catch (e) {
      console.error('[quests] notify reward', e)
    }
  })()
}

function notifyQuestRevoke(userId: string, title: string, penalty: number, balance: number): void {
  void (async () => {
    try {
      const t = `⚠️ Награда за задание аннулирована`
      const b = `Вы отписались от цели задания «${title}». Списано ${penalty} ${plural(
        penalty,
        'свайп',
        'свайпа',
        'свайпов',
      )} (награда ×2). Баланс: ${balance}.`
      await db.notification
        .create({ data: { userId, type: 'system', title: t, body: b.slice(0, 200) } })
        .catch(() => {})
      emitAppEvent('notif:new', { userId })
      sendBotNotification({ userId, type: 'system', title: t, body: b })
    } catch (e) {
      console.error('[quests] notify revoke', e)
    }
  })()
}

/* ---------------------------- Реверификация ---------------------------- */

export type ReverifyResult = { checked: number; revoked: number; skipped: boolean }

/**
 * Перепроверка членства у выполненных заданий (очередь: самая старая проверка
 * — первая). Вызывается из /api/parse/tick с бюджетом на тик: при тысячах
 * юзеров полный цикл растягивается на минуты равномерно, Bot API не флудим.
 * ТОЛЬКО задания на членство (subscribe/join_chat): автозачётные виды
 * (daily/profile/milestone/referral) и буст реверификации не подлежат.
 * member=true → штамп lastCheck/checks; member=false → аннулирование + штраф ×2.
 */
export async function reverifyQuestCompletions(budget = 10): Promise<ReverifyResult> {
  if (!botEnabled()) return { checked: 0, revoked: 0, skipped: true }

  const rows = await db.questCompletion.findMany({
    where: { status: 'done', quest: { active: true, kind: { in: REVERIFY_KINDS } } },
    orderBy: { lastCheck: 'asc' },
    take: Math.max(1, Math.min(budget, 30)),
    select: {
      id: true,
      userId: true,
      rewardSwp: true,
      quest: { select: { id: true, title: true, target: true } },
    },
  })
  if (rows.length === 0) return { checked: 0, revoked: 0, skipped: false }

  let revoked = 0
  let checked = 0

  await Promise.allSettled(
    rows.map(async (row) => {
      const tgId = tgIdOf(row.userId)
      if (tgId === null) return
      const member = await isTelegramMember(row.quest.target, tgId, { fresh: true })
      if (member === null) return // проверка моргнула — попробуем на следующем тике

      if (member === true) {
        checked++
        await db.questCompletion
          .update({
            where: { id: row.id },
            data: { lastCheck: new Date(), checks: { increment: 1 } },
          })
          .catch(() => {})
        return
      }

      // Отписался: аннулирование (updateMany со статусом — гонки исключены)
      // + штраф ×2 в пределах баланса (в минус не уводим).
      const closed = await db.questCompletion
        .updateMany({ where: { id: row.id, status: 'done' }, data: { status: 'revoked' } })
        .catch(() => ({ count: 0 }))
      if (!closed.count) return
      checked++
      revoked++

      const penalty = row.rewardSwp * 2
      // v5.54: полный штраф — условным декрементом. Раньше ветка «баланса не хватает»
      // списывала ровно 1 свайп вместо остатка, а в журнал писала весь баланс.
      const full = await db.user
        .updateMany({
          where: { id: row.userId, swipes: { gte: penalty } },
          data: { swipes: { decrement: penalty } },
        })
        .catch(() => ({ count: 0 }))
      let applied = penalty
      if (!full.count) {
        // баланса не хватает на весь штраф — забираем фактический остаток:
        // CAS-обнуление (WHERE swipes = остаток) с одним ретраем при гонке
        const cur = await db.user
          .findUnique({ where: { id: row.userId }, select: { swipes: true } })
          .catch(() => null)
        const rest = cur?.swipes ?? 0
        applied = 0
        if (rest > 0) {
          const zeroed = await db.user
            .updateMany({ where: { id: row.userId, swipes: rest }, data: { swipes: 0 } })
            .catch(() => ({ count: 0 }))
          if (zeroed.count) applied = rest
          else {
            const cur2 = await db.user
              .findUnique({ where: { id: row.userId }, select: { swipes: true } })
              .catch(() => null)
            const rest2 = cur2?.swipes ?? 0
            if (rest2 > 0) {
              const z2 = await db.user
                .updateMany({ where: { id: row.userId, swipes: rest2 }, data: { swipes: 0 } })
                .catch(() => ({ count: 0 }))
              if (z2.count) applied = rest2
            }
          }
        }
      }
      if (applied > 0) {
        await db.balanceLog
          .create({
            data: {
              userId: row.userId,
              kind: 'quest_revoke',
              currency: 'swp',
              amount: -applied,
              note: `Аннулирование задания: ${row.quest.title}`,
            },
          })
          .catch(() => {})
        await invalidateBalance(row.userId).catch(() => {})
      }
      const u = await db.user
        .findUnique({ where: { id: row.userId }, select: { swipes: true } })
        .catch(() => null)
      notifyQuestRevoke(row.userId, row.quest.title, applied, u?.swipes ?? 0)
    }),
  )

  return { checked, revoked, skipped: false }
}

/* ------------------------- Валидация для админки ------------------------- */

export type TargetValidation = {
  ok: boolean
  target: string | null
  title?: string
  members?: number | null
  /** null — бот настроен и состоит в цели; строка — причина, почему проверка не сработает */
  verificationProblem?: string | null
}

/**
 * Проверка цели при создании/правке задания в панели: цель существует (getChat),
 * бот в ней состоит (getChatMember по себе). Светит проблему ДО публикации,
 * а не когда юзеры не смогут получить награду. Понимает @username, числовой
 * chat_id и инвайт-ссылки (последние честно «непроверяемы» до привязки chat_id).
 */
export async function validateQuestTarget(raw: string): Promise<TargetValidation> {
  const t = parseQuestTarget(raw)
  if (!t) return { ok: false, target: null, verificationProblem: 'Некорректный @username' }
  if (!botEnabled()) {
    return { ok: true, target: t.value, verificationProblem: 'TELEGRAM_BOT_TOKEN не настроен — проверка работать не будет' }
  }
  if (t.type === 'invite') {
    return {
      ok: true,
      target: t.value,
      verificationProblem:
        'Инвайт-ссылку нельзя проверить через Bot API. Добавь бота админом в чат и привяжи chat_id в форме — до привязки юзерам будет «проверка недоступна».',
    }
  }
  try {
    const chatIdArg = t.type === 'chat_id' ? Number(t.value) : `@${t.value}`
    const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN?.trim()}/getChat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatIdArg }),
      signal: AbortSignal.timeout(8000),
    })
    const data = (await res.json()) as {
      ok?: boolean
      result?: { title?: string; username?: string; members_count?: number }
      description?: string
    }
    if (!data?.ok) {
      return { ok: false, target: t.value, verificationProblem: `Цель не найдена: ${data?.description ?? 'getChat failed'}` }
    }
    // Бот участник цели? getChatMember по самому боту (id из getMe, кэш 10 мин)
    const botId = await getBotId()
    let problem: string | null = null
    if (botId === null) {
      problem = 'Не удалось определить id бота'
    } else {
      const self = await isTelegramMember(t.value, botId)
      if (self === false) problem = 'Бот НЕ состоит в цели — добавьте его админом, иначе проверка не сработает'
      else if (self === null) problem = 'Не удалось проверить членство бота (429/скрытые участники?)'
    }
    return {
      ok: true,
      target: t.value,
      title: data.result?.title,
      members: data.result?.members_count ?? null,
      verificationProblem: problem,
    }
  } catch {
    return { ok: true, target: t.value, verificationProblem: 'Bot API недоступен — цель не проверена' }
  }
}

let botIdCache: { id: number | null; exp: number } | null = null

/** Числовой id самого бота (getMe, кэш 10 минут) — для getChatMember по себе */
async function getBotId(): Promise<number | null> {
  if (botIdCache && botIdCache.exp > Date.now()) return botIdCache.id
  try {
    const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN?.trim()}/getMe`, {
      method: 'POST',
      signal: AbortSignal.timeout(8000),
    })
    const data = (await res.json()) as { ok?: boolean; result?: { id?: number } }
    const id = data?.ok ? data.result?.id ?? null : null
    botIdCache = { id, exp: Date.now() + 10 * 60_000 }
    return id
  } catch {
    return null
  }
}
