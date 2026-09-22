import { db } from '@/lib/db'

/**
 * АВТО-МОДЕРАЦИЯ (v5.98) — изолированный фильтр безопасности Snap Team.
 *
 * Любой рекламный/спонсорский контент (текст поста, caption, username и
 * описание канала) ОБЯЗАН пройти через assertClean() ДО создания инвойса.
 * Совпадение со стоп-словом → операция мгновенно обрывается, автор попадает
 * в Blacklist наглухо: бот молча игнорирует его сообщения, инвойсы не
 * создаются. Ручного подтверждения нет — фильтр финальный.
 *
 * Нормализация против обходов: lowercase, ё→е, удаление пунктуации/разделителей
 * и «невидимых» символов, схлопывание пробелов. '1WIN', '1-W-I-N', 'СЛОты'
 * ловятся одинаково.
 */

export const AUTOMOD_REJECT_MESSAGE =
  '🚫 Заявка отклонена автоматическим фильтром безопасности Snap Team'

/** Стоп-слова: казино/букмекеры/схемы заработка/сливы/крипта-развод (регистронезависимо) */
export const AUTOMOD_STOP_WORDS = [
  'казино',
  'casino',
  '1win',
  'слоты',
  'slots',
  'ставки',
  'bet',
  'прогнозы',
  'темки',
  'схемы заработка',
  'слив приватки',
  'сигналы крипта',
  'p2p арбитраж',
  'крипта обучение',
  'быстрый заработок',
  '1хбет',
] as const

/** Убираем всё, что помогает обойти фильтр, и сравниваем нормализованные строки */
function normalize(input: string): string {
  return input
    .toLowerCase()
    .replaceAll('ё', 'е')
    // невидимые символы (zero-width, soft-hyphen, BOM) — в мусор
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff\u00ad]/g, '')
    // пунктуация/символы-разделители → пробел (1-w-i-n → 1 w i n)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const NORMALIZED_STOP_WORDS = AUTOMOD_STOP_WORDS.map(normalize)

export type AutoModVerdict = { ok: true } | { ok: false; matched: string }

/**
 * Проверка текста/username/описания на стоп-слова.
 * Возвращает первое совпадение или ok:true. Не бросает — решение за вызывающим.
 */
export function autoModCheck(input: string | null | undefined): AutoModVerdict {
  if (!input) return { ok: true }
  const hay = normalize(String(input))
  if (!hay) return { ok: true }
  // Дополнительно проверяем строку без пробелов — ловит «с л о т ы» и «сл оты»
  const compact = hay.replaceAll(' ', '')
  for (let i = 0; i < NORMALIZED_STOP_WORDS.length; i++) {
    const w = NORMALIZED_STOP_WORDS[i]
    if (w.length === 0) continue
    if (hay.includes(w) || compact.includes(w.replaceAll(' ', ''))) {
      return { ok: false, matched: AUTOMOD_STOP_WORDS[i] }
    }
  }
  return { ok: true }
}

/** Совпадение со стоп-словом → операция обрывается этой ошибкой */
export class AutoModError extends Error {
  constructor() {
    super(AUTOMOD_REJECT_MESSAGE)
    this.name = 'AutoModError'
  }
}

export function assertClean(input: string | null | undefined): void {
  const v = autoModCheck(input)
  if (!v.ok) throw new AutoModError()
}

/* ------------------------------ Чёрный список ------------------------------ */

export async function isBlacklisted(tgId: number | string): Promise<boolean> {
  const id = String(tgId)
  if (!id || id === '0') return false
  try {
    const row = await db.blacklist.findUnique({ where: { tgId: id }, select: { id: true } })
    return row != null
  } catch {
    return false // ошибка БД не должна молча банить всех
  }
}

/** Занести Telegram ID в чёрный список наглухо (идемпотентно) */
export async function blacklistTgId(
  tgId: number | string,
  reason: string,
  userId?: string | null,
): Promise<void> {
  const id = String(tgId)
  if (!id || id === '0') return
  await db.blacklist
    .upsert({
      where: { tgId: id },
      create: { tgId: id, reason, userId: userId ?? null },
      update: { reason },
    })
    .catch(() => {})
}

/**
 * Полный гард рекламных потоков: чёрный список + авто-модерация контента.
 * Совпадение со стоп-словом сразу заносит автора в Blacklist (наглухо) и бросает.
 * Возвращает false, если автор уже в чёрном списке (молча, без повтора в БД).
 */
export async function guardAdContent(
  tgId: number | string,
  contents: Array<string | null | undefined>,
  userId?: string | null,
): Promise<boolean> {
  if (await isBlacklisted(tgId)) return false
  for (const c of contents) {
    const v = autoModCheck(c)
    if (!v.ok) {
      await blacklistTgId(tgId, `autoMod: ${v.matched}`, userId ?? null)
      throw new AutoModError()
    }
  }
  return true
}
