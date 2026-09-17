import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'

export const dynamic = 'force-dynamic'

// userId из тела игнорируется — пользователь берётся из Bearer-сессии.
// Интересы — массив слагов категорий (латиница/цифры/_/-, до 32 символов, максимум 20).
const bodySchema = z.object({
  categoryIds: z
    .array(z.string().regex(/^[a-z0-9_-]{1,32}$/))
    .min(1)
    .max(20),
})

/** POST /api/user/categories { categoryIds: string[] } — интересы пользователя */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'cats' })
  if (!g.ok) return g.res
  const userId = g.uid

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('select at least 1 category')
    const categoryIds = parsed.data.categoryIds

    const user = await db.user.findUnique({ where: { id: userId } })
    if (!user) return err('user not found', 404)

    const valid = await db.category.findMany({ where: { slug: { in: categoryIds } } })
    if (valid.length === 0) return err('unknown categories')

    const slugs = valid.map((c) => c.slug)
    await db.user.update({ where: { id: userId }, data: { categories: JSON.stringify(slugs) } })

    return NextResponse.json({ ok: true, categories: slugs })
  } catch (e) {
    console.error('[user/categories]', e)
    return err('failed', 500)
  }
}
