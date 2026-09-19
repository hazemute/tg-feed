import { db } from '@/lib/db'

/**
 * ПРЕМИУМ-ЭМОДЗИ БОТА (v5.22).
 *
 * Кастом-эмодзи в сообщениях бота — по слотам: в тексте стоит обычный
 * юникод-эмодзи, а при отправке он оборачивается в <tg-emoji emoji-id="…">
 * если админ задал custom_emoji_id для этого слота (ID берутся из
 * премиум-паков аккаунта владельца).
 *
 * КАНАЛЫ ОТПРАВКИ (по порядку, с автоматическим фолбэком):
 *  1. business_connection_id — бот отправляет сообщение ОТ ИМЕНИ
 *     премиум-аккаунта владельца (Telegram Business → Chatbots: аккаунт
 *     7851246214 подключен как посредник) — кастом-эмодзи работают.
 *  2. Бот сам (работает, если у бота Fragment-username).
 *  3. Обычный текст: tg-emoji вырезаются, остаются юникод-эмодзи.
 */

const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN?.trim() ?? ''

export type BotEmojiSlot = {
  slot: string
  emoji: string
  customEmojiId: string
}

/** Дефолтные слоты (сидируются при первом чтении; editable в админке) */
export const DEFAULT_SLOTS: Array<{ slot: string; emoji: string; label: string }> = [
  { slot: 'wave', emoji: '👋', label: 'Приветствие' },
  { slot: 'fire', emoji: '🔥', label: 'Огонь/популярное' },
  { slot: 'star', emoji: '⭐', label: 'Звезда' },
  { slot: 'sparkles', emoji: '✨', label: 'Магия/ИИ' },
  { slot: 'rocket', emoji: '🚀', label: 'Продвижение' },
  { slot: 'heart', emoji: '❤️', label: 'Лайк' },
  { slot: 'bell', emoji: '🔔', label: 'Уведомления' },
  { slot: 'book', emoji: '📖', label: 'Читать' },
  { slot: 'check', emoji: '✅', label: 'Готово' },
  { slot: 'crown', emoji: '👑', label: 'Премиум' },
  { slot: 'zap', emoji: '⚡', label: 'Скорость' },
  { slot: 'party', emoji: '🎉', label: 'Праздник' },
  { slot: 'link', emoji: '🔗', label: 'Ссылка' },
  { slot: 'chat', emoji: '💬', label: 'Чат' },
]

/* ------------------------- кэш слотов ------------------------- */

type SlotMap = Map<string, string> // emoji char → custom_emoji_id
let slotsCache: { map: SlotMap; exp: number } | null = null
const SLOTS_TTL_MS = 60_000

async function ensureSeeded(): Promise<void> {
  // Сидируем недостающие слоты (идемпотентно, one insert per slot)
  const existing = await db.botEmoji.findMany({ select: { slot: true } })
  const have = new Set(existing.map((e) => e.slot))
  const missing = DEFAULT_SLOTS.filter((d) => !have.has(d.slot))
  if (missing.length > 0) {
    await db.botEmoji
      .createMany({
        data: missing.map((d) => ({ slot: d.slot, emoji: d.emoji, customEmojiId: '' })),
      })
      .catch(() => {})
  }
}

export async function premiumMap(): Promise<SlotMap> {
  if (slotsCache && slotsCache.exp > Date.now()) return slotsCache.map
  try {
    await ensureSeeded()
    const rows = await db.botEmoji.findMany()
    const map: SlotMap = new Map()
    for (const r of rows) {
      if (r.customEmojiId && r.emoji) map.set(r.emoji, r.customEmojiId)
    }
    slotsCache = { map, exp: Date.now() + SLOTS_TTL_MS }
    return map
  } catch {
    return new Map()
  }
}

export function invalidateSlotsCache(): void {
  slotsCache = null
}

/* ------------------------- настройка текста ------------------------- */

