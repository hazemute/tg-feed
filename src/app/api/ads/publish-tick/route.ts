import { NextResponse } from 'next/server'
import { cronAuthorized } from '@/lib/guard'
import { err } from '@/lib/server'
import { publishDueAdSlots } from '@/lib/ad-slots'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/ads/publish-tick — standalone-вызов крона рекламного календаря
 * (cronAuthorized: CRON_SECRET). Оплаченные слоты публикуются в @SnapTeamDev
 * по runAt (12:00/18:00 МСК). Дублируется общим тиком /api/parse/tick —
 * публикация идемпотентна (PAID → PUBLISHED атомарно).
 */
export async function POST(request: Request) {
  if (!cronAuthorized(request)) return err('cron required', 401)
  try {
    const r = await publishDueAdSlots()
    return NextResponse.json({ ok: true, ...r })
  } catch (e) {
    console.error('[ads/publish-tick]', e)
    return err('publish failed', 500)
  }
}
