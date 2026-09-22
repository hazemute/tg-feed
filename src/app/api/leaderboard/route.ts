import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { cacheAside } from '@/lib/redis'
import { adminUids } from '@/lib/maintenance'
import { fetchLbPrizes } from '@/lib/lb-payouts'
import type { LbEntry, LbTab, LeaderboardResponse, LbPrizes } from '@/lib/types'

export const dynamic = 'force-dynamic'

/**
 * v5.87: ЛИДЕРБОРДЫ — не рублёвые (решение владельца).
 * v5.88: админы (ADMIN_TG_IDS) в таблицах и рангах НЕ участвуют (приказ
 * владельца «админы — те, у кого доступ к техработам»); в ответ добавлен
 * блок prizes (награды за активность: топ-3 по XP недели/месяца).
 *
 * Пять таблиц (таб):
 *  - level    — топ по XP (уровень выводится из XP, сортировка по опыту);
 *  - swipes   — топ по балансу свайпов (валюта ИИ; рубли в рейтингах НЕ участвуют);
 *  - views    — просмотры постов за 30 дней (PostView);
 *  - likes    — поставленные лайки за 30 дней (Like);
 *  - comments — толковые комментарии за 30 дней (Comment, скрытые не считаются).
 *
 * Производительность (в духе Task 32 «скорость бэкенда»):
 *  - глобальная часть (топ-100 + мастер-список рангов) кэшируется cacheAside:
 *    L0 память 10с → L2 Redis 60с → БД. Все пользователи делят один ответ,
 *    Supabase видит ~1 запрос в минуту на таб вместо потока;
 *  - персональная часть («моё место») считается на каждом запросе, но это
 *    дешёвые операции: скан мастер-списка в памяти либо count по User;
 *  - активные табы ограничены окном 30 дней (индексы createdAt) и take 1000.
 *
 * Приватность: только публичные поля (имя/@username/аватар/уровень/премиум).
 * Гостевые аккаунты и админы в таблицах не участвуют и не влияют на чужие ранги.
 */

const TABS: LbTab[] = ['level', 'swipes', 'views', 'likes', 'comments']

/** Окно активных табов — 30 дней */
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/** Сколько строк выбирает «мастер-список» (для точного ранга внутри него) */
const MASTER_TAKE = 1000

/** Размер публичного топа */
const TOP_N = 100

/** Кэшируемая глобальная часть: топ-100 DTO + мастер-список рангов [uid, value] */
type CachedGlobal = { top: LbEntry[]; master: [string, number][] }

/** Публичные поля пользователя, нужные таблице */
const USER_SELECT = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
  photoUrl: true,
  isPremium: true,
  level: true,
  xp: true,
  swipes: true,
} as const

type UserRow = {
  id: string
  username: string | null
  firstName: string | null
  lastName: string | null
  photoUrl: string | null
  isPremium: boolean
  level: number
  xp: number
  swipes: number
}

/** Имя для таблицы: «Имя Фамилия» → @username → «Участник» */
function nameOf(u: Pick<UserRow, 'username' | 'firstName' | 'lastName'>): string {
  const full = [u.firstName, u.lastName].filter(Boolean).join(' ').trim()
  return full || (u.username ? `@${u.username}` : 'Участник')
}

function toEntry(u: UserRow, rank: number, value: number, sub: string | null): LbEntry {
  return {
    rank,
    uid: u.id,
    name: nameOf(u),
    username: u.username,
    photoUrl: u.photoUrl,
    premium: u.isPremium,
    level: u.level,
    value,
    sub,
  }
}

/** Условие «валидный участник» — не гость, не бан, не админ (v5.88) */
function validUserWhere(admins: string[]): { isGuest: false; bannedAt: null; id?: { notIn: string[] } } {
  return {
    isGuest: false,
    bannedAt: null,
    ...(admins.length ? { id: { notIn: admins } } : {}),
  }
}

