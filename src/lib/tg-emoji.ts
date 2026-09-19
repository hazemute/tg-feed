import { db } from '@/lib/db'
import {
  buildIconKeyboard,
  buildPlainKeyboard,
  type BotButton,
  type InlineKeyboardMarkupTg,
} from '@/lib/tg-buttons'

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
 * БИБЛИТЕКА ПРЕМИУМ-ЭМОДЗИ (custom_emoji_id по слотам).
 * Заполняется в пустые слоты при первом чтении; очистка слота админом
 * фиксируется в BotSetting ('bot_emoji_cleared') и автозаполнение её не трогает.
 *
 * ИСТОЧНИК (v5.24): пак RestrictedEmoji (t.me/addemoji/RestrictedEmoji),
 * карта из открытого дампа github.com/uuigww/telegram_emoji_for_llm —
 * ВСЕ 14 ID провалидированы getCustomEmojiStickers на проде (v5.24).
 * Из исходного списка владельца остался только book (остальные 7 — фиктивные,
 * Telegram их не знал → DOCUMENT_INVALID). alert ⚠️ в паке нет — юникод.
 * Пополнение: захват из сообщений (вебхук → панель «В слот»). */
export const DEFAULT_EMOJI_IDS: Record<string, string> = {
  wave: '5472055112702629499', // 👋
  fire: '5420315771991497307', // 🔥
  star: '5435957248314579621', // ⭐
  sparkles: '5472164874886846699', // ✨
  rocket: '5445284980978621387', // 🚀
  heart: '5449505950283078474', // ❤️
  bell: '5242628160297641831', // 🔔
  book: '5456140674028019486', // 📖 — оригинал владельца (валиден)
  check: '5427009714745517609', // ✅
  crown: '5467406098367521267', // 👑
  zap: '5431449001532594346', // ⚡
  party: '5436040291507247633', // 🎉
  link: '5375129357373165375', // 🔗
  chat: '5465300082628763143', // 💬
  thumbsup: '5469770542288478598', // 👍
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
 *
 * ВАЖНО: невалидный custom_emoji_id ломает ВСЁ sendMessage (Bad Request:
 * DOCUMENT_INVALID) — поэтому ID валидируются через getCustomEmojiStickers
 * при вставке в слот (панель), а захваченные из сообщений приходят только
 * из реальных entities Telegram и существуют по определению.
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

/* ----------------- захваченные custom_emoji (из сообщений юзеров) ----------------- */

/**
 * Премиум-эмодзи, присланные боту сообщениями: Telegram передаёт entity типа
 * custom_emoji с custom_emoji_id — вебхук складывает их сюда, админ забирает
 * ID в панель (кнопка «В слот»). Это ОФИЦИАЛЬНЫЙ способ узнать ID:
 * отправьте/перешлите боту сообщение с нужным премиум-эмодзи.
 */
export type CapturedEmoji = {
  id: string
  emoji: string
  fromId: number
  fromName: string
  at: string
}

const CAPTURED_KEY = 'custom_emoji_captured'
const CAPTURED_MAX = 100

function isCaptured(x: unknown): x is CapturedEmoji {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return typeof o.id === 'string' && typeof o.emoji === 'string'
}

export async function listCapturedEmoji(): Promise<CapturedEmoji[]> {
  const row = await db.botSetting
    .findUnique({ where: { key: CAPTURED_KEY } })
    .catch(() => null)
  if (!row) return []
  try {
    const v = JSON.parse(row.value) as unknown
    return Array.isArray(v) ? v.filter(isCaptured) : []
  } catch {
    return []
  }
}

/** Дописать захваченные эмодзи (дедуп по id, новейшие сверху, максимум 100) */
export async function addCapturedEmoji(items: CapturedEmoji[]): Promise<void> {
  if (items.length === 0) return
  const cur = await listCapturedEmoji().catch((): CapturedEmoji[] => [])
  const byId = new Map(cur.map((c) => [c.id, c]))
  for (const it of items) byId.set(it.id, it)
  const next = [...byId.values()]
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, CAPTURED_MAX)
  const value = JSON.stringify(next)
  await db.botSetting.upsert({
    where: { key: CAPTURED_KEY },
    create: { key: CAPTURED_KEY, value },
    update: { value },
  })
}

