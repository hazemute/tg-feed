import { randomInt } from 'crypto'
import { db } from '@/lib/db'
import { botBanned, markBotBan, escapeHtml as escTg, isTelegramMember } from '@/lib/tg-bot'
import { premiumText, stripTgEmoji, premiumMap } from '@/lib/tg-emoji'
import { buildPlainKeyboard, type BotButton } from '@/lib/tg-buttons'
import { fmtRub, SWP_PER_RUB } from '@/lib/wallet'
import { tierExpiryFor } from '@/lib/tiers'
import { invalidateBalance } from '@/lib/balance-cache'
import { cacheIncr, cacheExpire, cacheSet } from '@/lib/redis'
import {
  parseTasks,
  pickWinnersWeighted,
  plural,
  taskTitle,
  invalidateActiveCache,
} from '@/lib/giveaway-tickets'
import { sendBotNotification } from '@/lib/bot-notify'
import { emitAppEvent } from '@/lib/events'

/**
 * РОЗЫГРЫШИ (v5.40) — полноценная система конкурсов:
 *
 *  1. Админ собирает розыгрыш в панели (призы, каналы, время, кнопка) →
 *     «Опубликовать» → бот публикует пост в канал с цветной кнопкой
 *     «Участвовать 🎉 (N)» (style + icon_custom_emoji_id — Bot API v5.29).
 *  2. Клик по кнопке → вебхук gw:join:<id> → бот за долю секунды проверяет
 *     подписки (getChatMember) → заявка принята / список каналов для подписки.
 *  3. Счётчик на кнопке обновляется В РЕАЛЬНОМ ВРЕМЕНИ: каждая новая заявка
 *     перерисовывает кнопку через editMessageReplyMarkup (флуд-агрегация).
 *  4. В endAt — финализация: крипто-RNG выбирает победителей, призы
 *     зачисляются автоматически (свайпы/рубли/тариф), в канал уходит
 *     красивый пост со списком счастливчиков.
 *
 * Финализация ленивая: checkDueGiveaways() вызывается из вебхука (троттлинг
 * через Redis), из панели и из daily-cron — розыгрыш никогда не «забудется».
 */

/** Канал публикации по умолчанию (наш канал) */
export const GIVEAWAY_CHANNEL_KEY = 'giveaway_channel'
export const DEFAULT_GIVEAWAY_CHANNEL = '@SnapTeamDev'

export type PrizeKind = 'swipes' | 'rub' | 'tier' | 'custom'

export type Prize = {
  kind: PrizeKind
  /** swipes: сколько свайпов; rub: копейки; tier: 'plus'|'pro'; custom: 0 */
  amount: number
  /** для tier: период (дней) — 0 = бессрочно/до ручного отзыва */
  periodDays?: number
  /** сколько мест (победителей) на этот приз */
  winners: number
  /** человекочитаемое название («1 000 свайпов», «Snap Pro на месяц») */
  label: string
}

export type GiveawayWinner = {
  userId: string
  name: string
  tgId?: string
  prizeIndex: number
}

type TgChat = { id: number | string; title?: string }

const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN?.trim() ?? ''

/** Вызов Bot API с результатом (для sendMessage/editMessageReplyMarkup розыгрышей) */
async function tgCall<T = unknown>(
  method: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; result?: T; description?: string }> {
  if (!BOT_TOKEN()) return { ok: false, description: 'TELEGRAM_BOT_TOKEN не задан' }
  if (botBanned()) return { ok: false, description: 'Bot API на паузе после 429' }
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean
      result?: T
      description?: string
      parameters?: { retry_after?: number }
    } | null
    if (res.status === 429) {
      const retry = Number(data?.parameters?.retry_after ?? 30)
      void markBotBan(Number.isFinite(retry) && retry > 0 ? retry : 30)
    }
    if (data?.ok) return { ok: true, result: data.result }
    return { ok: false, description: data?.description ?? `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, description: String((e as Error)?.message ?? e) }
  }
}

/* ------------------------------ призы ------------------------------ */

export function parsePrizes(json: string | null | undefined): Prize[] {
  try {
    const v = JSON.parse(json || '[]') as unknown
    if (!Array.isArray(v)) return []
    return v.filter(
      (p): p is Prize =>
        !!p && typeof p === 'object' &&
        typeof (p as Prize).kind === 'string' &&
        typeof (p as Prize).amount === 'number' &&
        typeof (p as Prize).winners === 'number' && (p as Prize).winners > 0,
    )
  } catch {
    return []
  }
}

export function parseChannels(json: string | null | undefined): string[] {
  try {
    const v = JSON.parse(json || '[]') as unknown
    if (!Array.isArray(v)) return []
    return v
      .filter((c): c is string => typeof c === 'string')
      .map((c) => c.trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '').replace(/\/+$/, ''))
      .filter(Boolean)
  } catch {
    return []
  }
}

export function parseWinners(json: string | null | undefined): GiveawayWinner[] {
  try {
    const v = JSON.parse(json || '[]') as unknown
    return Array.isArray(v) ? (v as GiveawayWinner[]) : []
  } catch {
    return []
  }
}

export function prizesLabel(prizes: Prize[]): string {
  const out: string[] = []
  let place = 0
  for (const p of prizes) {
    for (let i = 0; i < p.winners; i++) {
      place++
      out.push(`${place}. ${p.label}`)
    }
  }
  return out.join('\n')
}

export function totalWinners(prizes: Prize[]): number {
  return prizes.reduce((a, p) => a + Math.max(1, p.winners), 0)
}

/** Человекочитаемое описание приза по умолчанию (конструктор подставляет сам) */
export function prizeAutoLabel(p: { kind: PrizeKind; amount: number; periodDays?: number }): string {
  switch (p.kind) {
    case 'swipes':
      return `${p.amount.toLocaleString('ru-RU')} свайпов`
    case 'rub':
      return fmtRub(p.amount)
    case 'tier':
      return p.amount >= 2
        ? 'Snap Pro'
        : 'Snap Plus'
    case 'custom':
      return 'сюрприз от команды'
  }
}

/* ------------------------------ пост розыгрыша ------------------------------ */

const PLURAL = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

function fmtEndAt(endAt: Date): string {
  const d = new Date(endAt.getTime() + 3 * 3600_000) // МСК для читаемости в посте
  const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} в ${hh}:${mm} МСК`
}

