import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'
import { getCustomEmojiStickers } from '@/lib/tg-bot'
import { clearAnimatedEmojiKindsCache } from '@/lib/emoji-registry'
import { backfillCustomEmoji } from '@/lib/parse-engine'

export const dynamic = 'force-dynamic'

/**
 * POST /api/panel/emoji/recheck (админка, x-admin-key) — ретроактивная
 * перепроверка «статичных» премиум-эмодзи через Bot API getCustomEmojiStickers.
 *
 * ЗАЧЕМ: исторические прогоны (сбой Bot API, старый баг маппинга file_id)
 * записали анимированные эмодзи в реестр как kind='static' навсегда — клиент
 * рисовал картинку вместо видео/Lottie. Реестр не имел TTL перепроверки.
 *
 * ЧТО ДЕЛАЕТ: берёт пачку kind='static' строк, спрашивает Bot API правду и
 * ТОЛЬКО ПОВЫШАЕТ (upgrade-only): static → video/lottie (+fileId). Статичные
 * по правде не трогает (никаких даунгрейдов). Возвращает { checked, upgraded,
 * remaining } — если remaining > 0, вызвать ещё раз (пачки по ~200 id).
 * После прогона сбрасывает кэш реестра animatedEmojiKinds (dto.ts сразу
 * начинает отдавать ![ev:]/![el:] маркеры).
 */
const CHUNK = 200

export async function POST(request: Request) {
  const g = guardAdmin(request, { limit: 4, windowMs: 60_000, bucket: 'panel-emoji-recheck' })
  if (!g.ok) return g.res

  try {
    /* Режим 'backfill' (v5.26): ДОполняем реестр ID-ами из маркеров уже
     * существующих постов, которых в CustomEmoji нет вообще (канал не
     * перепарсивался с появления эмодзи). Отличается от дефолтного режима:
     * тот перепроверяет уже записанные 'static' строки, этот добавляет
     * отсутствующие. */
    let action = 'recheck'
    try {
      // readJson: кап 64KB по content-length ДО чтения тела
      const body = await readJson<{ action?: unknown }>(request)
      if (typeof body?.action === 'string' && body.action === 'backfill') action = 'backfill'
    } catch {
      // пустое тело — дефолтный recheck
    }
    if (action === 'backfill') {
      const r = await backfillCustomEmoji({ scan: 2000 })
      return NextResponse.json({ checked: r.scanned, upgraded: r.added, remaining: 0 })
    }

    const batch = await db.customEmoji.findMany({
      where: { kind: 'static' },
      orderBy: { fetchedAt: 'asc' }, // сначала давно не проверявшиеся
      take: CHUNK * 10, // потолок одного вызова: ~2000 строк / ~10 чанков Bot API
      select: { id: true },
    })
    if (batch.length === 0) {
      return NextResponse.json({ checked: 0, upgraded: 0, remaining: 0 })
    }

    let checked = 0
    let upgraded = 0
    for (let i = 0; i < batch.length; i += CHUNK) {
      const ids = batch.slice(i, i + CHUNK).map((r) => r.id)
      const stickers = await getCustomEmojiStickers(ids)
      const touched: string[] = []
      for (const id of ids) {
        checked++
        const s = stickers.get(id)
        // Правда только про анимацию: video (webm) или Lottie (.tgs).
        // Статичные по правде строки не переписываем (нет даунгрейдов).
        if (!s || (!s.video && !s.animated) || !s.fileId) {
          touched.push(id) // подтверждена статика — отметим, чтобы не проверять заново каждый прогон
          continue
        }
        const kind = s.video ? 'video' : 'lottie'
        await db.customEmoji
          .update({ where: { id }, data: { kind, animated: true, fileId: s.fileId } })
          .catch(() => {})
        upgraded++
      }
      if (touched.length > 0) {
        await db.customEmoji
          .updateMany({ where: { id: { in: touched } }, data: { fetchedAt: new Date() } })
          .catch(() => {})
      }
    }

    // Реестр выдачи (память процесса) — сброс, чтобы маркеры переписались сразу
    clearAnimatedEmojiKindsCache()

    const remaining = await db.customEmoji.count({ where: { kind: 'static' } })
    return NextResponse.json({ checked, upgraded, remaining })
  } catch (e) {
    console.error('[emoji recheck]', e)
    return err('recheck failed', 500)
  }
}
