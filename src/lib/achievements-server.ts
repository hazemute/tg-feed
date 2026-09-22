import { db } from '@/lib/db'
import { invalidateBalance } from '@/lib/balance-cache'
import { emitAppEvent } from '@/lib/events'
import { sendBotNotification } from '@/lib/bot-notify'
import {
  ACHIEVEMENTS,
  ACHIEVEMENT_MAP,
  type AchievementMetric,
  type AchievementsResponse,
  type AchievementRow,
} from '@/lib/achievements'

/**
 * Движок достижений (v5.90) — серверная часть.
 *
 * ПРИНЦИПЫ:
 *  • evaluateAchievements(userId, event) вызывается fire-and-forget из
 *    событий (лайк/комментарий/закладка/задание/чек-ин/уровень) — сбой
 *    ачивок НЕ должен ломать основной сценарий (все ошибки только в лог);
 *  • анти-частота: не чаще 1 проверки в минуту на (юзер × событие) —
 *    хранилище на globalThis (route-бандлы Next.js изолированы, как в
 *    page-cache/bot-notify); quest/checkin/level проверяются всегда (редкие);
 *  • идемпотентность: unique(userId, achievementId), tier — достигнутый
 *    максимум; параллельное начисление ловится на P2002;
 *  • метрики — count/сумма по готовым индексам (Like.userId, Comment.userId,
 *    PostView(userId,createdAt), Bookmark.userId, QuestCompletion(userId,status));
 *  • награды: свайпы — транзакцией с BalanceLog kind 'achievement',
 *    XP — grantXp(kind 'achievement'), инбокс — Notification type 'system',
 *    ЛС бота — ТОЛЬКО на золотую ступень (иначе спам);
 *  • гости не участвуют (гость не имеет кошелька/профиля).
 */

/* ------------------- Анти-частота (globalThis-синглтон) ------------------- */

type AchGuard = { at: Map<string, number>; rev: number }
const g = globalThis as typeof globalThis & { __achGuard?: AchGuard }
function guard(): AchGuard {
  if (!g.__achGuard) g.__achGuard = { at: new Map(), rev: 0 }
  return g.__achGuard
}

/** Минимальный интервал между проверками по событию (мс); 0 — проверять всегда */
const EVENT_INTERVAL_MS: Record<string, number> = {
  like: 60_000,
  comment: 60_000,
  bookmark: 60_000,
  subscription: 60_000,
  view: 10 * 60_000, // лёгкая view-проверка — не чаще раза в 10 минут
  quest: 0,
  checkin: 0,
  level: 0,
  /** тихая синхронизация при открытии шита достижений — раз в 5 минут;
   * закрывает «бэктест» для существующих юзеров (уровень/метрики накоплены
   * ДО введения ачивок) */
  sync: 5 * 60_000,
}

function underCooldown(userId: string, event: string): boolean {
  const ms = EVENT_INTERVAL_MS[event] ?? 60_000
  if (ms <= 0) return false
  const key = `${userId}:${event}`
  const now = Date.now()
  const prev = guard().at.get(key) ?? 0
  if (now - prev < ms) return true
  // защита от роста Map: чистим редко и дёшево
  if (guard().at.size > 10_000) {
    for (const [k, ts] of guard().at) if (now - ts > 30 * 60_000) guard().at.delete(k)
  }
  guard().at.set(key, now)
  return false
}

/* ------------------------------- Метрики -------------------------------- */

export type AchMetrics = Record<AchievementMetric, number>

