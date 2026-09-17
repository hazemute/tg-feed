import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'
import { redis, redisHealth, CACHE_FAMILIES, bumpCache } from '@/lib/redis'
import {
  MAINT_PASS_SET,
  adminUids,
  isMaintenanceOn,
  maintenanceAllowList,
  maintenanceDbMirror,
  setMaintenance,
  setMaintenanceAllowed,
} from '@/lib/maintenance'

export const dynamic = 'force-dynamic'

/**
 * Системные настройки панели: режим техработ, белый список допуска,
 * сброс кэша. Доступ: x-admin-key.
 *
 * GET  → { maintenance: {enabled, dbMirror}, admins: string[], allow: {...},
 *          cache: {redis, versions} }
 * POST { action: 'setEnabled', enabled: boolean }
 *    | { action: 'allow', userId } | { action: 'disallow', userId }
 *    | { action: 'allowByTgId', tgId: string } — допустить заранее (создаёт запись)
 *    | { action: 'resetCache' }
 */

type Body = { action?: unknown; enabled?: unknown; userId?: unknown; tgId?: unknown }

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
}

export async function GET(request: Request) {
  const g = guardAdmin(request, { limit: 120, windowMs: 60_000, bucket: 'panel-system' })
  if (!g.ok) return g.res

  try {
    const [enabled, dbMirror, allowUids, cacheState] = await Promise.all([
      isMaintenanceOn(),
      maintenanceDbMirror(),
      maintenanceAllowList(),
      redisHealth(),
    ])

    // данные допущенных пользователей (кто уже есть в БД)
    const users = allowUids.length
      ? await db.user.findMany({
          where: { id: { in: allowUids } },
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            isDemo: true,
            bypassMaintenance: true,
          },
        })
      : []
    // UID из Redis, которых ещё нет в БД (допущены заранее, приложение не открывали)
    const known = new Set(users.map((u) => u.id))
    const pending = allowUids.filter((id) => !known.has(id))

    const versions: Record<string, number> = {}
    if (redis) {
      // один MGET вместо пяти GET (экономия команд Upstash)
      try {
        const vals = await redis.mget<number[]>(...CACHE_FAMILIES.map((f) => `ver:${f}`))
        CACHE_FAMILIES.forEach((f, i) => {
          versions[f] = typeof vals[i] === 'number' ? (vals[i] as number) : 0
        })
      } catch {
        for (const f of CACHE_FAMILIES) versions[f] = -1
      }
    }

    return NextResponse.json({
      maintenance: { enabled, dbMirror },
      admins: adminUids(),
      allow: {
        users: users.map((u) => ({
          id: u.id,
          username: u.username,
          firstName: u.firstName,
          lastName: u.lastName,
          isDemo: u.isDemo,
          bypassMaintenance: u.bypassMaintenance,
        })),
        pendingIds: pending,
      },
      cache: { redis: cacheState, versions },
    })
  } catch (e) {
    console.error('[panel/system]', e)
    return err('system failed', 500)
  }
}

export async function POST(request: Request) {
  const g = guardAdmin(request, { limit: 60, windowMs: 60_000, bucket: 'panel-system-post' })
  if (!g.ok) return g.res

  try {
    const body = await readJson<Body>(request)
    const action = str(body.action, 32)

    switch (action) {
      case 'setEnabled': {
        const enabled = body.enabled === true
        await setMaintenance(enabled)
        return NextResponse.json({ ok: true, enabled })
      }

      case 'allow':
      case 'disallow': {
        const userId = str(body.userId, 80)
        if (!userId) return err('userId required')
        const allowed = action === 'allow'
        await setMaintenanceAllowed(userId, allowed)
        return NextResponse.json({ ok: true, userId, allowed })
      }

      case 'allowByTgId': {
        const raw = str(body.tgId, 40)
        if (!raw) return err('tgId required')
        const numeric = raw.replace(/^@/, '').replace(/^tg_/, '')
        if (!/^\d{3,20}$/.test(numeric)) return err('Ожидается числовой Telegram ID')
        const uid = `tg_${numeric}`
        await db.user.upsert({
          where: { id: uid },
          update: { bypassMaintenance: true, isDemo: false },
          create: { id: uid, isDemo: false, bypassMaintenance: true, categories: '[]' },
        })
        if (redis) {
          try {
            await redis.sadd(MAINT_PASS_SET, uid)
          } catch {
            /* при сбое — запись в БД уже есть, синхронизируется из панели позже */
          }
        }
        return NextResponse.json({ ok: true, userId: uid, allowed: true })
      }

      case 'resetCache': {
        await bumpCache([...CACHE_FAMILIES])
        return NextResponse.json({ ok: true, families: CACHE_FAMILIES })
      }

      default:
        return err('unknown action')
    }
  } catch (e) {
    console.error('[panel/system POST]', e)
    return err('system action failed', 500)
  }
}
