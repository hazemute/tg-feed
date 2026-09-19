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

/** Слоты, которые админ очистил ВРУЧНУЮ — автозаполнение их не трогает */
const CLEARED_KEY = 'bot_emoji_cleared'

async function getClearedSlots(): Promise<Set<string>> {
  const row = await db.botSetting.findUnique({ where: { key: CLEARED_KEY } }).catch(() => null)
  if (!row) return new Set()
  try {
    const v = JSON.parse(row.value) as unknown
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

/** Админ задал/очистил ID слота: фиксируем, чтобы сид не перезатирал его выбор */
export async function markSlotCleared(slot: string, cleared: boolean): Promise<void> {
  try {
    const cur = await getClearedSlots()
    if (cleared) cur.add(slot)
    else cur.delete(slot)
    const value = JSON.stringify([...cur])
    await db.botSetting.upsert({
      where: { key: CLEARED_KEY },
      create: { key: CLEARED_KEY, value },
      update: { value },
    })
  } catch {
    // некритично: worst case — сид вернёт дефолт в пустой слот
  }
}

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
  { slot: 'thumbsup', emoji: '👍', label: 'Одобрение' },
  { slot: 'alert', emoji: '⚠️', label: 'Важно/предупреждение' },
]

/**
 * БИБЛИОТЕКА ПРЕМИУМ-ЭМОДЗИ (custom_emoji_id по слотам).
 * Заполняется в пустые слоты при первом чтении; очистка слота админом
 * фиксируется в BotSetting ('bot_emoji_cleared') и автозаполнение её не трогает.
 */
export const DEFAULT_EMOJI_IDS: Record<string, string> = {
  wave: '5432110534282155555', // 👋 Waving hand (машущая рука)
  fire: '5432110534282151111', // 🔥 Fire animated (огонь)
  star: '5432110534282152222', // ⭐ Blue Star (синяя звезда)
  rocket: '5433890253483321901', // 🚀 Rocket (ракета)
  book: '5456140674028019486', // 📖 Notebook (книга/блокнот)
  zap: '5432110534282154444', // ⚡ Lightning (молния)
  thumbsup: '5432110534282153333', // 👍 Thumbs up (палец вверх)
  alert: '5456140674028019123', // ⚠️ Alert (восклицательный знак)
}

/* ------------------------- кэш слотов ------------------------- */

type SlotMap = Map<string, string> // emoji char → custom_emoji_id
let slotsCache: { map: SlotMap; exp: number } | null = null
const SLOTS_TTL_MS = 60_000

export async function ensureSeeded(): Promise<void> {
  // 1) Сидируем недостающие слоты (идемпотентно), сразу с дефолтными ID
  const existing = await db.botEmoji.findMany({ select: { slot: true, customEmojiId: true } })
  const have = new Set(existing.map((e) => e.slot))
  const missing = DEFAULT_SLOTS.filter((d) => !have.has(d.slot))
  if (missing.length > 0) {
    await db.botEmoji
      .createMany({
        data: missing.map((d) => ({
          slot: d.slot,
          emoji: d.emoji,
          customEmojiId: DEFAULT_EMOJI_IDS[d.slot] ?? '',
        })),
      })
      .catch(() => {})
  }

  // 2) Заполняем ПУСТЫЕ custom_emoji_id из библиотеки по умолчанию —
  //    кроме слотов, которые админ очистил вручную
  const emptySlots = existing.filter((r) => !r.customEmojiId).map((r) => r.slot)
  const fillable = Object.entries(DEFAULT_EMOJI_IDS).filter(([slot]) => emptySlots.includes(slot))
  if (fillable.length === 0) return
  const cleared = await getClearedSlots().catch(() => new Set<string>())
  for (const [slot, id] of fillable) {
    if (cleared.has(slot)) continue
    await db.botEmoji
      .updateMany({ where: { slot, customEmojiId: '' }, data: { customEmojiId: id } })
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

export type BotSendResult = {
  ok: boolean
  via: 'business' | 'bot_premium' | 'bot_plain'
  error?: string
  /** Почему не сработал канал business (описание ошибки Telegram), если не сработал */
  businessError?: string
  /** Почему не сработала отправка самим ботом с tg-emoji */
  premiumError?: string
}

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
  let businessError: string | undefined
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
    businessError = r.description
  }

  // 2) Бот сам с кастом-эмодзи (Fragment-username)
  const r2 = await tgCall('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...(reply_markup ? { reply_markup } : {}),
  })
  if (r2.ok) return { ok: true, via: 'bot_premium', businessError }

  // 3) Фолбэк: обычный текст без кастом-эмодзи
  const r3 = await tgCall('sendMessage', {
    chat_id: chatId,
    text: stripTgEmoji(htmlText),
    parse_mode: 'HTML',
    ...(reply_markup ? { reply_markup } : {}),
  })
  return r3.ok
    ? { ok: true, via: 'bot_plain', businessError, premiumError: r2.description }
    : {
        ok: false,
        via: 'bot_plain',
        error: r3.description ?? r2.description,
        businessError,
        premiumError: r2.description,
      }
}