/** Батч метрик одним Promise.all — все запросы идут по готовым индексам */
export async function readMetrics(userId: string): Promise<AchMetrics> {
  const [views, likesGiven, comments, bookmarks, likesReceivedAgg, checkin, user, subs, quests] =
    await Promise.all([
      db.postView.count({ where: { userId } }),
      db.like.count({ where: { userId } }),
      db.comment.count({ where: { userId, hidden: false } }),
      db.bookmark.count({ where: { userId } }),
      db.comment.aggregate({
        where: { userId, hidden: false },
        _sum: { likesCount: true },
      }),
      db.dailyCheckin.findUnique({
        where: { userId },
        select: { bestStreak: true, totalCheckins: true },
      }),
      db.user.findUnique({ where: { id: userId }, select: { level: true } }),
      db.subscription.count({ where: { userId } }),
      db.questCompletion.count({ where: { userId, status: 'done' } }),
    ])
  return {
    views,
    likes_given: likesGiven,
    comments,
    bookmarks,
    likes_received: likesReceivedAgg._sum.likesCount ?? 0,
    streak: checkin?.bestStreak ?? 0,
    checkins: checkin?.totalCheckins ?? 0,
    level: user?.level ?? 1,
    subscriptions: subs,
    quests,
  }
}

/* ----------------------------- Разблокировки ----------------------------- */

type UnlockResult = {
  unlocked: { id: string; fromTier: number; toTier: number; nameRu: string; swipes: number; xp: number }[]
}

/**
 * Проверить ачивки юзера по событию. event: like|comment|bookmark|quest|
 * checkin|level|subscription|view. Возвращает список НОВЫХ ступеней
 * (пустой — если ничего нового; guest → пусто всегда).
 */
export async function evaluateAchievements(
  userId: string,
  event: string,
): Promise<UnlockResult> {
  if (userId.startsWith('guest_')) return { unlocked: [] }
  try {
    if (underCooldown(userId, event)) return { unlocked: [] }

    const metrics = await readMetrics(userId)
    const owned = await db.userAchievement.findMany({
      where: { userId },
      select: { achievementId: true, tier: true },
    })
    const ownedMap = new Map(owned.map((o) => [o.achievementId, o.tier]))

    const unlocked: UnlockResult['unlocked'] = []
    for (const def of ACHIEVEMENTS) {
      // Лёгкая оптимизация: view-событие проверяет только ачивку просмотров
      if (event === 'view' && def.metric !== 'views') continue
      const value = metrics[def.metric] ?? 0
      let earned = 0
      for (let i = 0; i < def.tiers.length; i++) {
        if (value >= def.tiers[i].value) earned = i + 1
      }
      const prev = ownedMap.get(def.id) ?? 0
      if (earned <= prev) continue

      // Награда за ВСЕ новые ступени сразу (метрика могла проскочить две)
      let swipes = 0
      let xp = 0
      for (let i = prev; i < earned; i++) {
        swipes += def.tiers[i].swipes
        xp += def.tiers[i].xp
      }

      try {
        await db.$transaction(async (tx) => {
          if (prev === 0) {
            await tx.userAchievement.create({
              data: { userId, achievementId: def.id, tier: earned },
            })
          } else {
            const upd = await tx.userAchievement.updateMany({
              where: { userId, achievementId: def.id, tier: prev },
              data: { tier: earned, tierAt: new Date() },
            })
            // параллельное начисление уже подняло tier — ничего не выдаём
            if (upd.count === 0) return
          }
          await tx.user.update({
            where: { id: userId },
            data: { swipes: { increment: swipes } },
          })
          await tx.balanceLog.create({
            data: {
              userId,
              kind: 'achievement',
              currency: 'swp',
              amount: swipes,
              note: `Достижение: ${def.name.ru} — ${tierRu(earned)}`,
            },
          })
        })
      } catch (e) {
        // P2002: параллельный вызов успел создать запись — пропускаем ступень
        if ((e as { code?: string })?.code === 'P2002') continue
        throw e
      }

      // Свайпы ушли транзакцией — обновляем кэш баланса (не критично при сбое)
      void invalidateBalance(userId).catch(() => {})

      unlocked.push({
        id: def.id,
        fromTier: prev,
        toTier: earned,
        nameRu: def.name.ru,
        swipes,
        xp,
      })

      // XP за ачивку (может поднять уровень → xp.ts дёрнет evaluate('level'))
      const { grantXp } = await import('@/lib/xp')
      void grantXp(userId, 'achievement', xp, `Достижение: ${def.name.ru} — ${tierRu(earned)}`)
    }

    if (unlocked.length > 0) {
      guard().rev++
      await notifyUnlocks(userId, unlocked).catch((e: unknown) =>
        console.error('[ach/notify]', (e as Error).message),
      )
    }
    return { unlocked }
  } catch (e) {
    console.error('[ach/evaluate]', (e as Error).message)
    return { unlocked: [] }
  }
}

