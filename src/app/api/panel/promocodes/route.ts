import { NextResponse } from 'next/server'
import { z } from 'zod'
import { randomBytes } from 'crypto'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'
import { logAdmin } from '@/lib/admin-log'

export const dynamic = 'force-dynamic'

/**
 * Промокоды (v5.65) — генератор наградных кодов в админ-панели.
 *
 * GET               → список кодов + счётчики активаций
 * POST  {…}         → создать код (kind: swipes | rub | tier)
 * PATCH {id,active} → вкл/выкл кода
 * DELETE {id}       → удалить код (вместе с активациями)
 *
 * Активация пользователем — отдельный роут POST /api/promo/redeem.
 */

/** Человекочитаемый код: без похожих символов (0/O, 1/I) */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function generatePromoCode(len = 10): string {
  const bytes = randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length]
  // Формат XXX-XXX-XXX — удобнее читать/диктовать
  if (len >= 9) {
    const raw = out
    out = `${raw.slice(0, 3)}-${raw.slice(3, 6)}-${raw.slice(6, 9)}`
    if (len > 9) out += raw.slice(9)
  }
  return out
}

const createSchema = z
  .object({
    kind: z.enum(['swipes', 'rub', 'tier']),
    code: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{4,24}$/, 'Код: 4-24 латинских букв/цифр/дефисов')
      .optional(),
    swipes: z.number().int().min(1).max(10_000_000).optional(),
    amountRub: z.number().min(1).max(1_000_000).optional(), // рубли → копейки
    tierPlan: z.enum(['plus', 'pro']).optional(),
    tierDays: z.number().int().min(1).max(3650).optional(),
    maxUses: z.number().int().min(1).max(1_000_000).optional(),
    note: z.string().trim().max(200).optional(),
    expiresInDays: z.number().int().min(1).max(3650).optional(),
  })
  .refine(
    (d) =>
      d.kind === 'swipes' ? d.swipes !== undefined : d.kind === 'rub' ? d.amountRub !== undefined : d.tierPlan !== undefined && d.tierDays !== undefined,
    { message: 'Заполните параметры награды' },
  )

export async function GET(request: Request) {
  const g = guardAdmin(request)
  if (!g.ok) return g.res

  try {
    const codes = await db.promoCode.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { redemptions: { orderBy: { createdAt: 'desc' }, take: 5 } },
    })

    return NextResponse.json({
      codes: codes.map((c) => ({
        id: c.id,
        code: c.code,
        kind: c.kind,
        swipes: c.swipes,
        amountKop: c.amountKop,
        tierPlan: c.tierPlan,
        tierDays: c.tierDays,
        maxUses: c.maxUses,
        usedCount: c.usedCount,
        active: c.active,
        note: c.note,
        expiresAt: c.expiresAt?.toISOString() ?? null,
        createdAt: c.createdAt.toISOString(),
        recent: c.redemptions.map((r) => ({
          userId: r.userId,
          reward: r.reward,
          createdAt: r.createdAt.toISOString(),
        })),
      })),
    })
  } catch (e) {
    console.error('[panel/promocodes:get]', e)
    return err('Ошибка', 500)
  }
}

export async function POST(request: Request) {
  const g = guardAdmin(request, { limit: 30, windowMs: 60_000 })
  if (!g.ok) return g.res

  try {
    const parsed = createSchema.safeParse(await readJson(request))
    if (!parsed.success) return err(parsed.error.issues[0]?.message ?? 'Некорректные данные')
    const d = parsed.data

    const code = (d.code ?? generatePromoCode()).toUpperCase()

    // Уникальность кода — честная проверка до вставки (читаемая ошибка)
    const exists = await db.promoCode.findUnique({ where: { code }, select: { id: true } })
    if (exists) return err('Такой код уже существует')

    const created = await db.promoCode.create({
      data: {
        code,
        kind: d.kind,
        swipes: d.kind === 'swipes' ? (d.swipes ?? 0) : 0,
        amountKop: d.kind === 'rub' ? Math.round((d.amountRub ?? 0) * 100) : 0,
        tierPlan: d.kind === 'tier' ? d.tierPlan : null,
        tierDays: d.kind === 'tier' ? (d.tierDays ?? 0) : 0,
        maxUses: d.maxUses ?? 1,
        note: d.note || null,
        expiresAt: d.expiresInDays ? new Date(Date.now() + d.expiresInDays * 24 * 3600 * 1000) : null,
        createdById: 'panel',
      },
    })

    await logAdmin('ops', 'promo_code', { op: 'promo_create', code, kind: d.kind }).catch(() => {})

    return NextResponse.json({
      ok: true,
      code: {
        id: created.id,
        code: created.code,
        kind: created.kind,
        swipes: created.swipes,
        amountKop: created.amountKop,
        tierPlan: created.tierPlan,
        tierDays: created.tierDays,
        maxUses: created.maxUses,
        usedCount: 0,
        active: true,
        note: created.note,
        expiresAt: created.expiresAt?.toISOString() ?? null,
        createdAt: created.createdAt.toISOString(),
        recent: [],
      },
    })
  } catch (e) {
    console.error('[panel/promocodes:post]', e)
    return err('Ошибка', 500)
  }
}

const patchSchema = z.object({
  id: z.string().min(1),
  active: z.boolean(),
})

export async function PATCH(request: Request) {
  const g = guardAdmin(request, { limit: 60, windowMs: 60_000 })
  if (!g.ok) return g.res

  try {
    const parsed = patchSchema.safeParse(await readJson(request))
    if (!parsed.success) return err('Некорректные данные')
    const c = await db.promoCode.update({
      where: { id: parsed.data.id },
      data: { active: parsed.data.active },
    })
    await logAdmin('ops', 'promo_code', { op: 'promo_toggle', code: c.code, active: c.active }).catch(() => {})
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[panel/promocodes:patch]', e)
    return err('Ошибка', 500)
  }
}

const deleteSchema = z.object({ id: z.string().min(1) })

export async function DELETE(request: Request) {
  const g = guardAdmin(request, { limit: 60, windowMs: 60_000 })
  if (!g.ok) return g.res

  try {
    const parsed = deleteSchema.safeParse(await readJson(request))
    if (!parsed.success) return err('Некорректные данные')
    const c = await db.promoCode.delete({ where: { id: parsed.data.id } })
    await logAdmin('ops', 'promo_code', { op: 'promo_delete', code: c.code }).catch(() => {})
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[panel/promocodes:delete]', e)
    return err('Ошибка', 500)
  }
}