export async function forgetCapturedEmoji(id: string): Promise<void> {
  const cur = await listCapturedEmoji().catch(() => [])
  const next = cur.filter((c) => c.id !== id)
  const value = JSON.stringify(next)
  await db.botSetting.upsert({
    where: { key: CAPTURED_KEY },
    create: { key: CAPTURED_KEY, value },
    update: { value },
  })
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
  /** Кнопки: премиум-иконки (icon_custom_emoji_id из слотов) + цветные стили,
   *  фолбэк — юникод-эмодзи в тексте (см. tg-buttons.ts) */
  keyboard?: BotButton[][]
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
 * business (plain-кнопки) → бот (tg-emoji + иконки в кнопках) →
 * бот (plain-текст + иконки) → бот (всё plain).
 * Иконки кнопок — icon_custom_emoji_id (v5.29), стили — success/primary/danger.
 * Никогда не бросает.
 */
export async function botSendRich(
  chatId: number | string,
  htmlText: string,
  opts: SendOpts = {},
): Promise<BotSendResult> {
  const text = opts.skipPremiumWrap ? htmlText : await premiumText(htmlText)
  const rows = opts.keyboard

  let iconMarkup: InlineKeyboardMarkupTg | undefined
  let plainMarkup: InlineKeyboardMarkupTg | undefined
  if (rows) {
    iconMarkup = buildIconKeyboard(rows, await premiumMap()).markup
    plainMarkup = buildPlainKeyboard(rows)
  }

  // 1) От имени премиум-аккаунта (посредник) — иконки не поддерживаются, plain
  let businessError: string | undefined
  const bc = await getBusinessConnection().catch(() => null)
  if (bc && bc.isEnabled && bc.id) {
    const r = await tgCall('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...(plainMarkup ? { reply_markup: plainMarkup } : {}),
      business_connection_id: bc.id,
    })
    if (r.ok) return { ok: true, via: 'business' }
    businessError = r.description
  }

  // 2) Бот сам: кастом-эмодзи в тексте + премиум-иконки в кнопках
  const r2 = await tgCall('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...(iconMarkup ? { reply_markup: iconMarkup } : {}),
  })
  if (r2.ok) return { ok: true, via: 'bot_premium', businessError }

  // 3) Фолбэк текста (юникод), иконки в кнопках ещё пробуем
  const plainText = stripTgEmoji(htmlText)
  const r3 = await tgCall('sendMessage', {
    chat_id: chatId,
    text: plainText,
    parse_mode: 'HTML',
    ...(iconMarkup ? { reply_markup: iconMarkup } : {}),
  })
  if (r3.ok) return { ok: true, via: 'bot_plain', businessError, premiumError: r2.description }

  // 4) Клавиатура тоже не прошла (Premium истёк / битый ID слота) — совсем plain
  const r4 = rows
    ? await tgCall('sendMessage', {
        chat_id: chatId,
        text: plainText,
        parse_mode: 'HTML',
        ...(plainMarkup ? { reply_markup: plainMarkup } : {}),
      })
    : { ok: false, description: undefined as string | undefined }
  return r4.ok
    ? { ok: true, via: 'bot_plain', businessError, premiumError: r2.description }
    : {
        ok: false,
        via: 'bot_plain',
        error: r4.description ?? r3.description ?? r2.description,
        businessError,
        premiumError: r2.description,
      }
}

/* ------------------------- фото-сообщения (/start) ------------------------- */

/** Публичный URL приветственной картинки (public/tgswipe-welcome.png) */
export function startPhotoUrl(): string {
  const base =
    process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, '') || 'https://tg-swipe.vercel.app'
  return `${base}/tgswipe-welcome.png`
}

const PHOTO_FILE_ID_KEY = 'start_photo_file_id'

async function getStartPhotoFileId(): Promise<string> {
  const row = await db.botSetting
    .findUnique({ where: { key: PHOTO_FILE_ID_KEY } })
    .catch(() => null)
  return row?.value ?? ''
}