/* ------------------------------ Уведомления ------------------------------ */

function tierRu(tier: number): string {
  return tier >= 3 ? 'золото' : tier === 2 ? 'серебро' : 'бронза'
}

async function notifyUnlocks(
  userId: string,
  unlocked: UnlockResult['unlocked'],
): Promise<void> {
  const { sendBotNotification } = await import('@/lib/bot-notify')
  for (const u of unlocked) {
    const title = `🏅 Достижение: ${u.nameRu} — ${tierRu(u.toTier)}`
    const body = `Награда: +${u.swipes} свайпов · +${u.xp} XP. Продолжай — впереди ещё больше!`
    await db.notification
      .create({ data: { userId, type: 'system', title, body: body.slice(0, 200) } })
      .catch(() => {})
    // ЛС бота — только финальная (золотая) ступень: не дёргаем юзера на каждую бронзу
    if (u.toTier >= 3 && u.fromTier < 3) {
      sendBotNotification({ userId, type: 'system', title, body })
    }
  }
  emitAppEvent('notif:new', { userId })
}

/* ------------------ Лёгкая проверка ачивки просмотров -------------------- */

/**
 * Дешёвая проверка «Листателя»: ОДИН count по PostView + чтение записи,
 * вызывается из /api/view при added > 0 (guard 10 минут на юзера).
 * Отдельно от evaluateAchievements, чтобы батч метрик не гонялся на каждый
 * просмотр (view — самое частое событие в приложении).
 */
export async function evaluateViewsAchievement(userId: string): Promise<void> {
  if (userId.startsWith('guest_')) return
  try {
    if (underCooldown(userId, 'view')) return
    const views = await db.postView.count({ where: { userId } })
    const def = ACHIEVEMENT_MAP.get('viewer')
    if (!def) return
    let earned = 0
    for (let i = 0; i < def.tiers.length; i++) {
      if (views >= def.tiers[i].value) earned = i + 1
    }
    if (earned === 0) return
    // unlockOne сам проверит текущий tier (идемпотентно) и выдаст награду
    await unlockOne(userId, 'viewer', earned)
  } catch (e) {
    console.error('[ach/view]', (e as Error).message)
  }
}