/**
 * Текст поста розыгрыша (HTML для Bot API): премиум-эмодзи оборачиваются
 * premiumText'ом, призы и условия — из карточки. channels — какие каналы
 * обязательны (список в посте с @ссылками).
 */
export function giveawayPostHtml(g: {
  title: string
  text: string
  prizes: string
  channels: string
  endAt: Date
  tasks?: string
  losersRewardSwipes?: number
}): string {
  const prizes = parsePrizes(g.prizes)
  const channels = parseChannels(g.channels)
  const tasks = parseTasks(g.tasks).filter((t) => t.enabled)
  const lines: string[] = []
  lines.push(`🎉 <b>${escTg(g.title)}</b>`)
  lines.push('')
  if (g.text.trim()) {
    // markdown-lite постов → упрощённый HTML: **b** → <b>, __i__ → <i>
    const t = g.text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/__([^_\n]+)__/g, '<i>$1</i>')
    lines.push(t)
    lines.push('')
  }
  lines.push('🎁 <b>Призы:</b>')
  lines.push(prizesLabel(prizes) || '—')
  lines.push('')
  if (tasks.length > 0) {
    // v5.46: билетные задания — чем больше билетов, тем выше шанс
    lines.push('🎫 <b>Как получить билеты (шанс = кол-во билетов):</b>')
    for (const t of tasks) {
      lines.push(`  • ${escTg(taskTitle(t))} — <b>+${t.tickets} ${plural(t.tickets, 'билет', 'билета', 'билетов')}</b>`)
    }
    lines.push('')
    lines.push('📖 Задания выполняются в Mini App или в боте: /mygw')
    lines.push('')
  }
  if (channels.length > 0) {
    lines.push('✅ <b>Условие:</b> быть подписанным на ' + channels.map((c) => `@${escTg(c)}`).join(', '))
    lines.push('')
  }
  if (g.losersRewardSwipes && g.losersRewardSwipes > 0) {
    lines.push(`💜 Проигравшим участникам — утешительные <b>${g.losersRewardSwipes} свайпов</b> на баланс`)
    lines.push('')
  }
  lines.push(`⏰ <b>Итоги:</b> ${fmtEndAt(g.endAt)}`)
  const total = totalWinners(prizes)
  if (total > 1) lines.push(`🏆 Победителей: <b>${total}</b> — честный взвешенный рандом`)
  return lines.join('\n')
}

/** Кнопка «Участвовать (N)»: премиум-иконка + цвет; N = заявок сейчас */
export function giveawayKeyboard(
  g: { id: string; buttonStyle: string; buttonEmoji: string; buttonEmojiId: string },
  count: number,
): BotButton[][] {
  const style = (['primary', 'success', 'danger'].includes(g.buttonStyle) ? g.buttonStyle : 'primary') as
    | 'primary'
    | 'success'
    | 'danger'
  const label = `Участвовать (${count})`
  // emoji — ключ слота премиум-иконки (если premiumMap знает этот юникод) и
  // юникод-префикс в plain-фолбэке; custom_emoji_id из карточки приоритетнее слота
  return [
    [
      {
        label,
        emoji: g.buttonEmoji || '🎉',
        callback_data: `gw:join:${g.id}`,
        style,
        ...(g.buttonEmojiId ? { customEmojiId: g.buttonEmojiId } : {}),
      } as BotButton & { customEmojiId?: string },
    ],
  ]
}