/** Как и tgCall, но возвращает result — нужен ради file_id из sendPhoto */
async function tgCallFull(
  method: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; description?: string; result?: unknown }> {
  if (!BOT_TOKEN()) return { ok: false, description: 'TELEGRAM_BOT_TOKEN не задан' }
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    })
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; description?: string; result?: unknown }
      | null
    if (data?.ok) return { ok: true, result: data.result }
    return { ok: false, description: data?.description ?? `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, description: String((e as Error)?.message ?? e) }
  }
}

export type PhotoSendResult = {
  ok: boolean
  via: 'photo' | 'text'
  error?: string
}

/**
 * Фото с премиум-подписью для /start: файл file_id из кэша → URL → фото с
 * обычной подписью → фото с plain-клавиатурой → текстовое сообщение.
 * Картинку Telegram качает один раз и дальше отдаёт по file_id (мгновенно).
 * Иконки кнопок — icon_custom_emoji_id (v5.29) с фолбэком на юникод.
 * Никогда не бросает.
 */
export async function botSendPhotoRich(
  chatId: number | string,
  captionHtml: string,
  opts: SendOpts = {},
): Promise<PhotoSendResult> {
  const caption = opts.skipPremiumWrap ? captionHtml : await premiumText(captionHtml)
  const plainCaption = opts.skipPremiumWrap ? captionHtml : stripTgEmoji(captionHtml)
  const rows = opts.keyboard

  let iconMarkup: InlineKeyboardMarkupTg | undefined
  let plainMarkup: InlineKeyboardMarkupTg | undefined
  let hasIcons = false
  if (rows) {
    const built = buildIconKeyboard(rows, await premiumMap())
    iconMarkup = built.markup
    hasIcons = built.hasIcons
    plainMarkup = buildPlainKeyboard(rows)
  }

  const sendPhoto = (photo: string, cap: string, markup?: InlineKeyboardMarkupTg) =>
    tgCallFull('sendPhoto', {
      chat_id: chatId,
      photo,
      caption: cap,
      parse_mode: 'HTML',
      ...(markup ? { reply_markup: markup } : {}),
    })

  const saveFileId = async (r: { result?: unknown }) => {
    // Сохраняем file_id самой большой версии фото для будущих отправок
    const photo = (r.result as { photo?: Array<{ file_id?: string }> } | undefined)?.photo
    const fid = Array.isArray(photo) ? photo[photo.length - 1]?.file_id : undefined
    if (fid) {
      await db.botSetting
        .upsert({
          where: { key: PHOTO_FILE_ID_KEY },
          create: { key: PHOTO_FILE_ID_KEY, value: fid },
          update: { value: fid },
        })
        .catch(() => {})
    }
  }

  // 1) Закэшированный file_id — самый быстрый путь
  const cached = await getStartPhotoFileId()
  if (cached) {
    const r = await sendPhoto(cached, caption, iconMarkup)
    if (r.ok) return { ok: true, via: 'photo' }
  }

  // 2) Отправка по URL — Telegram скачает картинку сам
  const r2 = await sendPhoto(startPhotoUrl(), caption, iconMarkup)
  if (r2.ok) {
    await saveFileId(r2)
    return { ok: true, via: 'photo' }
  }

  // 3) Подпись с tg-emoji не прошла — фото с чистой подписью (иконки ещё пробуем)
  const r3 = await sendPhoto(startPhotoUrl(), plainCaption, iconMarkup)
  if (r3.ok) {
    await saveFileId(r3)
    return { ok: true, via: 'photo' }
  }

  // 4) Иконки не прошли (Premium истёк / битый ID) — фото с plain-клавиатурой
  if (hasIcons && plainMarkup) {
    const r4 = await sendPhoto(startPhotoUrl(), plainCaption, plainMarkup)
    if (r4.ok) {
      await saveFileId(r4)
      return { ok: true, via: 'photo' }
    }
  }

  // 5) Совсем без картинки: текстовое сообщение с тем же текстом и кнопками
  const t = await botSendRich(chatId, captionHtml, { ...opts, skipPremiumWrap: true })
  return t.ok
    ? { ok: true, via: 'text' }
    : { ok: false, via: 'text', error: t.error ?? r3.description ?? r2.description }
}
