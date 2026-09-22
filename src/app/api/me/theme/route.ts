import { NextResponse } from 'next/server'
import { err } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { db } from '@/lib/db'
import { isValidCustomTheme } from '@/lib/custom-theme'

export const dynamic = 'force-dynamic'

/**
 * Тема оформления на сервере (v5.94): синк между устройствами.
 *
 * Устройство А меняет тему → PUT {mode, custom}; устройство Б при входе
 * (page.tsx после auth) тянет GET и применяет то же самое. Хранение —
 * User.themeSettings, JSON {mode, custom:{bg,accent} | null}.
 *
 * Guests темы не синкают (id guest_* — ответ-заглушка, БД не трогаем):
 * у гостя сессии нет, «устройств» с общим профилем тоже.
 */

/** Runtime-копия ThemeMode (lib/types) — для валидации тела запроса */
const MODES = new Set<string>([
  'auto', 'light', 'dark', 'sepia', 'sand', 'rose', 'mint', 'lavender', 'pearl',
  'lime', 'honey', 'coral', 'mono', 'forest', 'ocean', 'midnight', 'plum',
  'coffee', 'sunset', 'emerald', 'crimson', 'aurora', 'cherry', 'custom',
])

type StoredTheme = { mode: string; custom: { bg: string; accent: string } | null }

/** Распарсить сохранённый JSON; битое/неприменимое → null (не роняем клиент) */
function parseStored(raw: string | null): StoredTheme | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<StoredTheme>
    if (!v || typeof v.mode !== 'string' || !MODES.has(v.mode)) return null
    const custom = v.custom && isValidCustomTheme(v.custom) ? v.custom : null
    // custom без валидной палитры клиент не отрисует — считаем записью пустой
    if (v.mode === 'custom' && !custom) return null
    return { mode: v.mode, custom }
  } catch {
    return null
  }
}

/** GET — тема, сохранённая на сервере. {mode:null} — ещё не сохраняли. */
export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 30, windowMs: 60_000, bucket: 'theme-get' })
  if (!g.ok) return g.res
  try {
    if (g.uid.startsWith('guest_')) return NextResponse.json({ mode: null })
    const u = await db.user.findUnique({
      where: { id: g.uid },
      select: { themeSettings: true },
    })
    const st = parseStored(u?.themeSettings ?? null)
    return NextResponse.json(st ? { mode: st.mode, custom: st.custom } : { mode: null })
  } catch (e) {
    console.error('[theme]', e)
    return err('theme get failed', 500)
  }
}

/** PUT — сохранить тему (вызывает устройство, на котором меняли) */
export async function PUT(request: Request) {
  const g = guardAuth(request, { limit: 30, windowMs: 60_000, bucket: 'theme-put' })
  if (!g.ok) return g.res
  if (g.uid.startsWith('guest_')) return NextResponse.json({ ok: true })
  try {
    const body = (await request.json().catch(() => null)) as Partial<StoredTheme> | null
    if (!body || typeof body.mode !== 'string' || !MODES.has(body.mode)) {
      return err('bad mode', 400)
    }
    const custom = body.custom && isValidCustomTheme(body.custom) ? body.custom : null
    if (body.mode === 'custom' && !custom) return err('custom palette required', 400)
    await db.user.update({
      where: { id: g.uid },
      data: { themeSettings: JSON.stringify({ mode: body.mode, custom }) },
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[theme]', e)
    return err('theme put failed', 500)
  }
}