/** Расширенная сборка клавиатуры с явным custom_emoji_id иконки кнопки */
function keyboardMarkup(
  rows: BotButton[][],
  premiumMap: Map<string, string>,
): { icon: ReturnType<typeof buildPlainKeyboard> | undefined; plain: ReturnType<typeof buildPlainKeyboard> } {
  const iconRows = rows.map((row) =>
    row.map((b) => {
      const custom = (b as BotButton & { customEmojiId?: string }).customEmojiId
      const slotId = b.emoji ? premiumMap.get(b.emoji) : undefined
      const id = custom || slotId
      return {
        text: id ? b.label : [b.emoji, b.label].filter(Boolean).join(' '),
        ...(id ? { icon_custom_emoji_id: id } : {}),
        ...(b.style ? { style: b.style } : {}),
        ...(b.url ? { url: b.url } : {}),
        ...(b.callback_data ? { callback_data: b.callback_data } : {}),
      }
    }),
  )
  return {
    icon: { inline_keyboard: iconRows },
    plain: buildPlainKeyboard(rows),
  }
}

/* ------------------------------ публикация ------------------------------ */

async function botChannelId(): Promise<string> {
  const row = await db.botSetting.findUnique({ where: { key: GIVEAWAY_CHANNEL_KEY } }).catch(() => null)
  return row?.value?.trim() || DEFAULT_GIVEAWAY_CHANNEL
}
/**
 * Опубликовать пост розыгрыша от имени бота в канале. Возвращает chatId/messageId.
 * Бот должен быть админом канала с правом публикации (как и для ИИ-публикаций).
 * v5.46: если есть photoFileId — пост уходит КАК ФОТО (sendPhoto с caption ≤ 1024),
 * при отказе Telegram — фолбэк на текстовый пост.
 */
export async function publishGiveawayPost(g: {
  id: string
  title: string
  text: string
  prizes: string
  channels: string
  buttonStyle: string
  buttonEmoji: string
  buttonEmojiId: string
  endAt: Date
  tasks?: string
  losersRewardSwipes?: number
  photoFileId?: string | null
}): Promise<{ ok: boolean; chatId?: string; messageId?: number; error?: string }> {
  if (botBanned()) return { ok: false, error: 'Bot API на паузе после 429' }
  const chat = await botChannelId()
  const fullHtml = await premiumText(giveawayPostHtml(g))
  const rows = giveawayKeyboard(g, 0)
  const markup = keyboardMarkup(rows, await premiumMap())
  const htmlSkip = stripTgEmoji(fullHtml)

  // caption у sendPhoto ограничен 1024 символами (против 4096 у текста)
  const capFull = await premiumText(giveawayPostHtml(g).slice(0, 1000))
  const capSkip = stripTgEmoji(capFull)

  const photo = g.photoFileId?.trim()
  // 1) фото с caption → 2) текст с иконками → 3) plain-текст, иконки → 4) всё plain
  const attempts: Array<{ method: string; payload: Record<string, unknown> }> = photo
    ? [
        { method: 'sendPhoto', payload: { chat_id: chat, photo, caption: capFull, parse_mode: 'HTML', reply_markup: markup.icon } },
        { method: 'sendPhoto', payload: { chat_id: chat, photo, caption: capSkip, parse_mode: 'HTML', reply_markup: markup.icon } },
        { method: 'sendPhoto', payload: { chat_id: chat, photo, caption: capSkip, parse_mode: 'HTML', reply_markup: markup.plain } },
        { method: 'sendMessage', payload: { chat_id: chat, text: htmlSkip, parse_mode: 'HTML', reply_markup: markup.plain } },
      ]
    : [
        { method: 'sendMessage', payload: { chat_id: chat, text: fullHtml, parse_mode: 'HTML', reply_markup: markup.icon } },
        { method: 'sendMessage', payload: { chat_id: chat, text: htmlSkip, parse_mode: 'HTML', reply_markup: markup.icon } },
        { method: 'sendMessage', payload: { chat_id: chat, text: htmlSkip, parse_mode: 'HTML', reply_markup: markup.plain } },
      ]
  let lastError = ''
  for (const a of attempts) {
    const r = await tgCall<{ message_id?: number; chat?: TgChat }>(a.method, a.payload)
    if (r.ok && r.result) {
      return {
        ok: true,
        chatId: String(r.result.chat?.id ?? chat),
        messageId: r.result.message_id,
      }
    }
    lastError = r.description ?? ''
    if (botBanned()) return { ok: false, error: 'Bot API на паузе после 429' }
  }
  return { ok: false, error: lastError || 'Telegram отклонил публикацию' }
}

/* ------------------------------ участие ------------------------------ */

export type JoinResult =
  | { ok: true; count: number; already?: boolean }
  | { ok: false; reason: 'ended' | 'not_active' | 'banned' | 'db'; message: string }
  | { ok: false; reason: 'need_subscribe'; message: string; channels: string[] }

