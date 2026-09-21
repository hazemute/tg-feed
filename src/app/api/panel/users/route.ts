import { NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'
import { setMaintenanceAllowed, setBanned } from '@/lib/maintenance'
import { invalidateBalance } from '@/lib/balance-cache'
import { logAdmin } from '@/lib/admin-log'
import { emitAppEvent } from '@/lib/events'
import { sendBotNotification } from '@/lib/bot-notify'
import { type Tier } from '@/lib/tiers'
import { BADGES, parseBadges, serializeBadges } from '@/lib/badges'
import { grantXp, XP_RULES } from '@/lib/xp'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 20
const MAX_DAYS = 36_500 // «100 лет» — практическое «навсегда»
const DAY_MS = 86_400_000

/**
 * GET /api/panel/users?q=&page=1&filter=all|tg|guests|banned|plus|pro|paid|expiring
 * — список пользователей со счётчиками, тирами и сроками подписок.
 * Доступ: x-admin-key. Лимит 120/мин/IP.
 */
export async function GET(request: Request) {
  const g = guardAdmin(request, { limit: 120, windowMs: 60_000, bucket: 'panel-users' })
  if (!g.ok) return g.res

  try {
    const url = new URL(request.url)
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 64)
    const pageRaw = Number(url.searchParams.get('page') ?? '1')
    const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.min(500, Math.floor(pageRaw)) : 1
    const filter = url.searchParams.get('filter') ?? 'all'

    const now = Date.now()
    const where: Prisma.UserWhereInput = {}
    if (q) {
      const qLower = q.toLowerCase()
      where.OR = [
        { id: { contains: qLower } },
        { username: { contains: qLower } },
        { firstName: { contains: qLower } },
        { firstName: { contains: q } },
      ]
    }
    // v5.18: фильтры по типу аккаунта, бану и подписке
    switch (filter) {
      case 'tg':
        where.isGuest = false
        break
      case 'guests':
        where.isGuest = true
        break
      case 'banned':
        where.bannedAt = { not: null }
        break
      case 'plus':
        where.tier = 'plus'
        where.OR = [{ tierUntil: { gt: new Date(now) } }, { tierUntil: null }]
        break
      case 'pro':
        where.tier = 'pro'
        where.OR = [{ tierUntil: { gt: new Date(now) } }, { tierUntil: null }]
        break
      case 'paid':
        where.tier = { in: ['plus', 'pro'] }
        where.OR = [{ tierUntil: { gt: new Date(now) } }, { tierUntil: null }]
        break
      case 'expiring':
        where.tier = { in: ['plus', 'pro'] }
        where.tierUntil = { gt: new Date(now), lte: new Date(now + 7 * DAY_MS) }
        break
      default:
        break
    }

    const [total, users] = await Promise.all([
      db.user.count({ where }),
      db.user.findMany({
        where,
        select: {
          id: true,
          username: true,
          firstName: true,
          lastName: true,
          isGuest: true,
          isPremium: true,
          bypassMaintenance: true,
          bannedAt: true,
          banReason: true,
          tier: true,
          tierUntil: true,
          badges: true,
          createdAt: true,
          swipes: true,
          balanceKop: true,
          xp: true,
          level: true,
          _count: { select: { likes: true, subscriptions: true, bookmarks: true, views: true } },
        },
        orderBy:
          filter === 'expiring'
            ? { tierUntil: 'asc' }
            : { createdAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
    ])

    return NextResponse.json({
      items: users.map((u) => {
        const tier = u.tier === 'plus' || u.tier === 'pro' ? (u.tier as Tier) : 'free'
        const active = tier !== 'free' && (!u.tierUntil || u.tierUntil.getTime() > now)
        return {
          id: u.id,
          username: u.username,
          firstName: u.firstName,
          lastName: u.lastName,
          isGuest: u.isGuest,
          isPremium: u.isPremium,
          bypassMaintenance: u.bypassMaintenance,
          bannedAt: u.bannedAt ? u.bannedAt.toISOString() : null,
          banReason: u.banReason,
          tier: active ? tier : 'free',
          tierUntil: active && u.tierUntil ? u.tierUntil.toISOString() : null,
          badges: parseBadges(u.badges),
          // v5.53: показываем НАСТОЯЩИЙ баланс кошелька (User.swipes).
          // Раньше колонка показывала рекламный баланс AdvertiserAccount —
          // из-за этого выданные панелью свайпы «не появлялись» в кошельке.
          swipes: u.swipes,
          // v5.61: рублёвый баланс кошелька (User.balanceKop, копейки) —
          // редактируется в модалке («Баланс рублей»), нужен для компенсаций
          balanceKop: u.balanceKop,
          // v5.75: опыт/уровень (видны в панели, редактируются действием «XP»)
          xp: u.xp,
          level: u.level,
          createdAt: u.createdAt.toISOString(),
          likes: u._count.likes,
          subscriptions: u._count.subscriptions,
          bookmarks: u._count.bookmarks,
          views: u._count.views,
        }
      }),
      total,
      page,
      pageSize: PAGE_SIZE,
    })
  } catch (e) {
    console.error('[panel/users]', e)
    return err('users failed', 500)
  }
}

/**
 * PATCH { userId, … } — действия над пользователем. v5.18: выдача/отзыв
 * подписки (tier) на произвольный срок + аудит всех операций в AdminLog.
 *
 *  { action:'tier', tier:'plus'|'pro', days: N, mode:'grant'|'revoke', reason? }
 *    grant — выдать/продлить: срок суммируется от действующего tierUntil
 *            (или от «сейчас»); days 1..36500 (36500 = практическое «навсегда»).
 *    revoke — отозвать: tier='free', tierUntil=null.
 */
export async function PATCH(request: Request) {
  const g = guardAdmin(request, { limit: 60, windowMs: 60_000, bucket: 'panel-users-post' })
  if (!g.ok) return g.res

  try {
    const body = await readJson<{
      userId?: unknown
      bypassMaintenance?: unknown
      action?: unknown
      swipes?: unknown
      xp?: unknown
      balanceKop?: unknown
      reason?: unknown
      tier?: unknown
      days?: unknown
      mode?: unknown
      badge?: unknown
    }>(request)
    const userId = typeof body.userId === 'string' ? body.userId.trim().slice(0, 80) : ''
    if (!userId) return err('userId required')

    // Прежнее действие: допуск мимо техработ
    if (body.bypassMaintenance !== undefined) {
      const bypass = body.bypassMaintenance === true
      await setMaintenanceAllowed(userId, bypass)
      await logAdmin(bypass ? 'bypass_on' : 'bypass_off', userId)
      return NextResponse.json({ ok: true, userId, bypassMaintenance: bypass })
    }

    // v5.11: действия модерации
    const action = typeof body.action === 'string' ? body.action : ''
    if (action === 'ban' || action === 'unban') {
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : undefined
      await setBanned(userId, action === 'ban', reason)
      // v5.75: бан — штраф XP (−50). Уровень не откатывается, но XP падает.
      if (action === 'ban') {
        void grantXp(userId, 'violation', XP_RULES.violationBan, 'Бан аккаунта')
      }
      await logAdmin(action, userId, reason ? { reason } : undefined)
      return NextResponse.json({ ok: true, userId, banned: action === 'ban' })
    }
    // v5.75: ручное начисление XP админом (найденный баг, вклад в проект и т.п.).
    // Дельта −100…+1000 за один раз, с причиной — она попадает в журнал XP юзера.
    if (action === 'xp') {
      const delta = typeof body.xp === 'number' ? Math.round(body.xp) : NaN
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 140) : ''
      if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 1000) {
        return err('xp must be nonzero, |xp| <= 1000')
      }
      const target = await db.user.findUnique({ where: { id: userId }, select: { id: true } })
      if (!target) return err('user not found', 404)
      const res = await grantXp(
        userId,
        delta > 0 ? 'bug' : 'admin',
        delta,
        delta > 0 ? `Награда от админа: ${reason || 'вклад в проект'}` : `Админ: ${reason || 'корректировка'}`,
      )
      await logAdmin('xp', userId, { delta, reason, result: res ? { xp: res.xp, level: res.level } : null })
      return NextResponse.json({
        ok: true,
        userId,
        xp: res?.xp ?? null,
        level: res?.level ?? null,
        levelUp: res?.levelUp ?? false,
      })
    }
    if (action === 'swipes') {
      const swipes = typeof body.swipes === 'number' ? Math.round(body.swipes) : NaN
      if (!Number.isFinite(swipes) || swipes < 0 || swipes > 10_000_000) {
        return err('swipes must be 0..10000000')
      }
      // v5.53: панель правит НАСТОЯЩИЙ кошелёк (User.swipes — валюта, которую
      // юзер видит в кошельке). Раньше значение уходило в рекламный баланс
      // AdvertiserAccount — из-за этого выданные свайпы не отображались у юзера.
      // v5.54: применяем АТОМАРНЫЙ increment дельты, а не абсолютную запись —
      // иначе параллельные операции (claim задания, списание ИИ, штраф) между
      // нашим чтением и записью молча затирались (lost update).
      const before = await db.user.findUnique({
        where: { id: userId },
        select: { swipes: true },
      })
      if (!before) return err('user not found', 404)
      const delta = swipes - before.swipes
      let updated =
        delta === 0
          ? { swipes: before.swipes }
          : await db.user.update({
              where: { id: userId },
              data: { swipes: { increment: delta } },
              select: { swipes: true },
            })
      // Параллельное списание между чтением и записью могло увести результат в минус — клампим
      if (updated.swipes < 0) {
        updated = await db.user.update({ where: { id: userId }, data: { swipes: 0 }, select: { swipes: true } })
      }
      if (delta !== 0) {
        // Журнал кошелька — виден юзеру в истории операций
        await db.balanceLog
          .create({
            data: {
              userId,
              kind: 'admin',
              currency: 'swp',
              amount: delta,
              note:
                delta > 0
                  ? `Начислено администратором (баланс ${updated.swipes.toLocaleString('ru-RU')})`
                  : `Баланс установлен администратором (${updated.swipes.toLocaleString('ru-RU')})`,
            },
          })
          .catch(() => {})
        // Уведомление в инбокс + ЛС бота (не критично для операции)
        try {
          const num = updated.swipes.toLocaleString('ru-RU')
          const title =
            delta > 0
              ? `Вам начислено ${delta.toLocaleString('ru-RU')} свайпов`
              : 'Баланс свайпов изменён администратором'
          const body = `Новый баланс: ${num} свайпов. Удачного сёрфинга!`
          await db.notification.create({ data: { userId, type: 'system', title, body } })
          emitAppEvent('notif:new', { userId })
          sendBotNotification({ userId, type: 'system', title, body })
        } catch (ne) {
          console.error('[panel/users swipes] notify failed', (ne as Error).message)
        }
      }
      // Кэш баланса устарел: edge-роут отдаст { ok:false }, клиент доберёт из /api/wallet
      await invalidateBalance(userId)
      await logAdmin('swipes', userId, { swipes, delta })
      return NextResponse.json({ ok: true, userId, swipes: updated.swipes })
    }
    if (action === 'balance') {
      // v5.61: правка РУБЛЁВОГО кошелька (User.balanceKop, копейки).
      // Компенсации/корректировки после косяков конвертации и т.п.
      // Атомарный increment дельты — как в ветке 'swipes' (см. v5.54).
      const balanceKop = typeof body.balanceKop === 'number' ? Math.round(body.balanceKop) : NaN
      if (!Number.isFinite(balanceKop) || balanceKop < 0 || balanceKop > 100_000_000) {
        return err('balanceKop must be 0..100000000 (≤ 1 млн ₽)')
      }
      const before = await db.user.findUnique({
        where: { id: userId },
        select: { balanceKop: true },
      })
      if (!before) return err('user not found', 404)
      const delta = balanceKop - before.balanceKop
      let updated =
        delta === 0
          ? { balanceKop: before.balanceKop }
          : await db.user.update({
              where: { id: userId },
              data: { balanceKop: { increment: delta } },
              select: { balanceKop: true },
            })
      if (updated.balanceKop < 0) {
        updated = await db.user.update({ where: { id: userId }, data: { balanceKop: 0 }, select: { balanceKop: true } })
      }
      if (delta !== 0) {
        // Журнал кошелька — виден юзеру в истории операций
        await db.balanceLog
          .create({
            data: {
              userId,
              kind: 'admin',
              currency: 'rub',
              amount: delta,
              note:
                delta > 0
                  ? `Начислено администратором (баланс ${(updated.balanceKop / 100).toFixed(2)} ₽)`
                  : `Баланс установлен администратором (${(updated.balanceKop / 100).toFixed(2)} ₽)`,
            },
          })
          .catch(() => {})
        try {
          const num = (updated.balanceKop / 100).toLocaleString('ru-RU', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })
          const title =
            delta > 0 ? 'Вам начислен рублёвый баланс' : 'Рублёвый баланс изменён администратором'
          const body = `Новый баланс: ${num} ₽. Удачного сёрфинга!`
          await db.notification.create({ data: { userId, type: 'system', title, body } })
          emitAppEvent('notif:new', { userId })
          sendBotNotification({ userId, type: 'system', title, body })
        } catch (ne) {
          console.error('[panel/users balance] notify failed', (ne as Error).message)
        }
      }
      await invalidateBalance(userId)
      await logAdmin('balance', userId, { balanceKop, delta })
      return NextResponse.json({ ok: true, userId, balanceKop: updated.balanceKop })
    }
    if (action === 'premium') {
      const u = await db.user.findUnique({ where: { id: userId }, select: { isPremium: true } })
      if (!u) return err('user not found', 404)
      const next = !u.isPremium
      await db.user.update({ where: { id: userId }, data: { isPremium: next } })
      await logAdmin(next ? 'premium_on' : 'premium_off', userId)
      return NextResponse.json({ ok: true, userId, isPremium: next })
    }

    // === v5.19: бейджи — выдача/снятие одного слага (модалка юзера) ===
    if (action === 'badge') {
      const mode = body.mode === 'revoke' ? 'revoke' : 'grant'
      const badge = typeof body.badge === 'string' ? body.badge : ''
      if (!(badge in BADGES)) return err('unknown badge')
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : undefined

      const u = await db.user.findUnique({
        where: { id: userId },
        select: { badges: true },
      })
      if (!u) return err('user not found', 404)

      const current = parseBadges(u.badges)
      const has = current.includes(badge as keyof typeof BADGES)
      let next: string
      if (mode === 'grant') {
        if (has) return NextResponse.json({ ok: true, userId, badges: current, unchanged: true })
        next = serializeBadges([...current, badge as keyof typeof BADGES])
      } else {
        if (!has) return NextResponse.json({ ok: true, userId, badges: current, unchanged: true })
        next = serializeBadges(current.filter((b) => b !== badge))
      }

      await db.user.update({ where: { id: userId }, data: { badges: next } })
      await logAdmin(mode === 'grant' ? 'badge_grant' : 'badge_revoke', userId, {
        badge,
        ...(reason ? { reason } : {}),
      })

      // Уведомление в инбокс (не критично для операции)
      try {
        const def = BADGES[badge as keyof typeof BADGES]
        await db.notification.create({
          data: {
            userId,
            type: 'system',
            title:
              mode === 'grant'
                ? `Вам выдан бейдж «${def.label}»`
                : `Бейдж «${def.label}» снят`,
            body:
              mode === 'grant'
                ? (reason?.slice(0, 180) ?? 'Отмечен администрацией Tg Swipe — бейдж виден рядом с вашим именем.')
                : 'Если это ошибка — напишите в поддержку.',
          },
        })
        emitAppEvent('notif:new', { userId })
        // v5.45: дублируем в ЛС бота (кнопка «Открыть Tg Swipe»)
        sendBotNotification({
          userId,
          type: 'system',
          title:
            mode === 'grant'
              ? `Вам выдан бейдж «${def.label}»`
              : `Бейдж «${def.label}» снят`,
          body:
            mode === 'grant'
              ? (reason?.slice(0, 180) ?? 'Отмечен администрацией Tg Swipe — бейдж виден рядом с вашим именем.')
              : 'Если это ошибка — напишите в поддержку.',
        })
      } catch (ne) {
        console.error('[panel/users badge] notify failed', (ne as Error).message)
      }

      return NextResponse.json({ ok: true, userId, badges: parseBadges(next) })
    }

    // === v5.18: управление подпиской (Snap Plus / Snap Pro) ===
    if (action === 'tier') {
      const mode = body.mode === 'revoke' ? 'revoke' : 'grant'

      if (mode === 'revoke') {
        const u = await db.user.findUnique({
          where: { id: userId },
          select: { tier: true, tierUntil: true },
        })
        if (!u) return err('user not found', 404)
        const had = (u.tier === 'plus' || u.tier === 'pro') && (!u.tierUntil || u.tierUntil.getTime() > Date.now())
        await db.user.update({
          where: { id: userId },
          data: { tier: 'free', tierUntil: null },
        })
        await logAdmin('tier_revoke', userId, { tier: u.tier, had: had ? u.tierUntil?.toISOString() : null })
        return NextResponse.json({ ok: true, userId, tier: 'free', tierUntil: null })
      }

      // Выдача/продление
      const tier = body.tier
      if (tier !== 'plus' && tier !== 'pro') return err("tier must be 'plus' | 'pro'")
      const days = typeof body.days === 'number' ? Math.round(body.days) : NaN
      if (!Number.isFinite(days) || days < 1 || days > MAX_DAYS) {
        return err(`days must be 1..${MAX_DAYS}`)
      }
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : undefined
      const rank: Record<Tier, number> = { free: 0, plus: 1, pro: 2 }
      if (rank[tier] === undefined) return err('bad tier')

      const u = await db.user.findUnique({
        where: { id: userId },
        select: { tier: true, tierUntil: true },
      })
      if (!u) return err('user not found', 404)

      const now = Date.now()
      const currentActive =
        u.tierUntil && u.tierUntil.getTime() > now ? u.tierUntil.getTime() : now
      const base = tier === u.tier && currentActive > now ? currentActive : now
      const untilMs = base + days * DAY_MS

      const updated = await db.user.update({
        where: { id: userId },
        data: { tier, tierUntil: new Date(untilMs) },
        select: { tier: true, tierUntil: true },
      })

      const extended = tier === u.tier && currentActive > now && base !== now
      await logAdmin(extended ? 'tier_extend' : 'tier_grant', userId, {
        tier,
        days,
        until: new Date(untilMs).toISOString(),
        ...(reason ? { reason } : {}),
      })
      return NextResponse.json({
        ok: true,
        userId,
        tier: updated.tier,
        tierUntil: updated.tierUntil ? updated.tierUntil.toISOString() : null,
      })
    }

    return err('unknown action')
  } catch (e) {
    console.error('[panel/users PATCH]', e)
    return err('user update failed', 500)
  }
}
