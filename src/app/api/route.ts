import { NextResponse } from 'next/server'
import { guardPublic } from '@/lib/guard'

export const dynamic = 'force-dynamic'

/** GET /api — служебный корневой роут (проверка живости). Публичный, лимит по IP/юзеру. */
export async function GET(request: Request) {
  const g = guardPublic(request, { limit: 120, windowMs: 60_000, bucket: 'root' })
  if (!g.ok) return g.res

  return NextResponse.json({ message: 'Hello, world!' })
}