/** Глобальная часть для «пожизненных» табов (уровни/свайпы) — один запрос User */
async function fetchStaticGlobal(tab: 'level' | 'swipes', admins: string[]): Promise<CachedGlobal> {
  const rows: UserRow[] = await db.user.findMany({
    where: validUserWhere(admins),
    orderBy: [{ xp: 'desc' }, { swipes: 'desc' }, { id: 'asc' }],
    take: MASTER_TAKE,
    select: USER_SELECT,
  })

  const sorted =
    tab === 'level'
      ? rows
      : [...rows].sort((a, b) => b.swipes - a.swipes || a.id.localeCompare(b.id))

  const master: [string, number][] = sorted.map((u) => [u.id, tab === 'level' ? u.xp : u.swipes])
  const top = sorted.slice(0, TOP_N).map((u, i) =>
    tab === 'level'
      ? toEntry(u, i + 1, u.level, `${u.xp} XP`)
      : toEntry(u, i + 1, u.swipes, null),
  )
  return { top, master }
}

/** Количество действий пользователя в окне 30 дней (по табу; скрытые комментарии не считаются) */
async function activityCount(
  tab: 'views' | 'likes' | 'comments',
  uid: string,
  start: Date,
): Promise<number> {
  const createdAt = { gte: start }
  if (tab === 'views') {
    return db.postView.count({ where: { userId: uid, createdAt } })
  }
  if (tab === 'likes') {
    return db.like.count({ where: { userId: uid, createdAt } })
  }
  return db.comment.count({ where: { userId: uid, createdAt, hidden: false } })
}

/** Глобальная часть для активных табов (окно 30 дней) — groupBy по журналу */
async function fetchActivityGlobal(
  tab: 'views' | 'likes' | 'comments',
  admins: string[],
): Promise<CachedGlobal> {
  const start = new Date(Date.now() - WINDOW_MS)
  const createdAt = { gte: start }

  // У union делегатов Prisma TS не умеет вызывать groupBy — явные ветки по табу.
  // ВАЖНО: аннотация типа на результате портит вывод дженерика groupBy, поэтому
  // каждая ветка — свой const с выводом типов и маппинг в пары сразу.
  const pairs: [string, number][] = []
  if (tab === 'views') {
    const g = await db.postView.groupBy({
      by: ['userId'],
      where: { createdAt },
      _count: { userId: true },
      orderBy: { _count: { userId: 'desc' } },
      take: MASTER_TAKE,
    })
    for (const x of g) pairs.push([x.userId, x._count.userId])
  } else if (tab === 'likes') {
    const g = await db.like.groupBy({
      by: ['userId'],
      where: { createdAt },
      _count: { userId: true },
      orderBy: { _count: { userId: 'desc' } },
      take: MASTER_TAKE,
    })
    for (const x of g) pairs.push([x.userId, x._count.userId])
  } else {
    const g = await db.comment.groupBy({
      by: ['userId'],
      where: { createdAt, hidden: false },
      _count: { userId: true },
      orderBy: { _count: { userId: 'desc' } },
      take: MASTER_TAKE,
    })
    for (const x of g) pairs.push([x.userId, x._count.userId])
  }

  // Пользователи только не-гости и не забаненные (и не админы — v5.88):
  // гость в топе ленты не виден и НЕ должен занимать место/сдвигать чужие ранги
  // → мастер-список строим сразу из валидных участников.
  const users = await db.user.findMany({
    where: {
      id: { in: pairs.map(([uid]) => uid), ...(admins.length ? { notIn: admins } : {}) },
      isGuest: false,
      bannedAt: null,
    },
    select: USER_SELECT,
  })
  const byId = new Map(users.map((u) => [u.id, u]))

  const master: [string, number][] = pairs.filter(([uid]) => byId.has(uid))

  const top: LbEntry[] = master.slice(0, TOP_N).map(([uid, count], i) =>
    toEntry(byId.get(uid)!, i + 1, count, null),
  )
  return { top, master }
}