/**
 * Клик «Участвовать»: проверяем активность, подписки → создаём заявку.
 * Все обязательные каналы проверяются getChatMember (бот-админ наших каналов;
 * для каналов спонсоров бот должен быть добавлен админом — иначе считаем
 * проверку пройденной, чтобы не блокировать участников по вине внешнего канала).
 */
export async function joinGiveaway(
  giveawayId: string,
  user: { id: string; tgId?: number; username?: string; firstName?: string },
): Promise<JoinResult> {
  const g = await db.giveaway.findUnique({ where: { id: giveawayId } })
  if (!g) return { ok: false, reason: 'not_active', message: 'Розыгрыш не найден' }
  if (g.status === 'finished' || g.status === 'cancelled' || g.status === 'draft') {
    return { ok: false, reason: 'not_active', message: 'Розыгрыш уже не активен' }
  }
  if (g.endAt.getTime() <= Date.now()) {
    return { ok: false, reason: 'ended', message: '⌛️ Приём заявок окончен — итоги вот-вот!' }
  }

  // Уже участвует — не дублируем, просто показываем счётчик
  const existing = await db.giveawayEntry.findUnique({
    where: { giveawayId_userId: { giveawayId, userId: user.id } },
  })
  if (existing) {
    const count = await db.giveawayEntry.count({ where: { giveawayId } })
    return { ok: true, count, already: true }
  }

  // Проверка подписок (максимум 5 каналов — лимит на один клик)
  const channels = parseChannels(g.channels).slice(0, 5)
  const notSubscribed: string[] = []
  for (const ch of channels) {
    const ok = user.tgId ? await isTelegramMember(ch, user.tgId) : true
    // null = бот не видит участников канала — не блокируем участника по вине внешнего канала
    if (ok === false) notSubscribed.push(ch)
    if (botBanned()) break
  }
  if (notSubscribed.length > 0) {
    return {
      ok: false,
      reason: 'need_subscribe',
      message:
        `🚫 Сначала подпишись на ${notSubscribed.length > 1 ? 'каналы' : 'канал'}: ` +
        notSubscribed.map((c) => `@${c}`).join(', ') +
        ' — и жми кнопку заново!',
      channels: notSubscribed,
    }
  }

  try {
    await db.giveawayEntry.create({
      data: {
        giveawayId,
        userId: user.id,
        tgId: user.tgId ? String(user.tgId) : null,
        username: user.username ?? null,
        firstName: user.firstName ?? null,
      },
    })
  } catch {
    // гонка даблклика: unique-violation → уже участвует
    const count = await db.giveawayEntry.count({ where: { giveawayId } })
    return { ok: true, count, already: true }
  }
  const count = await db.giveawayEntry.count({ where: { giveawayId } })
  return { ok: true, count }
}

// Подписки проверяет isTelegramMember (кэш 5 мин, null = нечем проверить — не блокируем)

/* ------------------ realtime-счётчик на кнопке ------------------ */

/**
 * Обновить «(N)» на кнопке поста. Вызывается после каждой заявки;
 * дребезг гасится Redis-счётчиком: не чаще раза в 2с на розыгрыш,
 * между апдейтами счётчик копится и уезжает следующим тиком.
 */
export async function refreshGiveawayButton(giveawayId: string, count: number): Promise<void> {
  const g = await db.giveaway.findUnique({
    where: { id: giveawayId },
    select: { chatId: true, messageId: true, buttonStyle: true, buttonEmoji: true, buttonEmojiId: true, status: true },
  })
  if (!g || !g.chatId || !g.messageId || g.status !== 'active') return

  const throttleKey = `gw:btn:${giveawayId}`
  const pending = await cacheIncr(throttleKey).catch(() => 1)
  if (pending === 1) await cacheExpire(throttleKey, 2).catch(() => {})
  if (pending > 1) {
    // уже есть тик в полёте — следующий апдейт подхватит свежий count
    await cacheSet(`gw:btn:pending:${giveawayId}`, count, 5).catch(() => {})
    return
  }

  const rows = giveawayKeyboard(
    { id: giveawayId, buttonStyle: g.buttonStyle, buttonEmoji: g.buttonEmoji, buttonEmojiId: g.buttonEmojiId },
    count,
  )
  const markup = keyboardMarkup(rows, await premiumMap())
  for (const m of [markup.icon, markup.plain]) {
    const r = await tgCall('editMessageReplyMarkup', {
      chat_id: g.chatId,
      message_id: g.messageId,
      ...(m ? { reply_markup: m } : {}),
    })
    if (r.ok) return
    if (botBanned()) return
  }
}

/* ------------------------------ финализация ------------------------------ */

/**
 * Выбрать победителей крипто-РНГ (Фишер–Йетс перемешивание, randomInt —
 * криптостойкий). Порядок призов: первый приз — первые места.
 */
