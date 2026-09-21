import { NextResponse } from 'next/server'
import { guardAuth } from '@/lib/guard'
import { err } from '@/lib/server'
import { claimQuest } from '@/lib/quests'

export const dynamic = 'force-dynamic'

/**
 * POST /api/quests/[id]/claim — попытка выполнить задание.
 *
 * Сервер сам открывает логику: не в цели → status='not_member' (клиент откроет
 * ссылку), в цели → награда начислена атомарно. Отозванное задание навсегда
 * недоступно ('revoked'). Лимит 10/мин — Бот API под защитой.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = guardAuth(request, { limit: 10, windowMs: 60_000, bucket: 'quest-claim' })
  if (!g.ok) return g.res
  const { id } = await params
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return err('bad id', 400)

  try {
    const res = await claimQuest(g.uid, id)
    return NextResponse.json(res)
  } catch (e) {
    console.error('[quests/claim]', e)
    return err('failed', 500)
  }
}
