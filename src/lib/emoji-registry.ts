import { db } from '@/lib/db'

/*
 * Реестр анимированных премиум-эмодзи Telegram.
 *
 * CustomEmoji (kind='video'|'lottie', fileId NOT NULL) — те ID, которые Bot API
 * подтвердил как анимированные: клиент рендерит видео-стикеры как <video>,
 * Lottie-наборы (.tgs) через lottie-web — оба через /api/emoji/[id]
 * (см. TelegramEmoji.tsx). Реестр используется на выдаче (dto.ts:
 * upgradeAnimatedEmoji) — анимация работает ретроактивно для ВСЕХ старых
 * постов, без перезаписи текстов в БД.
 *
 * Кэш в памяти процесса 10 минут: таблица меняется редко (новые ID при
 * парсинге), полный select крошечный (~9k строк int-ключей).
 */

export type AnimatedKind = 'video' | 'lottie'

type Registry = { kinds: Map<string, AnimatedKind>; exp: number }
let cache: Registry | null = null
const TTL_MS = 10 * 60_000

const EMPTY: Map<string, AnimatedKind> = new Map()

export function animatedEmojiKinds(): Map<string, AnimatedKind> {
  if (cache && cache.exp > Date.now()) return cache.kinds
  // Прогрев/обновление в фоне: первый запрос может отдать статику —
  // через мгновение реестр тёплый на 10 минут
  void loadAnimatedEmojiKinds()
  return cache && cache.exp > Date.now() ? cache.kinds : EMPTY
}

export async function loadAnimatedEmojiKinds(): Promise<Map<string, AnimatedKind>> {
  if (cache && cache.exp > Date.now()) return cache.kinds
  try {
    const rows = await db.customEmoji.findMany({
      where: { kind: { in: ['video', 'lottie'] }, fileId: { not: null } },
      select: { id: true, kind: true },
    })
    const kinds = new Map<string, AnimatedKind>()
    for (const r of rows) {
      if (r.kind === 'video' || r.kind === 'lottie') kinds.set(r.id, r.kind)
    }
    cache = { kinds, exp: Date.now() + TTL_MS }
    return kinds
  } catch {
    // БД недоступна — эмодзи остаются статичными до следующей попытки (60с)
    cache = { kinds: EMPTY, exp: Date.now() + 60_000 }
    return EMPTY
  }
}

// Прогрев реестра при первом импорте модуля (серверная часть)
void loadAnimatedEmojiKinds()
