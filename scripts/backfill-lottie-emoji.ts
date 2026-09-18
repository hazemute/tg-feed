/**
 * Бэкфилл премиум-эмодзи: переклассификация «статичных» ID по новым полям
 * Bot API (is_animated). Раньше upgradeCustomEmoji различал только is_video —
 * тысячи Lottie-эмодзи (.tgs) навсегда остались kind='static' без fileId.
 *
 * Что делает:
 *   1) берёт все CustomEmoji с kind='static' (и опционально вообще все без
 *      fileId — флаг --all, включая видео с потерянным fileId);
 *   2) чанками по 200 дёргает getCustomEmojiStickers (одна команда на чанк);
 *   3) обновляет kind ('video' | 'lottie' | 'static'), animated, fileId.
 *
 * Реестр (emoji-registry) и апгрейд маркеров работают на ВЫДАЧЕ, поэтому после
 * прогона ВСЕ старые посты мгновенно получают анимацию — перезапись текстов
 * постов не нужна. Контент не трогается вообще — только классификация эмодзи.
 *
 * Запуск: DATABASE_URL=... bun scripts/backfill-lottie-emoji.ts [--all]
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()
const CHUNK = 200
const all = process.argv.includes('--all')

async function getStickers(ids: string[]) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN required')
  const res = await fetch(`https://api.telegram.org/bot${token}/getCustomEmojiStickers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ custom_emoji_ids: ids }),
    signal: AbortSignal.timeout(15_000),
  })
  const data = (await res.json()) as {
    ok?: boolean
    result?: Array<{ custom_emoji_id?: string; is_video?: boolean; is_animated?: boolean; file_id?: string }>
  }
  const out = new Map<string, { video: boolean; animated: boolean; fileId: string | null }>()
  for (const s of data?.result ?? []) {
    if (s.custom_emoji_id) {
      out.set(s.custom_emoji_id, {
        video: s.is_video === true,
        animated: s.is_animated === true,
        fileId: s.file_id ?? null,
      })
    }
  }
  return out
}

async function main() {
  const where = all
    ? { fileId: null }
    : { kind: 'static' as const }
  const rows = await db.customEmoji.findMany({ where, select: { id: true } })
  console.log(`[backfill] к перезаписи: ${rows.length} (режим: ${all ? '--all без fileId' : 'static'})`)

  let video = 0
  let lottie = 0
  let confirmedStatic = 0
  let missing = 0

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map((r) => r.id)
    try {
      const stickers = await getStickers(chunk)
      for (const id of chunk) {
        const s = stickers.get(id)
        if (!s) {
          missing += 1
          continue // Bot API не знает ID — оставляем как есть
        }
        const kind = s.video ? 'video' : s.animated ? 'lottie' : 'static'
        const fileId = (s.video || s.animated) && s.fileId ? s.fileId : null
        if (kind === 'video') video += 1
        else if (kind === 'lottie') lottie += 1
        else confirmedStatic += 1
        if (kind !== 'static' || fileId) {
          await db.customEmoji.update({
            where: { id },
            data: { kind, animated: s.animated, fileId },
          })
        } else {
          // честная статика — помечаем флагом animated=false (фактов не меняем)
          await db.customEmoji.update({ where: { id }, data: { animated: false } }).catch(() => {})
        }
      }
    } catch (e) {
      console.error(`[backfill] чанк ${i}-${i + chunk.length} упал:`, (e as Error).message)
    }
    if ((i / CHUNK) % 5 === 4) console.log(`  …прогресс ${i + chunk.length}/${rows.length}`)
    // мягкий троттлинг против флуд-лимитов Bot API
    await new Promise((r) => setTimeout(r, 350))
  }

  console.log(
    `[backfill] готово: video=${video}, lottie=${lottie}, static=${confirmedStatic}, неизвестных=${missing}`,
  )
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
