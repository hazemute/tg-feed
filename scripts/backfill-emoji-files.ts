/**
 * Разовый бэкфилл: CustomEmoji (kind='video') без fileId → Bot API
 * getCustomEmojiStickers (read-only, чанки 200, паузы против флуд-лимитов).
 * Запуск: bun scripts/backfill-emoji-files.ts  (один раз, не по расписанию)
 */
import { PrismaClient } from '@prisma/client'

const BOT_TOKEN = process.env.BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN ?? ''
const CHUNK = 200
const PAUSE_MS = 2500

const db = new PrismaClient()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  if (!BOT_TOKEN) {
    console.error('BOT_TOKEN не найден в .env')
    process.exit(1)
  }
  const rows = await db.customEmoji.findMany({
    where: { kind: 'video', fileId: null },
    select: { id: true },
  })
  console.log(`к бэкфиллу: ${rows.length} эмодзи`)
  let ok = 0
  let miss = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map((r) => r.id)
    try {
      const res = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/getCustomEmojiStickers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ custom_emoji_ids: chunk }),
        signal: AbortSignal.timeout(12_000),
      })
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean
        result?: Array<{ custom_emoji_id?: string; file_id?: string }>
      } | null
      for (const s of data?.result ?? []) {
        if (s.custom_emoji_id && s.file_id) {
          await db.customEmoji.update({
            where: { id: s.custom_emoji_id },
            data: { fileId: s.file_id },
          })
          ok++
        } else {
          miss++
        }
      }
      console.log(`чанк ${Math.floor(i / CHUNK) + 1}/${Math.ceil(rows.length / CHUNK)}: +${ok} всего`)
    } catch (e) {
      console.error('чанк failed:', (e as Error).message)
    }
    await sleep(PAUSE_MS)
  }
  const left = await db.customEmoji.count({ where: { kind: 'video', fileId: null } })
  console.log(`готово: file_id заполнен для ${ok}, без файла ${miss}, осталось пустых: ${left}`)
  await db.$disconnect()
}

void main()
