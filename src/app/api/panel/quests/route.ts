import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'
import { logAdmin } from '@/lib/admin-log'
import { bumpCache } from '@/lib/redis'
import { invalidateAiKnowledge } from '@/lib/ai-knowledge'
import {
  isQuestKind,
  normalizeQuestTargetForKind,
  questLinkFor,
  validateQuestTarget,
  type QuestKind,
  type TargetValidation,
} from '@/lib/quests'

export const dynamic = 'force-dynamic'

/**
 * Панель: ЗАДАНИЯ (v5.51, расширены в v5.70).
 *
 * GET    → все задания (в порядке sort) + счётчики выполнений/аннулирований.
 * POST   { action:'create', title, kind, target, ... }   → создать.
 * POST   { action:'update', id, ... }                    → правка.
 * POST   { action:'toggle', id }                         → вкл/выкл.
 * POST   { action:'delete', id }                         → удалить (каскад выполнений).
 * POST   { action:'check', target }                      → проверить цель (getChat + бот-админ).
 * POST   { action:'bind_chat', id, chatId }              → привязать chat_id к join_chat-квесту.
 *
 * v5.70: новые виды (tiktok_follow/daily_checkin/profile_setup/boost/
 * activity_milestone/referral); цель нормализуется ПОД ВИД (username / chat_id /
 * инвайт / tiktok-хэндл / posts:N / N); username-цели по-прежнему прогоняются
 * через validateQuestTarget до публикации.
 */

const upsertSchema = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().max(300).optional().nullable(),
  kind: z.string().refine(isQuestKind, 'неизвестный вид задания'),
  target: z.string().trim().max(200).default(''),
  link: z.string().trim().url().max(300).optional().or(z.literal('')).nullable(),
  rewardSwp: z.number().int().min(1).max(1_000_000),
  sort: z.number().int().min(0).max(9999).default(0),
})

export async function GET(request: Request) {
  const g = guardAdmin(request)
  if (!g.ok) return g.res
  try {
    const rows = await db.quest.findMany({
      orderBy: [{ sort: 'asc' }, { createdAt: 'desc' }],
      include: { _count: { select: { completions: true } } },
    })
    const counts = await db.questCompletion.groupBy({
      by: ['questId', 'status'],
      _count: { _all: true },
    })
    const done = new Map<string, number>()
    const revoked = new Map<string, number>()
    for (const c of counts) {
      if (c.status === 'done') done.set(c.questId, c._count._all)
      else revoked.set(c.questId, c._count._all)
    }
    return NextResponse.json({
      items: rows.map((q) => ({
        id: q.id,
        title: q.title,
        description: q.description,
        kind: q.kind,
        target: q.target,
        targetType: q.targetType,
        link: questLinkFor(q.kind, q.target, q.link),
        rewardSwp: q.rewardSwp,
        active: q.active,
        sort: q.sort,
        createdAt: q.createdAt.toISOString(),
        doneCount: done.get(q.id) ?? 0,
        revokedCount: revoked.get(q.id) ?? 0,
        completionsTotal: q._count.completions,
      })),
    })
  } catch (e) {
    console.error('[panel/quests]', e)
    return err('failed', 500)
  }
}

/** Проверка цели с учётом вида: username → Bot API, остальное — честные подсказки */
async function validateForKind(kind: QuestKind, target: string, targetType: string): Promise<TargetValidation | null> {
  if (targetType === 'username') return validateQuestTarget(target)
  if (targetType === 'chat_id') {
    const bc = await db.botChat.findUnique({ where: { chatId: target }, select: { isAdmin: true, title: true } }).catch(() => null)
    if (!bc) {
      return { ok: true, target, verificationProblem: 'Бот ещё не видел этот chat_id — проверка ответит cannot_verify, пока бот не добавлен в чат' }
    }
    if (!bc.isAdmin) {
      return { ok: true, target, title: bc.title, verificationProblem: `Бот в чате «${bc.title || target}», но НЕ админ — добавьте его админом` }
    }
    return { ok: true, target, title: bc.title || undefined, verificationProblem: null }
  }
  if (targetType === 'tiktok') {
    return { ok: true, target, verificationProblem: null } // проверка скриншотом через VLM
  }
  return { ok: true, target, verificationProblem: null } // invite/none/metric/goal
}