export function pickWinners(entries: GiveawayWinner[], prizes: Prize[]): GiveawayWinner[] {
  const total = totalWinners(prizes)
  const pool = [...entries]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1)
    ;[pool[i], pool[j]] = [pool[j]!, pool[i]!]
  }
  const winners = pool.slice(0, total)
  // распределение по призам
  let idx = 0
  for (let pi = 0; pi < prizes.length && idx < winners.length; pi++) {
    for (let k = 0; k < prizes[pi]!.winners && idx < winners.length; k++) {
      winners[idx]!.prizeIndex = pi
      idx++
    }
  }
  return winners
}

/**
 * Начислить приз победителю. v5.54: ИДЕМПОТЕНТНО — маркер в BalanceLog:
 * перед начислением проверяем, не начислен ли уже этот приз этим юзеру
 * (защита от повторной выдачи при rescue-прогонах после сбоя процесса).
 * Возвращает true, если начисление выполнено именно сейчас.
 */
async function creditPrize(userId: string, prize: Prize, giveawayTitle: string, place: number): Promise<boolean> {
  const note = `Приз розыгрыша «${giveawayTitle}» — ${prize.label} (место ${place})`
  if (prize.kind === 'swipes' && prize.amount > 0) {
    // v5.54: дедуп смотрит и на старый формат note «Приз розыгрыша» —
    // чтобы rescue не пере-начислил призы, выданные до обновления
    const already = await db.balanceLog
      .findFirst({
        where: { userId, kind: 'admin', currency: 'swp', amount: prize.amount, OR: [{ note }, { note: 'Приз розыгрыша' }] },
        select: { id: true },
      })
      .catch(() => null)
    if (already) return false
    await db.user.update({
      where: { id: userId },
      data: { swipes: { increment: prize.amount } },
    })
    await db.balanceLog.create({
      data: { userId, kind: 'admin', currency: 'swp', amount: prize.amount, note },
    }).catch(() => {})
    await invalidateBalance(userId)
    return true
  }
  if (prize.kind === 'rub' && prize.amount > 0) {
    const already = await db.balanceLog
      .findFirst({
        where: { userId, kind: 'admin', currency: 'rub', amount: prize.amount, OR: [{ note }, { note: 'Приз розыгрыша' }] },
        select: { id: true },
      })
      .catch(() => null)
    if (already) return false
    await db.user.update({
      where: { id: userId },
      data: { balanceKop: { increment: prize.amount } },
    })
    await db.balanceLog.create({
      data: { userId, kind: 'admin', currency: 'rub', amount: prize.amount, note },
    }).catch(() => {})
    await invalidateBalance(userId)
    return true
  }
  if (prize.kind === 'tier') {
    // маркер-запись (currency 'swp', amount 0) — чтобы rescue-прогон не продлевал тариф повторно
    const already = await db.balanceLog
      .findFirst({ where: { userId, kind: 'admin', currency: 'swp', amount: 0, note }, select: { id: true } })
      .catch(() => null)
    if (already) return false
    const tier = prize.amount >= 2 ? 'pro' : 'plus'
    const u = await db.user.findUnique({ where: { id: userId }, select: { tierUntil: true } })
    const until =
      prize.periodDays && prize.periodDays > 0
        ? new Date(
            (u?.tierUntil && u.tierUntil.getTime() > Date.now() ? u.tierUntil.getTime() : Date.now()) +
              prize.periodDays * 86_400_000,
          )
        : tierExpiryFor(u?.tierUntil, 'month')
    await db.user.update({ where: { id: userId }, data: { tier, tierUntil: until } })
    await db.balanceLog
      .create({ data: { userId, kind: 'admin', currency: 'swp', amount: 0, note } })
      .catch(() => {})
    return true
  }
  // custom — ничего не начисляем, только объявляем
  return false
}

/** Пост с победителями: премиум-эмодзи, ссылки на профили, приз каждого места */
export function winnersPostHtml(g: {
  title: string
  prizes: string
  winnersJson: string | null
  entriesCount: number
}): string {
  const prizes = parsePrizes(g.prizes)
  const winners = parseWinners(g.winnersJson)
  const lines: string[] = []
  lines.push('🏆 <b>Итоги розыгрыша</b>')
  lines.push('')
  lines.push(`🎉 <b>${escTg(g.title)}</b>`)
  lines.push('')
  if (winners.length === 0) {
    lines.push('Никто не успел принять участие — в этот раз без победителей 😔')
  } else {
    const medals = ['🥇', '🥈', '🥉']
    winners.forEach((w, i) => {
      const medal = medals[i] ?? `🎖`
      const prize = prizes[w.prizeIndex]
      const name = escTg(w.name || 'участник')
      // v5.46: сколько билетов у победителя (если билетная система была)
      const tix = (w as GiveawayWinner & { tickets?: number }).tickets
      const tixLabel = typeof tix === 'number' && tix > 0 ? ` · ${tix} ${plural(tix, 'билет', 'билета', 'билетов')}` : ''
      const link = w.tgId ? `<a href="tg://user?id=${escTg(w.tgId)}">(${name}${tixLabel})</a>` : ` (${name}${tixLabel})`
      lines.push(`${medal} ${prize ? `<b>${escTg(prize.label)}</b> —${link}` : link}`)
    })
    lines.push('')
    lines.push(
      `🎲 Из ${g.entriesCount} ${PLURAL(g.entriesCount, 'заявки', 'заявок', 'заявок')} — честный взвешенный рандом: ` +
        'каждый билет = один бросок в генераторе. Призы уже на балансах победителей!',
    )
  }
  lines.push('')
  lines.push('💜 Спасибо всем за участие — новый розыгрыш не за горами!')
  return lines.join('\n')
}

