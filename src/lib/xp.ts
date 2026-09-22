import { db } from '@/lib/db'
import { invalidateBalance } from '@/lib/balance-cache'
import { sendBotNotification } from '@/lib/bot-notify'
import { emitAppEvent } from '@/lib/events'
import { levelFromXp, levelProgress, swipesForLevelUp, type LevelProgress } from '@/lib/xp-rules'

/**
 * СИСТЕМА УРОВНЕЙ (v5.75) — XP за полезную активность, штрафы за нарушения.
 *
 * ПРИНЦИПЫ:
 *  • XP капает за то, что делает приложение живее: толковый комментарий (+2),
 *    лайк на комментарии (+1 автору), задание (+5), ежедневный чек-ин (+3).
 *  • Нарушения бьют заметно сильнее, чем награда за вклад: комментарий,
 *    скрытый по жалобам или удалённый админом, −15 XP; бан −50 XP.
 *    Уровень при этом НЕ откатывается (как в Telegram) — только XP.
 *  • Дневные лимиты против фарма: комментарии — не больше 10 × (+2) в сутки,
 *    лайки — не больше 30 × (+1) в сутки. Лимит честный по UTC-дню.
 *  • XP за найденные баги выдаёт ТОЛЬКО админ вручную (панель → пользователи →
 *    «XP»): никаких авто-начислений за «жалобу на баг», иначе будут абузить.
 *  • Повышение уровня — награда свайпами, растёт с уровнем: 60 + 40·level
 *    (ур. 2 → 140, ур. 5 → 260, ур. 10 → 460, ур. 20 → 860). Порог XP тоже
 *    растёт: 100, 160, 220, 280… (+60 за каждый следующий уровень).
 *
 * Значения и кривая уровней — в клиентском lib/xp-rules.ts (общий источник
 * правды для сервера и UI). Здесь — только транзакционная механика.
 *
 * ИНВАРИАНТЫ:
 *  • xp ≥ 0 (штраф не уводит в минус), level монотонно не убывает;
 *  • все начисления — журнал XpLog (знаковый amount), свайпы за уровень —
 *    журнал BalanceLog kind 'level_up';
 *  • гости не зарабатывают (у гостей кошелёк стерилизован — как в заданиях).
 */

export {
  XP_RULES,
  xpStepForLevel,
  xpForLevel,
  levelFromXp,
  swipesForLevelUp,
  levelProgress,
  type LevelProgress,
} from '@/lib/xp-rules'

export type GrantResult = {
  ok: boolean
  xp: number
  level: number
  /** true — уровень повысился (rewardSwipes уже зачислены) */
  levelUp: boolean
  levelsGained: number
  rewardSwipes: number
  progress: LevelProgress
}

/**
 * Начислить/списать XP атомарно. Безопасно вызывать и await'ом, и
 * fire-and-forget: ошибки логируются, наружу отдаётся null — сбой XP-логики
 * не должен ломать основной сценарий (комментарий/лайк/бан должны работать).
 *
 * При переходе через уровень(и) — разом начисляет свайпы за ВСЕ пройденные
 * уровни, пишет BalanceLog 'level_up' и кладёт уведомление в инбокс + бот.
 */