function fetchGlobal(tab: LbTab, admins: string[]): Promise<CachedGlobal> {
  if (tab === 'level' || tab === 'swipes') return fetchStaticGlobal(tab, admins)
  return fetchActivityGlobal(tab, admins)
}

export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'lb' })
  if (!g.ok) return g.res

  const url = new URL(request.url)
  const tabParam = (url.searchParams.get('tab') ?? 'level') as LbTab
  const tab: LbTab = TABS.includes(tabParam) ? tabParam : 'level'
  const window: 'all' | '30d' =
    tab === 'views' || tab === 'likes' || tab === 'comments' ? '30d' : 'all'

  try {
    const admins = adminUids()

    // Глобальная часть — общий кэш на всех пользователей (60с).
    // v5.88: ключ v2 — из таблиц удалены админы, старый кэш невалиден.
    const glob = await cacheAside<CachedGlobal>({
      key: `lb:v2:${tab}`,
      ttlSec: 60,
      memoryTtlMs: 10_000,
      fetcher: () => fetchGlobal(tab, admins),
    })

    // Блок наград (v5.88) — общий на все табы, свой кэш 60с.
    // Ошибка снапшота не роняет таблицу — prizes: null (UI просто скрывает блок).
    const prizes = await cacheAside<LbPrizes>({
      key: 'lb:prizes:v1',
      ttlSec: 60,
      memoryTtlMs: 10_000,
      fetcher: () => fetchLbPrizes(),
    }).catch((e) => {
      console.error('[leaderboard] prizes', e)
      return null
    })

    // Персональная часть
    const meUser = await db.user.findUnique({
      where: { id: g.uid },
      select: { isGuest: true, bannedAt: true, xp: true, level: true, swipes: true },
    })
    if (!meUser) return err('user not found', 404)

    let me: LeaderboardResponse['me'] = null
    if (!meUser.isGuest && !meUser.bannedAt) {
      if (tab === 'level' || tab === 'swipes') {
        const mine = tab === 'level' ? meUser.xp : meUser.swipes
        // Точный ранг одним count — дешевле любого полного скана
        // (валидные участники: не гость, не бан, не админ — как в таблице)
        const ahead = await db.user.count({
          where: {
            ...validUserWhere(admins),
            ...(tab === 'level' ? { xp: { gt: mine } } : { swipes: { gt: mine } }),
          },
        })
        me = { rank: ahead + 1, value: mine, level: meUser.level }
      } else {
        const start = new Date(Date.now() - WINDOW_MS)
        const mine = await activityCount(tab, g.uid, start)
        if (mine > 0) {
          // Ранг — по мастер-списку (только не-гости, как в таблице):
          // скан ≤1000 пар в памяти — копейки
          const rank = rankFromMaster(glob.master, mine)
          me = { rank, value: mine, level: meUser.level }
        } else {
          me = { rank: null, value: 0, level: meUser.level }
        }
      }
    }

    const res: LeaderboardResponse = {
      tab,
      window,
      top: glob.top,
      me,
      guest: !!meUser.isGuest,
      prizes,
    }
    return NextResponse.json(res)
  } catch (e) {
    console.error('[leaderboard]', e)
    return err('leaderboard failed', 500)
  }
}

/**
 * Ранг по мастер-списку (только валидные участники): сколько имеет значение
 * выше моего. Одинаковые значения делят место («1, 2, 2, 4»).
 * null — участника нет в топ-1000 (вне топа).
 */
function rankFromMaster(master: [string, number][], mine: number): number | null {
  let rank = 0
  for (const [, value] of master) {
    if (value > mine) rank++
    else break
  }
  // Я в списке, если где-то дальше есть ровно моё значение
  if (master.some(([, value]) => value === mine)) return rank + 1
  return null
}