/**
 * Обернуть юникод-эмодзи с известными custom_emoji_id в <tg-emoji>.
 * HTML уже валиден (parse_mode=HTML), теги не ломают остальную разметку.
 */
export async function premiumText(text: string): Promise<string> {
  const map = await premiumMap()
  if (map.size === 0) return text
  let out = text
  for (const [emoji, id] of map) {
    if (!text.includes(emoji)) continue
    out = out.split(emoji).join(`<tg-emoji emoji-id="${id}">${emoji}</tg-emoji>`)
  }
  return out
}

/** Фолбэк: вырезать tg-emoji, оставить юникод-эмодзи */
export function stripTgEmoji(text: string): string {
  return text.replace(/<tg-emoji[^>]*>([\s\S]*?)<\/tg-emoji>/g, '$1')
}

/* ------------------------- настройки бота ------------------------- */

export type BusinessConnection = {
  id: string
  userId: number
  isEnabled: boolean
  updatedAt: string
}

export async function getBusinessConnection(): Promise<BusinessConnection | null> {
  const row = await db.botSetting
    .findUnique({ where: { key: 'business_connection' } })
    .catch(() => null)
  if (!row) return null
  try {
    const v = JSON.parse(row.value) as { id: string; userId: number; isEnabled: boolean }
    return { ...v, updatedAt: row.updatedAt.toISOString() }
  } catch {
    return null
  }
}

export async function setBusinessConnection(v: {
  id: string
  userId: number
  isEnabled: boolean
}): Promise<void> {
  await db.botSetting.upsert({
    where: { key: 'business_connection' },
    create: { key: 'business_connection', value: JSON.stringify(v) },
    update: { value: JSON.stringify(v) },
  })
}

/* ------------------------- вызовы Bot API ------------------------- */

export type BotSendResult = { ok: boolean; via: 'business' | 'bot_premium' | 'bot_plain'; error?: string }

type SendOpts = {
  keyboard?: Array<Array<{ text: string; url?: string; callback_data?: string }>>
  /** Не оборачивать эмодзи (текст уже готов) */
  skipPremiumWrap?: boolean
}

async function tgCall(
  method: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; description?: string }> {
  if (!BOT_TOKEN()) return { ok: false, description: 'TELEGRAM_BOT_TOKEN не задан' }
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })
    const data = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null
    if (data?.ok) return { ok: true }
    return { ok: false, description: data?.description ?? `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, description: String((e as Error)?.message ?? e) }
  }
}

/**
 * Отправить сообщение с премиум-эмодзи и автоматическим фолбэком:
 * business → бот (tg-emoji) → бот (plain). Никогда не бросает.
 */
export async function botSendRich(
  chatId: number | string,
  htmlText: string,
  opts: SendOpts = {},
): Promise<BotSendResult> {
  const text = opts.skipPremiumWrap ? htmlText : await premiumText(htmlText)
  const reply_markup = opts.keyboard ? { inline_keyboard: opts.keyboard } : undefined

  // 1) От имени премиум-аккаунта (посредник)
  const bc = await getBusinessConnection().catch(() => null)
  if (bc && bc.isEnabled && bc.id) {
    const r = await tgCall('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...(reply_markup ? { reply_markup } : {}),
      business_connection_id: bc.id,
    })
    if (r.ok) return { ok: true, via: 'business' }
  }

  // 2) Бот сам с кастом-эмодзи (Fragment-username)
  const r2 = await tgCall('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...(reply_markup ? { reply_markup } : {}),
  })
  if (r2.ok) return { ok: true, via: 'bot_premium' }

  // 3) Фолбэк: обычный текст без кастом-эмодзи
  const r3 = await tgCall('sendMessage', {
    chat_id: chatId,
    text: stripTgEmoji(htmlText),
    parse_mode: 'HTML',
    ...(reply_markup ? { reply_markup } : {}),
  })
  return r3.ok
    ? { ok: true, via: 'bot_plain' }
    : { ok: false, via: 'bot_plain', error: r3.description ?? r2.description }
}
