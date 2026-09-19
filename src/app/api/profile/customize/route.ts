import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { getBg, getFrame, getPalette } from '@/lib/profile-style'

export const dynamic = 'force-dynamic'

/**
 * PUT /api/profile/customize — сохранить оформление профиля (v5.28).
 *
 * body: { palette: string, bg: string, frame: string } — id из каталогов
 * src/lib/profile-style.ts, ВКЛЮЧАЯ кастомные: палитра custom:#hex:#hex
 * (градиент обложки из двух цветов) и рамка custom:#hex (кольцо цвета).
 * Валидация состава (getPalette/getBg/getFrame): неизвестный id / не-hex →
 * 400 unknown style (CSS-инъекция исключена строгой регуляркой hex).
 * v5.28: анимаций и замков Plus больше нет — все статические стили доступны всем.
 *
 * Ответ: { ok: true, style: { palette, bg, frame } }
 * Rate limit: 30/мин на пользователя (bucket style).
 */

const BodySchema = z.object({
  palette: z.string().min(1).max(32),
  bg: z.string().min(1).max(32),
  frame: z.string().min(1).max(32),
})

export async function PUT(request: Request) {
  const g = guardAuth(request, { limit: 30, windowMs: 60_000, bucket: 'style' })
  if (!g.ok) return g.res

  // readJson: кап 64KB до чтения тела; при ошибке/превышении вернёт {} —
  // zod ниже отвергнет с 400 (раньше тело читалось целиком без капа)
  const parsed = BodySchema.safeParse(await readJson(request))
  if (!parsed.success) return NextResponse.json({ error: 'bad request' }, { status: 400 })

  const { palette, bg, frame } = parsed.data
  if (!getPalette(palette) || !getBg(bg) || !getFrame(frame)) {
    return NextResponse.json({ error: 'unknown style' }, { status: 400 })
  }

  try {
    const user = await db.user.update({
      where: { id: g.uid },
      data: { profilePalette: palette, profileBg: bg, profileFrame: frame },
      select: { profilePalette: true, profileBg: true, profileFrame: true },
    })
    return NextResponse.json({
      ok: true,
      style: { palette: user.profilePalette, bg: user.profileBg, frame: user.profileFrame },
    })
  } catch (e) {
    console.error('[profile/customize]', e)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