/**
 * Финализировать ОДИН розыгрыш: взвешенный выбор по билетам, призы,
 * утешительные свайпы проигравшим, пост в канал, ЛС победителям/проигравшим.
 * v5.54: атомарный ЗАХВАТ финализации (статус → finished) выполняется ДО любых
 * начислений; начисления идемпотентны (маркеры в BalanceLog). Гонка тик × панель ×
 * вебхук раньше выбирала разных победителей и платила призы дважды; сбой процесса
 * посреди начислений теперь дочищается rescue-прогоном (см. checkDueGiveaways).
 */
export async function finalizeGiveaway(giveawayId: string): Promise<{ ok: boolean; error?: string; winners?: number }> {
  const g = await db.giveaway.findUnique({ where: { id: giveawayId } })
  if (!g) return { ok: false, error: 'не найден' }
  // полностью завершён (есть и победители, и пост) — ничего не делаем
  if (g.status === 'finished' && g.winnersMessageId) return { ok: true, winners: parseWinners(g.winners).length }
  if (g.status === 'draft' || g.status === 'scheduled') return { ok: false, error: 'ещё не опубликован' }

  const entries = await db.giveawayEntry.findMany({
    where: { giveawayId },
    select: { userId: true, tgId: true, username: true, firstName: true, ticketsCount: true },
  })

  // Погружаем имена из User (гость мог не иметь firstName в заявке)
  const userIds = [...new Set(entries.map((e) => e.userId))]
  const users = await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, firstName: true, username: true } })
  const userById = new Map(users.map((u) => [u.id, u]))

  const prizes = parsePrizes(g.prizes)
  const nameOf = (e: (typeof entries)[number]) =>
    e.firstName || userById.get(e.userId)?.firstName || (e.username ? `@${e.username}` : 'участник')

  let participants: GiveawayWinner[]
  const rescue = g.status === 'finished' && !!g.winners
  if (rescue) {
    // RESCUE: финализатор уже захватил розыгрыш, но оборвался до поста —
    // победители зафиксированы в winners JSON, дочищаем их начисления.
    participants = parseWinners(g.winners)
  } else {
    // v5.46: ЧЕСТНЫЙ ВЗВЕШЕННЫЙ РАНДОМ по билетам. В розыгрыше только те,
    // кто заработал хотя бы один билет (ticketsCount > 0).
    const seats = totalWinners(prizes)
    const weighted = pickWinnersWeighted(
      entries.map((e) => ({ userId: e.userId, tickets: e.ticketsCount })),
      seats,
    )
    const hasTickets = entries.some((e) => e.ticketsCount > 0)
    // Фолбэк для розыгрышей БЕЗ билетных заданий: равномерный shuffle по всем заявкам
    const winnersIds = new Set(hasTickets ? weighted.map((w) => w.userId) : pickUniform(entries, seats))
    const ticketsByUser = new Map(entries.map((e) => [e.userId, e.ticketsCount]))

    participants = entries
      .filter((e) => winnersIds.has(e.userId))
      .map((e) => ({
        userId: e.userId,
        name: nameOf(e),
        ...(e.tgId ? { tgId: e.tgId } : {}),
        prizeIndex: 0,
        ...(hasTickets ? { tickets: ticketsByUser.get(e.userId) ?? 0 } : {}),
      }))
    // Порядок мест: победители взвешенного выбора — по порядку выпадения; фолбэк — как вышел shuffle
    if (hasTickets) {
      let idx = 0
      for (const w of weighted) {
        if (idx >= participants.length) break
        const p = participants.find((x) => x.userId === w.userId)
        if (p) {
          participants.splice(idx, 1)
          participants.splice(idx, 0, p)
          idx++
        }
      }
    }
    // распределение по призам: первый приз — первые места
    let pidx = 0
    for (let pi = 0; pi < prizes.length && pidx < participants.length; pi++) {
      for (let k = 0; k < prizes[pi]!.winners && pidx < participants.length; k++) {
        participants[pidx]!.prizeIndex = pi
        pidx++
      }
    }

    // v5.54: АТОМАРНЫЙ ЗАХВАТ — статус → finished + фиксация победителей ДО начислений.
    // Проигравший гонку выходит сразу и НЕ начисляет (иначе — двойная выплата).
    const claim = await db.giveaway.updateMany({
      where: { id: g.id, status: { not: 'finished' } },
      data: { status: 'finished', winners: JSON.stringify(participants) },
    })
    if (claim.count === 0) {
      return { ok: true, winners: parseWinners(g.winners).length }
    }
    invalidateActiveCache()
  }

  // Начисление призов — идемпотентно (маркер в BalanceLog): rescue-прогон не задвоит.
  let creditedNow = false
  for (let i = 0; i < participants.length; i++) {
    const w = participants[i]!
    const prize = prizes[w.prizeIndex]
    if (!prize) continue
    const credited = await creditPrize(w.userId, prize, g.title, i + 1).catch((e) => {
      console.error('[giveaway] creditPrize', e)
      return false
    })
    if (credited) creditedNow = true
  }

  // v5.46: УТЕШИТЕЛЬНЫЕ СВАЙПЫ проигравшим участникам с билетами (ticketsCount > 0,
  // без победы) + ЛС-уведомление. Призёры с ticketsCount = 0 (кликнули и ушли без
  // единого билета) — не считаем участниками розыгрыша, ничего не начисляем.
  // v5.54: идемпотентно — начисляем только тем, у кого ещё нет записи в журнале.
  const winnersIds = new Set(participants.map((p) => p.userId))
  const loserReward = g.losersRewardSwipes ?? 0
  if (loserReward > 0) {
    const losers = entries.filter((e) => e.ticketsCount > 0 && !winnersIds.has(e.userId))
    if (losers.length > 0) {
      const loserNote = `Утешительный приз — розыгрыш «${g.title}»`
      const paid = await db.balanceLog
        .findMany({
          where: { userId: { in: losers.map((l) => l.userId) }, kind: 'admin', currency: 'swp', amount: loserReward, note: loserNote },
          select: { userId: true },
        })
        .catch(() => [] as Array<{ userId: string }>)
      const paidSet = new Set(paid.map((p) => p.userId))
      const pending = losers.filter((l) => !paidSet.has(l.userId))
      if (pending.length > 0) {
        await db.user.updateMany({
          where: { id: { in: pending.map((l) => l.userId) } },
          data: { swipes: { increment: loserReward } },
        })
        await db.balanceLog
          .createMany({
            data: pending.map((l) => ({
              userId: l.userId,
              kind: 'admin',
              currency: 'swp',
              amount: loserReward,
              note: loserNote,
            })),
          })
          .catch(() => {})
        await Promise.allSettled(pending.map((l) => invalidateBalance(l.userId)))
        creditedNow = true
        for (const l of pending) {
          // Инбокс + ЛС бота (очередь внутри sendBotNotification)
          await notifyLoser(l.userId, g.title, loserReward).catch(() => {})
        }
      }
    }
  }

  const winnersJson = JSON.stringify(participants)

  // Пост с победителями
  let winnersMessageId: number | null = null
  let chatId = g.chatId
  if (chatId && !botBanned()) {
    const html = await premiumText(winnersPostHtml({ title: g.title, prizes: g.prizes, winnersJson, entriesCount: entries.length }))
    for (const text of [html, stripTgEmoji(html)]) {
      const r = await tgCall<{ message_id?: number }>('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' })
      if (r.ok && r.result) {
        winnersMessageId = r.result.message_id ?? null
        break
      }
      if (botBanned()) break
    }
  }

  // v5.54: messageId пишется отдельно — статус/победители уже зафиксированы захватом;
  // наличие messageId = финализация полностью завершена (rescue больше не нужен).
  if (winnersMessageId) {
    await db.giveaway.update({ where: { id: g.id }, data: { winnersMessageId } }).catch(() => {})
  }

  // Спрятать кнопку участия в исходном посте (приём окончен)
  if (g.chatId && g.messageId && !botBanned()) {
    void tgCall('editMessageReplyMarkup', { chat_id: g.chatId, message_id: g.messageId, reply_markup: { inline_keyboard: [] } })
  }

  // ЛС победителям — только если что-то начисляли сейчас (rescue-прогон без
  // новых начислений не спамит повторными поздравлениями)
  if (participants.length > 0 && creditedNow) {
    for (const w of participants) {
      const prize = prizes[w.prizeIndex]
      notifyWinner(w.userId, g.title, prize?.label ?? 'приз')
    }
  }

  return { ok: true, winners: participants.length }
}