export async function POST(request: Request) {
  const g = guardAdmin(request, { limit: 30, windowMs: 60_000, bucket: 'panel-quests' })
  if (!g.ok) return g.res
  try {
    const body = await readJson<Record<string, unknown>>(request)
    const action = String(body.action ?? '')

    if (action === 'check') {
      const v = await validateQuestTarget(String(body.target ?? ''))
      return NextResponse.json({ validation: v })
    }

    if (action === 'bind_chat') {
      const id = String(body.id ?? '')
      const chatId = String(body.chatId ?? '').trim()
      const q = await db.quest.findUnique({ where: { id } })
      if (!q) return err('quest not found', 404)
      if (q.kind !== 'join_chat') return err('Привязка chat_id доступна только заданиям «вступай в чат»', 400)
      const chat = await db.botChat.findUnique({ where: { chatId }, select: { isAdmin: true, title: true } })
      if (!chat || !chat.isAdmin) return err('Бот не админ в этом чате — сначала добавьте его админом', 400)
      const updated = await db.quest.update({
        where: { id },
        data: { target: chatId, targetType: 'chat_id' },
      })
      await logAdmin('quest_bind_chat', id, { chatId, title: updated.title })
      await bumpInval()
      return NextResponse.json({ ok: true, target: updated.target, chatTitle: chat.title })
    }

    if (action === 'toggle') {
      const id = String(body.id ?? '')
      const q = await db.quest.findUnique({ where: { id } })
      if (!q) return err('quest not found', 404)
      const updated = await db.quest.update({
        where: { id },
        data: { active: !q.active },
      })
      await logAdmin(`quest_${updated.active ? 'enable' : 'disable'}`, id, { title: q.title })
      await bumpInval()
      return NextResponse.json({ ok: true, active: updated.active })
    }

    if (action === 'delete') {
      const id = String(body.id ?? '')
      const q = await db.quest.delete({ where: { id } }).catch(() => null)
      if (!q) return err('quest not found', 404)
      await logAdmin('quest_delete', id, { title: q.title })
      await bumpInval()
      return NextResponse.json({ ok: true })
    }

    if (action === 'create' || action === 'update') {
      const parsed = upsertSchema.safeParse(body)
      if (!parsed.success) return err(parsed.error.issues[0]?.message ?? 'bad fields', 400)
      const data = parsed.data
      const kind = data.kind as QuestKind

      // Цель нормализуем под вид задания; для daily/profile цель не нужна
      const norm = normalizeQuestTargetForKind(data.target, kind)
      if (!norm) return err('Не удалось разобрать цель под этот вид задания', 400)
      const v = await validateForKind(kind, norm.target, norm.targetType)
      if (v && !v.ok) return err(v.verificationProblem ?? 'Цель не найдена', 400)

      const base = {
        title: data.title,
        description: data.description || null,
        kind,
        target: norm.target,
        targetType: norm.targetType,
        link: data.link || null,
        rewardSwp: data.rewardSwp,
        sort: data.sort,
      }

      if (action === 'create') {
        const q = await db.quest.create({ data: base })
        await logAdmin('quest_create', q.id, { title: q.title, target: q.target, reward: q.rewardSwp })
        await bumpInval()
        return NextResponse.json({ ok: true, id: q.id, validation: v })
      }
      const id = String(body.id ?? '')
      const q = await db.quest.update({ where: { id }, data: base }).catch(() => null)
      if (!q) return err('quest not found', 404)
      await logAdmin('quest_update', id, { title: q.title, target: q.target, reward: q.rewardSwp })
      await bumpInval()
      return NextResponse.json({ ok: true, id, validation: v })
    }

    return err('unknown action', 400)
  } catch (e) {
    console.error('[panel/quests POST]', e)
    return err('failed', 500)
  }
}

/** Инвалидация списков: кэш публичного списка + база знаний ИИ */
async function bumpInval(): Promise<void> {
  await bumpCache(['qt']).catch(() => {})
  invalidateAiKnowledge()
}
