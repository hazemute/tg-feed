import { db } from '@/lib/db'
import { getCustomEmojiStickers } from '@/lib/tg-bot'
import { premiumMap } from '@/lib/tg-emoji'

/**
 * ПРЕМИУМ-ЭМОДЗИ В ЧАТАХ ИИ (v5.40) — приказ владельца: «дай доступ иишкам
 * пользоваться премиум эмодзи прямо в miniapp».
 *
 * Механика: слоты BotEmoji (16 проверенных custom_emoji_id, tg-emoji.ts) —
 * это мост между юникод-эмодзи и премиум-анимациями. Сервер заменяет в ответе
 * ИИ юникод-эмодзи на маркеры ![ev:ID](/api/emoji/ID) — клиентский RichText
 * рендерит их как видео-стикеры/Lottie/картинки (TelegramEmoji.tsx).
 *
 * Реестр CustomEmoji для слотов синхронизируется лениво, один раз на инстанс:
 * getCustomEmojiStickers отдаёт file_id ВСЕМ эмодзи (включая статичные) —
 * значит /api/emoji/[id] резолвит CDN-ссылку даже без анимации.
 */

let registrySynced = false

async function ensureSlotEmojiRegistry(): Promise<void> {
  if (registrySynced) return
  registrySynced = true
  try {
    const map = await premiumMap()
    if (map.size === 0) return
    const ids = [...new Set(map.values())]
    const known = await db.customEmoji.findMany({ where: { id: { in: ids } }, select: { id: true } })
    const knownSet = new Set(known.map((r) => r.id))
    const missing = ids.filter((id) => !knownSet.has(id))
    if (missing.length === 0) return
    const stickers = await getCustomEmojiStickers(missing)
    for (const id of missing) {
      const s = stickers.get(id)
      if (!s) continue
      const row = {
        id,
        kind: (s.video ? 'video' : s.animated ? 'lottie' : 'static') as 'video' | 'lottie' | 'static',
        animated: s.animated,
        // file_id есть у всех кастом-эмодзи — статичные тоже резолвятся через /api/emoji
        fileId: s.fileId,
      }
      await db.customEmoji
        .upsert({
          where: { id },
          create: row,
          update: { kind: row.kind, animated: row.animated, fileId: row.fileId },
        })
        .catch(() => {})
    }
  } catch {
    // синхронизация не удалась — эмодзи останутся юникодом, это безопасный фолбэк
  }
}

/**
 * Заменить юникод-эмодзи из слотов бота на маркеры премиум-эмодзи.
 * Никогда не бросает и не задерживает ответ дольше одного Bot API вызова
 * (один раз за жизнь инстанса).
 */
export async function aiPremiumEmojiText(text: string): Promise<string> {
  try {
    const map = await premiumMap()
    if (map.size === 0) return text
    await ensureSlotEmojiRegistry()
    const rows = await db.customEmoji.findMany({
      where: { id: { in: [...new Set(map.values())] } },
      select: { id: true, kind: true },
    })
    const kindById = new Map(rows.map((r) => [r.id, r.kind]))
    let out = text
    for (const [emoji, id] of map) {
      if (!out.includes(emoji)) continue
      const kind = kindById.get(id)
      if (!kind) continue // нет файла — оставляем юникод (клиент рендерит текстом)
      const marker =
        kind === 'video'
          ? `![ev:${id}](/api/emoji/${id})`
          : kind === 'lottie'
            ? `![el:${id}](/api/emoji/${id})`
            : `![e:${id}](/api/emoji/${id})`
      out = out.split(emoji).join(marker)
    }
    return out
  } catch {
    return text
  }
}