/** Начислить одну ступень одной ачивки (награда + XP + уведомления) */
async function unlockOne(userId: string, achId: string, earned: number): Promise<UnlockResult> {
  const def = ACHIEVEMENT_MAP.get(achId)
  if (!def) return { unlocked: [] }
  const prev = (
    await db.userAchievement.findUnique({
      where: { userId_achievementId: { userId, achievementId: achId } },
      select: { tier: true },
    })
  )?.tier
  if ((prev ?? 0) >= earned) return { unlocked: [] }

  let swipes = 0
  let xp = 0
  for (let i = prev ?? 0; i < earned; i++) {
    swipes += def.tiers[i].swipes
    xp += def.tiers[i].xp
  }
  try {
    await db.$transaction(async (tx) => {
      if (!prev) {
        await tx.userAchievement.create({
          data: { userId, achievementId: achId, tier: earned },
        })
      } else {
        const upd = await tx.userAchievement.updateMany({
          where: { userId, achievementId: achId, tier: prev },
          data: { tier: earned, tierAt: new Date() },
        })
        if (upd.count === 0) return
      }
      await tx.user.update({
        where: { id: userId },
        data: { swipes: { increment: swipes } },
      })
      await tx.balanceLog.create({
        data: {
          userId,
          kind: 'achievement',
          currency: 'swp',
          amount: swipes,
          note: `Достижение: ${def.name.ru} — ${tierRu(earned)}`,
        },
      })
    })
  } catch (e) {
    if ((e as { code?: string })?.code === 'P2002') return { unlocked: [] }
    throw e
  }

  // Свайпы ушли транзакцией — обновляем кэш баланса (не критично при сбое)
  void invalidateBalance(userId).catch(() => {})

  const unlocked = [
    {
      id: def.id,
      fromTier: prev ?? 0,
      toTier: earned,
      nameRu: def.name.ru,
      swipes,
      xp,
    },
  ]
  guard().rev++
  const { grantXp } = await import('@/lib/xp')
  void grantXp(userId, 'achievement', xp, `Достижение: ${def.name.ru} — ${tierRu(earned)}`)
  await notifyUnlocks(userId, unlocked).catch((e: unknown) =>
    console.error('[ach/notify]', (e as Error).message),
  )
  return { unlocked }
}

/* ------------------------------ Ответ API ------------------------------- */

/* Кэш ответа /api/achievements: 30с на юзера, сбрасывается ревизией наград */
type AchCache = { at: Map<string, { rev: number; at: number; data: AchievementsResponse }> }
const gc = globalThis as typeof globalThis & { __achCache?: AchCache }
function cache(): AchCache {
  if (!gc.__achCache) gc.__achCache = { at: new Map() }
  return gc.__achCache
}
const CACHE_TTL_MS = 30_000

export async function buildAchievementsResponse(userId: string): Promise<AchievementsResponse> {
  const c = cache()
  const hit = c.at.get(userId)
  const now = Date.now()
  if (hit && hit.rev === guard().rev && now - hit.at < CACHE_TTL_MS) return hit.data

  const isGuest = userId.startsWith('guest_')
  if (isGuest) {
    const data: AchievementsResponse = {
      achievements: ACHIEVEMENTS.map((a) => ({
        id: a.id,
        tier: 0,
        unlockedAt: null,
        tierAt: null,
      })) as AchievementRow[],
      metrics: {
        views: 0,
        likes_given: 0,
        comments: 0,
        bookmarks: 0,
        likes_received: 0,
        streak: 0,
        checkins: 0,
        level: 1,
        subscriptions: 0,
        quests: 0,
      },
      unlockedSteps: 0,
      totalSteps: ACHIEVEMENTS.reduce((n, a) => n + a.tiers.length, 0),
    }
    return data
  }

  const [metrics, owned] = await Promise.all([
    readMetrics(userId),
    db.userAchievement.findMany({
      where: { userId },
      select: { achievementId: true, tier: true, unlockedAt: true, tierAt: true },
    }),
  ])
  const ownedMap = new Map(owned.map((o) => [o.achievementId, o]))
  const rows: AchievementRow[] = ACHIEVEMENTS.map((a) => {
    const o = ownedMap.get(a.id)
    return {
      id: a.id,
      tier: o?.tier ?? 0,
      unlockedAt: o?.unlockedAt?.toISOString() ?? null,
      tierAt: o?.tierAt?.toISOString() ?? null,
    }
  })
  const unlockedSteps = rows.reduce((n, r) => n + r.tier, 0)
  const data: AchievementsResponse = {
    achievements: rows,
    metrics,
    unlockedSteps,
    totalSteps: ACHIEVEMENTS.reduce((n, a) => n + a.tiers.length, 0),
  }
  c.at.set(userId, { rev: guard().rev, at: now, data })
  if (c.at.size > 5000) c.at.clear()
  return data
}