/** Равномерный фолбэк для розыгрышей без билетных заданий (Фишер–Йетс, randomInt) */
function pickUniform(entries: Array<{ userId: string }>, seats: number): string[] {
  const pool = [...entries]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1)
    ;[pool[i], pool[j]] = [pool[j]!, pool[i]!]
  }
  return pool.slice(0, seats).map((p) => p.userId)
}

/** ЛС + инбокс победителю (fire-and-forget, не роняет финализацию) */
async function notifyWinner(userId: string, title: string, prizeLabel: string): Promise<void> {
  try {
    await db.notification.create({
      data: {
        userId,
        type: 'system',
        title: '🏆 Ты победил в розыгрыше!',
        body: `«${title}» — приз: ${prizeLabel}. Уже на твоём балансе!`.slice(0, 200),
      },
    }).catch(() => {})
    emitAppEvent('notif:new', { userId })
    sendBotNotification({
      userId,
      type: 'system',
      title: '🏆 Ты победил в розыгрыше!',
      body: `«${title}» — твой приз: ${prizeLabel}. Проверь баланс в приложении! 🎉`,
    })
  } catch (e) {
    console.error('[giveaway] notifyWinner', e)
  }
}

/** ЛС + инбокс с утешительными свайпами (fire-and-forget) */
async function notifyLoser(userId: string, title: string, swipes: number): Promise<void> {
  try {
    await db.notification.create({
      data: {
        userId,
        type: 'system',
        title: '💜 Утешительный приз',
        body: `Розыгрыш «${title}»: +${swipes} свайпов уже на твоём балансе. В этот раз не повезло — впереди новые розыгрыши!`.slice(0, 200),
      },
    }).catch(() => {})
    emitAppEvent('notif:new', { userId })
    sendBotNotification({
      userId,
      type: 'system',
      title: '💜 Утешительный приз за участие',
      body: `Розыгрыш «${title}»: +${swipes} свайпов уже на твоём балансе. Удача любит упорных — участвуй снова!`,
    })
  } catch (e) {
    console.error('[giveaway] notifyLoser', e)
  }
}