export async function grantXp(
  userId: string,
  kind: 'comment' | 'like' | 'quest' | 'checkin' | 'bug' | 'violation' | 'admin' | 'achievement',
  amount: number,
  note?: string,
): Promise<GrantResult | null> {
  // Гости не зарабатывают и не теряют XP (у них нет кошелька и профиля)
  if (userId.startsWith('guest_')) return null
  if (!Number.isFinite(amount) || amount === 0) return null

  try {
    const res = await db.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { xp: true, level: true },
      })
      if (!user) return null

      const newXp = Math.max(0, user.xp + Math.round(amount))
      // Уровень монотонно не убывает: штрафы не откатывают уровень
      const newLevel = Math.max(user.level, levelFromXp(newXp))
      const levelsGained = newLevel - user.level
      const rewardSwipes =
        levelsGained > 0
          ? Array.from(
              { length: levelsGained },
              (_, i) => swipesForLevelUp(user.level + 1 + i),
            ).reduce((a, b) => a + b, 0)
          : 0

      await tx.user.update({
        where: { id: userId },
        data: {
          xp: newXp,
          level: newLevel,
          ...(rewardSwipes > 0 ? { swipes: { increment: rewardSwipes } } : {}),
        },
      })

      await tx.xpLog.create({
        data: { userId, kind, amount: Math.round(amount), note: note ?? null },
      })

      if (rewardSwipes > 0) {
        await tx.balanceLog.create({
          data: {
            userId,
            kind: 'level_up',
            currency: 'swp',
            amount: rewardSwipes,
            note:
              levelsGained > 1
                ? `Уровни ${user.level + 1}–${newLevel}: награда за прогресс`
                : `Уровень ${newLevel}: награда за прогресс`,
          },
        })
      }

      return { xp: newXp, level: newLevel, levelsGained, rewardSwipes }
    })

    if (!res) return null

    if (res.levelsGained > 0) {
      // v5.90: уровень поднялся — проверяем ачивки прогресса («Восхождение»).
      // Динамический импорт разрывает цикл (achievements-server статически
      // импортирует grantXp для наград XP).
      void import('@/lib/achievements-server')
        .then((m) => m.evaluateAchievements(userId, 'level'))
        .catch(() => {})
    }

    if (res.rewardSwipes > 0) {
      await invalidateBalance(userId).catch(() => {})
      // Уведомление в инбокс + ЛС бота (уровень — событие, которое хочется увидеть)
      const title =
        res.levelsGained > 1 ? `Новый уровень: ${res.level}!` : `Достигнут уровень ${res.level}!`
      const body = `Награда: +${res.rewardSwipes} свайпов. Продолжай в том же духе — дальше больше.`
      try {
        await db.notification.create({ data: { userId, type: 'system', title, body } })
        emitAppEvent('notif:new', { userId })
        sendBotNotification({ userId, type: 'system', title, body })
      } catch (e) {
        console.error('[xp] level-up notify failed', (e as Error).message)
      }
    }

    return {
      ok: true,
      xp: res.xp,
      level: res.level,
      levelUp: res.levelsGained > 0,
      levelsGained: res.levelsGained,
      rewardSwipes: res.rewardSwipes,
      progress: levelProgress(res.xp, res.level),
    }
  } catch (e) {
    console.error('[xp/grant]', e)
    return null
  }
}

/** Начало UTC-дня (для дневных лимитов) */
export function utcDayStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/** Сколько XP уже начислено сегодня по конкретному виду (для дневных лимитов) */
export async function xpEarnedTodayByKind(userId: string, kind: string): Promise<number> {
  try {
    const agg = await db.xpLog.aggregate({
      where: { userId, kind, createdAt: { gte: utcDayStart() }, amount: { gt: 0 } },
      _sum: { amount: true },
    })
    return agg._sum.amount ?? 0
  } catch (e) {
    console.error('[xp/today]', e)
    return 0 // при сбое лимит считать исчерпанным не будем — начислится без XP-вреда
  }
}

/**
 * Начислить XP с дневным лимитом (комментарии/лайки). Если лимит исчерпан —
 * просто ничего не делаем (без записей в журнал): активность не штрафуем.
 * cap передаётся в «сырых» XP за сутки (например, commentDailyCap * comment = 20).
 */
export async function grantXpWithDailyCap(
  userId: string,
  kind: 'comment' | 'like',
  cap: number,
  note?: string,
): Promise<GrantResult | null> {
  const earned = await xpEarnedTodayByKind(userId, kind)
  if (earned >= cap) return null
  const amount = kind === 'comment' ? 2 : 1
  return grantXp(userId, kind, amount, note)
}

/** Журнал XP пользователя (новые сверху) — для шита уровня */
export async function xpHistory(userId: string, take = 15) {
  return db.xpLog.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take,
    select: { id: true, kind: true, amount: true, note: true, createdAt: true },
  })
}
