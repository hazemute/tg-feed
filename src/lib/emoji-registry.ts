import { db } from '@/lib/db'

/*
 * Реестр анимированных премиум-эмодзи Telegram.
 *
 * CustomEmoji (kind='video', fileId NOT NULL) — те ID, которые Bot API
 * подтвердил как видео-стикеры: клиент рендерит их как <video> через
 * /api/emoji/[id] (см. TelegramEmoji.tsx). Реестр используется на выдаче
 * (dto.ts: upgradeAnimatedEmoji) — анимация работает ретроактивно для ВСЕХ
 * старых постов, без перезаписи текстов в БД.
 *
 * Кэш в памяти процесса 10 минут: таблица меняется редко (новые ID при
 * парсинге), полный select крошечный (~9k строк int-ключей).
 */

type Registry = { ids: Set<string>; exp: number }
let cache: Registry | null = null
const TTL_MS = 10 * 60_000

export function animatedEmojiIds(): Set<string> {
  if (cache && cache.exp > Date.now()) return cache.ids
  // Прогрев/обновление в фоне: первый запрос может отдать статику —
  // через мгновение реестр тёплый на 10 минут
  void loadAnimatedEmojiIds()
  return cache && cache.exp > Date.now() ? cache.ids : EMPTY
}

const EMPTY: Set<string> = new Set()

export async function loadAnimatedEmojiIds(): Promise<Set<string>> {
  if (cache && cache.exp > Date.now()) return cache.ids
  try {
    const rows = await db.customEmoji.findMany({
      where: { kind: 'video', fileId: { not: null } },
      select: { id: true },
    })
    const ids = new Set(rows.map((r) => r.id))
    cache = { ids, exp: Date.now() + TTL_MS }
    return ids
  } catch {
    // БД недоступна — эмодзи остаются статичными до следующей попытки (60с)
    cache = { ids: EMPTY, exp: Date.now() + 60_000 }
    return EMPTY
  }
}

// Прогрев реестра при первом импорте модуля (серверная часть)
void loadAnimatedEmojiIds()