/**
 * Ленивый планировщик: опубликовать запланированные (startAt <= now) и
 * завершить просроченные (endAt <= now). Вызывается из вебхука (троттлинг),
 * панели и daily-cron. Redis-лок от параллельных инстансов.
 */
export async function checkDueGiveaways(): Promise<{ published: number; finished: number }> {
  const now = new Date()
  let published = 0
  let finished = 0

  // 1) Запланированные → активные (публикация поста)
  const due = await db.giveaway.findMany({
    where: { status: { in: ['scheduled', 'active'] }, startAt: { lte: now }, endAt: { lte: now } },
    select: { id: true },
  })
  const expiredIds = due.map((d) => d.id)

  const toPublish = await db.giveaway.findMany({
    where: { status: 'scheduled', startAt: { lte: now }, id: { notIn: expiredIds } },
  })
  for (const g of toPublish) {
    if (g.endAt.getTime() <= now.getTime()) {
      // уже просрочен до публикации — просто активируем, финализация ниже
      await db.giveaway.updateMany({ where: { id: g.id, status: 'scheduled' }, data: { status: 'active' } })
      finished += await finishOne(g.id)
      continue
    }
    const r = await publishGiveawayPost(g)
    if (r.ok && r.chatId && r.messageId) {
      await db.giveaway.update({
        where: { id: g.id },
        data: { status: 'active', chatId: r.chatId, messageId: r.messageId },
      })
      published++
    } else {
      // публикация не прошла — оставляем scheduled (ретрай на следующем тике)
      console.error('[giveaway] publish failed', g.id, r.error)
    }
  }

  // 2) Активные с истёкшим endAt → финализация
  const active = await db.giveaway.findMany({
    where: { status: 'active', endAt: { lte: now } },
    select: { id: true },
  })
  for (const a of active) finished += await finishOne(a.id)
  for (const id of expiredIds) finished += await finishOne(id)

  // 3) v5.54: RESCUE — финализация захвачена (status finished, победители записаны),
  // но процесс оборвался до поста (messageId нет): дочищаем начисления/пост —
  // finalizeGiveaway идемпотентен, уже выданное не задвоит. Окно — сутки от endAt.
  const stuck = await db.giveaway
    .findMany({
      where: {
        status: 'finished',
        winners: { not: null },
        winnersMessageId: null,
        endAt: { gte: new Date(now.getTime() - 24 * 86_400_000) },
      },
      select: { id: true },
      take: 3,
    })
    .catch(() => [] as Array<{ id: string }>)
  for (const s of stuck) finished += await finishOne(s.id)

  return { published, finished }
}

async function finishOne(id: string): Promise<number> {
  const r = await finalizeGiveaway(id).catch((e) => {
    console.error('[giveaway] finalize', id, e)
    return { ok: false } as { ok: boolean; winners?: number }
  })
  return r.ok ? (r.winners ?? 0) : 0
}

/** Троттлинг вызова checkDueGiveaways из вебхука: не чаще раза в 30с */
export async function kickDueGiveaways(): Promise<void> {
  const n = await cacheIncr('gw:due_kick').catch(() => 1)
  if (n === 1) {
    await cacheExpire('gw:due_kick', 30).catch(() => {})
    void checkDueGiveaways().catch(() => {})
  }
}

/** Для панели: счётчик заявок */
export async function giveawayCount(giveawayId: string): Promise<number> {
  return db.giveawayEntry.count({ where: { giveawayId } })
}
