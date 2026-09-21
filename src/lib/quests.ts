import { db } from '@/lib/db'
import { botEnabled, isTelegramMember } from '@/lib/tg-bot'
import { emitAppEvent } from '@/lib/events'
import { sendBotNotification } from '@/lib/bot-notify'
import { plural } from '@/lib/giveaway-tickets'
import { invalidateBalance } from '@/lib/balance-cache'

/**
 * ЗАДАНИЯ С НАГРАДОЙ (v5.51) — вкладка «Задания» вместо «Тренды».
 *
 * Механика:
 *  • админ создаёт задание: подписка на канал или вступление в чат
 *    (цель — публичный @username; бот должен быть админом цели для проверки);
 *  • юзер тапает «Получить N свайпов»: нет в цели → открываем ссылку,
 *    повторный тап проверяет членство через Bot API getChatMember и
 *    начисляет награду АТОМАРНО (уникальная пара quest+user, баланс ≥ 0);
 *  • УМНАЯ ЗАЩИТА ОТ ФАРМИНГА: реверификация по расписанию (parse/tick,
 *    бюджет на тик) перепроверяет членство. Отписался → задание аннулируется
 *    НАВСЕГДА (повторно выполнить нельзя) и списывается ДВОЙНАЯ награда
 *    (в пределах баланса — в минус не уводим);
 *  • проверка недоступна (бот не админ/429) → юзеру ничего не начисляем,
 *    а очередь реверификации просто ждёт следующего тика.
 */

export type QuestKind = 'subscribe' | 'join_chat'

export const QUEST_KINDS: QuestKind[] = ['subscribe', 'join_chat']

export function isQuestKind(v: string): v is QuestKind {
  return QUEST_KINDS.includes(v as QuestKind)
}

/** Иконка вида задания — зеркало для фронта и бота */
export const QUEST_KIND_META: Record<QuestKind, { emoji: string; label: string }> = {
  subscribe: { emoji: '📢', label: 'Подписка на канал' },
  join_chat: { emoji: '💬', label: 'Вступление в чат' },
}

/* --------------------------- Нормализация цели --------------------------- */

const USERNAME_RE = /^[a-zA-Z](?:[a-zA-Z0-9_]{3,63})$/

/**
 * Привести ввод админа к каноничному username без @:
 * «https://t.me/Foo», «t.me/foo/», «@foo», «foo» → «foo» (lowercase).
 * null — не похоже на публичный @username (приватные id проверять нечем:
 * isTelegramMember ходит по chat_id=@username).
 */
export function normalizeQuestTarget(raw: string): string | null {
  let s = (raw ?? '').trim()
  if (!s) return null
  s = s.replace(/^https?:\/\//i, '').replace(/^www\./i, '')
  if (/^t\.me\//i.test(s) || /^telegram\.me\//i.test(s)) {
    s = s.replace(/^(t|telegram)\.me\//i, '')
    s = s.split(/[/?#]/)[0] // t.me/foo/joinchat/… → foo
  }
  s = s.replace(/^@/, '').toLowerCase()
  if (!USERNAME_RE.test(s)) return null
  return s
}

export function questLinkOf(target: string, custom?: string | null): string {
  if (custom && custom.trim()) return custom.trim()
  return `https://t.me/${target.replace(/^@/, '')}`
}

/* ------------------------------ Награждение ------------------------------ */

export type ClaimStatus =
  | 'done' // выполнено сейчас, награда начислена
  | 'already' // уже было выполнено ранее
  | 'revoked' // было отозвано (отписался) — повторно нельзя
  | 'not_member' // юзер не в канале/чате
  | 'cannot_verify' // проверка недоступна (бот не админ цели / 429 / нет токена)
  | 'unavailable' // задание неактивно/удалено

export type ClaimResult = {
  status: ClaimStatus
  reward?: number
  balance?: number
  link?: string
}

export async function claimQuest(userId: string, questId: string): Promise<ClaimResult> {
  const [user, quest] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { id: true, swipes: true } }),
    db.quest.findUnique({ where: { id: questId } }),
  ])
  if (!user || !quest || !quest.active) return { status: 'unavailable' }

  const existing = await db.questCompletion.findUnique({
    where: { questId_userId: { questId, userId } },
  })
  if (existing) {
    return existing.status === 'done' ? { status: 'already' } : { status: 'revoked' }
  }

  const tgId = Number(userId.startsWith('tg_') ? userId.slice(3) : NaN)
  if (!Number.isInteger(tgId) || tgId <= 0) return { status: 'cannot_verify' }

  const link = questLinkOf(quest.target, quest.link)
  const member = await isTelegramMember(quest.target, tgId)
  if (member === null) return { status: 'cannot_verify' }
  if (member === false) return { status: 'not_member', link }

  // Членство подтверждено → атомарная выдача: уникальная пара quest+user
  // страхует от двойного тапа, баланс не уходит в минус (только increment).
  // v5.54: completion + increment + журнал — ОДНА транзакция: раньше сбой между
  // create и increment терял награду навсегда (повторный claim отдавал 'already').
  const balance = await db
    .$transaction(async (tx) => {
      const created = await tx.questCompletion
        .create({
          data: {
            questId,
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
  if (balance === null) return { status: 'already' }

  await invalidateBalance(userId).catch(() => {})

  notifyQuestReward(userId, quest.title, quest.rewardSwp, balance)
  return { status: 'done', reward: quest.rewardSwp, balance }
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
 * member=true → штамп lastCheck/checks; member=false → аннулирование + штраф ×2.
 */
export async function reverifyQuestCompletions(budget = 10): Promise<ReverifyResult> {
  if (!botEnabled()) return { checked: 0, revoked: 0, skipped: true }

  const rows = await db.questCompletion.findMany({
    where: { status: 'done', quest: { active: true } },
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
      const tgId = Number(row.userId.startsWith('tg_') ? row.userId.slice(3) : NaN)
      if (!Number.isInteger(tgId) || tgId <= 0) return
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
 * а не когда юзеры не смогут получить награду.
 */
export async function validateQuestTarget(raw: string): Promise<TargetValidation> {
  const target = normalizeQuestTarget(raw)
  if (!target) return { ok: false, target: null, verificationProblem: 'Некорректный @username' }
  if (!botEnabled()) {
    return { ok: true, target, verificationProblem: 'TELEGRAM_BOT_TOKEN не настроен — проверка работать не будет' }
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN?.trim()}/getChat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: `@${target}` }),
      signal: AbortSignal.timeout(8000),
    })
    const data = (await res.json()) as {
      ok?: boolean
      result?: { title?: string; username?: string; members_count?: number }
      description?: string
    }
    if (!data?.ok) {
      return { ok: false, target, verificationProblem: `Цель не найдена: ${data?.description ?? 'getChat failed'}` }
    }
    // Бот участник цели? getChatMember по самому боту (id из getMe, кэш 10 мин)
    const botId = await getBotId()
    let problem: string | null = null
    if (botId === null) {
      problem = 'Не удалось определить id бота'
    } else {
      const self = await isTelegramMember(target, botId)
      if (self === false) problem = 'Бот НЕ состоит в цели — добавьте его админом, иначе проверка не сработает'
      else if (self === null) problem = 'Не удалось проверить членство бота (429/скрытые участники?)'
    }
    return {
      ok: true,
      target,
      title: data.result?.title,
      members: data.result?.members_count ?? null,
      verificationProblem: problem,
    }
  } catch {
    return { ok: true, target, verificationProblem: 'Bot API недоступен — цель не проверена' }
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
