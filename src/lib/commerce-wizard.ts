import { db } from '@/lib/db'
import { botSendRich } from '@/lib/tg-emoji'
import { escapeHtml, getBotChatRights, getChatInfo } from '@/lib/tg-bot'
import { botBroadcastAudience } from '@/lib/bot-audience'
import { plategaCreatePayment, plategaEnabled, plategaStatusInfo, PLATEGA_METHOD } from '@/lib/platega'
import { botChatIdOfUser } from '@/lib/bot-notify'
import { AutoModError, AUTOMOD_REJECT_MESSAGE, guardAdContent } from '@/services/autoMod'
import type { BotButton } from '@/lib/tg-buttons'

/**
 * КОММЕРЧЕСКИЕ ФЛОУ БОТА (v5.98): /sponsor · /ad · /send + меню /help · /tickets · /promo.
 *
 *  • /sponsor — сторонний админ пересылает пост из своего канала → бот проверяет,
 *    что он админит канал И наш бот добавлен туда админом с правом публикации →
 *    авто-модерация (services/autoMod.ts) → оплата фикса 990 ₽ (Platega) или
 *    эквива в Stars → канал привязывается к активному розыгрышу (Sponsor.ACTIVE).
 *  • /ad — инлайн-календарь на 14 дней → слот 12:00 или 18:00 МСК (строго ≤2
 *    поста в сутки) → текст/картинка → авто-модерация → оплата → AdSlot.PAID →
 *    крон (lib/ad-slots.ts) публикует в @SnapTeamDev по runAt.
 *  • /send — рассылка создателей (OWNER): чанки 30 сообщений/сек, HTML.
 *
 * Состояния диалогов — BotSetting `fsm:<chatId>` (JSON, TTL 30 мин), тот же
 * паттерн, что у мастера розыгрышей (gwwizard:).
 *
 * ВСЕ сообщения — Telegram HTML (parse_mode:'HTML'), как просил владелец.
 */

export const SPONSOR_PRICE_KOP = 99_000 // фикс 990 ₽
export const AD_PRICE_KOP = 99_000 // фикс 990 ₽ за слот
/** Курс Stars: 1 Star = 1 ₽ (тот же, что в пополнениях кошелька) */
export const STARS_PER_RUB = 1
/** Канал публикации рекламных слотов */
export const AD_CHANNEL = process.env.ADS_CHANNEL?.trim().replace(/^@/, '') || 'SnapTeamDev'

const FSM_KEY_PREFIX = 'fsm:'
const FSM_TTL_MS = 30 * 60_000
const APP_URL = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, '') || 'https://tg-swipe.vercel.app'

export type TgUserLite = { id: number; username?: string; first_name?: string }

type FsmState = {
  kind: 'sponsor' | 'ad' | 'send'
  step: string
  data: Record<string, unknown>
  exp: number
}

async function fsmGet(chatId: number): Promise<FsmState | null> {
  const row = await db.botSetting.findUnique({ where: { key: `${FSM_KEY_PREFIX}${chatId}` } }).catch(() => null)
  if (!row) return null
  try {
    const s = JSON.parse(row.value) as FsmState
    if (!s?.kind || (s.exp && s.exp < Date.now())) return null
    return s
  } catch {
    return null
  }
}

async function fsmSet(chatId: number, kind: FsmState['kind'], step: string, data: Record<string, unknown> = {}): Promise<void> {
  const value = JSON.stringify({ kind, step, data, exp: Date.now() + FSM_TTL_MS } satisfies FsmState)
  await db.botSetting
    .upsert({ where: { key: `${FSM_KEY_PREFIX}${chatId}` }, create: { key: `${FSM_KEY_PREFIX}${chatId}`, value }, update: { value } })
    .catch(() => {})
}

async function fsmClear(chatId: number): Promise<void> {
  await db.botSetting.deleteMany({ where: { key: `${FSM_KEY_PREFIX}${chatId}` } }).catch(() => {})
}

/** Прямой вызов Bot API (без премиум-обвязки): инвойсы, sendPhoto контента, рассылка */
async function tgApi<T = unknown>(method: string, body: Record<string, unknown>): Promise<{ ok: boolean; result?: T; description?: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  if (!token) return { ok: false, description: 'TELEGRAM_BOT_TOKEN не задан' }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    const data = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null
    if (data?.ok) return { ok: true, result: data.result }
    return { ok: false, description: data?.description ?? `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, description: String((e as Error)?.message ?? e) }
  }
}

/* ------------------------------- Время МСК ------------------------------- */

const MSK_OFFSET_MS = 3 * 3_600_000 // UTC+3, без перехода на летнее время

/** Сегодняшняя дата МСК в формате YYYY-MM-DD */
export function mskToday(): string {
  return new Date(Date.now() + MSK_OFFSET_MS).toISOString().slice(0, 10)
}

/** Точный UTC-инстант слота: календарный день МСК + '12:00'/'18:00' МСК */
export function slotRunAt(dateIso: string, slotTime: string): Date {
  return new Date(`${dateIso}T${slotTime}:00+03:00`)
}

/** Занят ли слот (любая живая заявка: ожидает оплаты / оплачен / опубликован) */
async function slotTaken(dateIso: string, slotTime: string): Promise<boolean> {
  const n = await db.adSlot.count({
    where: { targetDate: new Date(`${dateIso}T00:00:00.000Z`), slotTime, status: { in: ['PENDING', 'PAID', 'PUBLISHED'] } },
  }).catch(() => 0)
  return n > 0
}

/* ------------------------------ /help · меню ------------------------------ */

export async function sendHelpMenu(chatId: number, isOwner: boolean): Promise<void> {
  const rows: string[] = [
    '⚡️ <b>Tg Swipe — шпаргалка</b>',
    '',
    '👤 <b>Для Пользователей</b>',
    '📖 Открыть ленту — кнопка ниже или /start',
    '🎟 <b>/tickets</b> — розыгрыш: 4 задания для фарма билетов',
    '🎁 <b>/promo</b> — ввод секретного промокода (шифр с картинки в канале)',
    '😀 <b>/emojis</b> — библиотека премиум-эмодзи',
    '',
    '📣 <b>Для Рекламодателей</b>',
    '🤝 <b>/sponsor</b> — спонсорство розыгрыша: 990 ₽, твой канал в заданиях всех участников',
    '📅 <b>/ad</b> — слот в рекламном календаре: 12:00 или 18:00 МСК, 990 ₽, автопубликация',
    '',
    '⚠️ <b>Безопасность</b>',
    'Все заявки проходят автоматический фильтр Snap Team: казино, ставки, схемы заработка, сливы и крипта-«обучение» отклоняются мгновенно, автор уходит в чёрный список навсегда.',
  ]
  if (isOwner) {
    rows.push(
      '',
      '🛠 <b>Для Админов</b>',
      '/newgw — мастер розыгрыша · /mygw — моя карточка',
      '📣 <b>/send</b> — рассылка по всей базе',
    )
  }
  rows.push('', '📖 <a href="' + APP_URL + '">Открыть Tg Swipe</a>')
  await botSendRich(chatId, rows.join('\n'), {
    keyboard: [[
      { label: 'Открыть Tg Swipe', emoji: '🚀', url: APP_URL, style: 'primary' },
    ]],
  })
}

/* --------------------------- /promo · подсказка --------------------------- */

export async function sendPromoHint(chatId: number): Promise<void> {
  await botSendRich(
    chatId,
    [
      '🎁 <b>Промокод</b>',
      '',
      'Секретный код зашит текстом прямо на картинке в нашем канале — так его не вытащат боты-копипасты.',
      '',
      '1️⃣ Смотри пост с картинкой в канале',
      '2️⃣ Читаешь код глазами',
      '3️⃣ Просто присылаешь его сюда одним сообщением — всё засчитается само.',
    ].join('\n'),
    {
      keyboard: [[
        { label: 'Наш канал', emoji: '📢', url: `https://t.me/${AD_CHANNEL}`, style: 'primary' },
      ]],
    },
  )
}

/* ------------------------------ /tickets · статусы ------------------------------ */

export async function sendTicketsStatus(chatId: number, userId: string): Promise<void> {
  const gws = await db.giveaway
    .findMany({
      where: { status: 'active', endAt: { gt: new Date() } },
      orderBy: { endAt: 'asc' },
      take: 3,
      select: { id: true, title: true, endAt: true, tasks: true },
    })
    .catch(() => [])
  if (gws.length === 0) {
    await botSendRich(chatId, '🎟 Активных розыгрышей сейчас нет — загляни позже: как только запустим, билетные задания появятся здесь и в Mini App.')
    return
  }
  for (const gw of gws) {
    const entry = await db.giveawayEntry.findUnique({
      where: { giveawayId_userId: { giveawayId: gw.id, userId } },
      select: { ticketsCount: true, tasksDone: true },
    }).catch(() => null)
    let tasks: Array<{ kind: string; enabled: boolean; tickets: number }> = []
    try {
      tasks = JSON.parse(gw.tasks || '[]')
    } catch {}
    const done = new Set(
      (() => {
        try {
          return (JSON.parse(entry?.tasksDone || '[]') as Array<{ task: string }>).map((t) => t.task)
        } catch {
          return []
        }
      })(),
    )
    const titles: Record<string, string> = {
      activity: '🫀 Активность в ленте',
      promo: '🔑 Секретный промокод',
      referral: '🤝 Привести друзей',
      boost: '🚀 Буст канала',
      forward: '📨 Источники рекомендаций',
      sponsor: '🤝 Подписка на спонсоров',
    }
    const lines = tasks
      .filter((t) => t.enabled)
      .map((t) => `${done.has(t.kind) ? '✅' : '▫️'} ${titles[t.kind] ?? t.kind} — +${t.tickets} 🎫`)
    const left = Math.max(0, Math.ceil((gw.endAt.getTime() - Date.now()) / 3_600_000))
    await botSendRich(
      chatId,
      [
        `🎟 <b>${escapeHtml(gw.title)}</b>`,
        `⏳ До финала: ~${left} ч`,
        '',
        `Твои билеты: <b>${entry?.ticketsCount ?? 0}</b>`,
        '',
        '<b>Как фармить билеты:</b>',
        ...(lines.length > 0 ? lines : ['▫️ Задания появятся в Mini App']),
      ].join('\n'),
      {
        keyboard: [[
          { label: 'Открыть розыгрыш', emoji: '🎉', url: APP_URL, style: 'success' },
        ]],
      },
    )
  }
}

/* ------------------------------- /sponsor ------------------------------- */

export async function startSponsorFlow(chatId: number, user: TgUserLite): Promise<void> {
  await fsmSet(chatId, 'sponsor', 'wait_forward', { tgId: user.id })
  await botSendRich(
    chatId,
    [
      '🤝 <b>Спонсорство розыгрыша — 990 ₽</b>',
      '',
      'Что получает твой канал:',
      '▪️ обязательное задание «Подписка на спонсоров» у ВСЕХ участников розыгрыша',
      '▪️ посты канала крутятся в спонсорском блоке ленты',
      '',
      '<b>Как подключиться:</b>',
      '1️⃣ Добавь нашего бота админом в свой канал (право «Публикация сообщений»)',
      '2️⃣ Перешли сюда любой пост из своего канала',
      '3️⃣ Оплати — и канал сразу в игре',
      '',
      '⚠️ Заявки проходит авто-фильтр Snap Team: казино, ставки, схемы заработка и сливы отклоняются навсегда.',
    ].join('\n'),
  )
}

/** Пересланный пост в диалоге /sponsor — извлекаем канал и проверяем бота-админа */
async function handleSponsorForward(chatId: number, user: TgUserLite, fwd: { username?: string; title?: string }): Promise<boolean> {
  const username = (fwd.username ?? '').replace(/^@/, '')
  if (!username) {
    await fsmClear(chatId)
    await botSendRich(chatId, '❌ Это пересылка из приватного канала — у него нет @username, спонсорство оформить нельзя. Перешли пост из канала с публичной ссылкой.')
    return true
  }
  const rights = await getBotChatRights(username, { fresh: true }).catch(() => null)
  if (!rights?.isAdmin || !rights.canPost) {
    const botName = (await getBotUsernameCached()) ?? 'бот'
    await fsmClear(chatId)
    await botSendRich(
      chatId,
      [
        `❌ Бот <b>@${escapeHtml(botName)}</b> — не админ канала @${escapeHtml(username)} (или без права публикации).`,
        '',
        'Добавь бота админом с правом «Публикация сообщений» и начни заново: /sponsor',
      ].join('\n'),
    )
    return true
  }
  const info = await getChatInfo(username).catch(() => null)
  try {
    // Авто-модерация username/названия/описания канала ДО создания инвойса
    await guardAdContent(user.id, [username, info?.title, info?.description], `tg_${user.id}`)
  } catch (e) {
    if (e instanceof AutoModError) {
      await fsmClear(chatId)
      await botSendRich(chatId, AUTOMOD_REJECT_MESSAGE)
      return true
    }
    throw e
  }
  await fsmSet(chatId, 'sponsor', 'offer', { username, title: info?.title ?? fwd.title ?? username })
  await sendPaymentOffer(chatId, 'sponsor', `@${escapeHtml(username)}`, `spay:`)
  return true
}

/* --------------------------------- /ad --------------------------------- */

export async function startAdFlow(chatId: number): Promise<void> {
  await botSendRich(
    chatId,
    [
      '📅 <b>Рекламный календарь — 990 ₽ за слот</b>',
      '',
      '▪️ Два слота в сутки: <b>12:00</b> и <b>18:00</b> МСК — больше двух постов в день не бывает, канал не спамится',
      '▪️ Выбираешь дату и слот → присылаешь текст и картинку → оплата → пост выходит сам',
      '',
      '⚠️ Текст проходит авто-фильтр Snap Team: казино, ставки, схемы заработка, сливы — отказ и чёрный список навсегда.',
      '',
      'Выбери дату 👇',
    ].join('\n'),
    { keyboard: await adCalendarKeyboard() },
  )
}

async function adCalendarKeyboard(): Promise<BotButton[][]> {
  const today = mskToday()
  const start = new Date(`${today}T00:00:00.000Z`).getTime()
  const takenCache = await db.adSlot
    .findMany({
      where: { targetDate: { gte: new Date(`${today}T00:00:00.000Z`), lt: new Date(start + 15 * 86_400_000) }, status: { in: ['PENDING', 'PAID', 'PUBLISHED'] } },
      select: { targetDate: true, slotTime: true },
    })
    .catch(() => [])
  const taken = new Set(takenCache.map((s) => `${s.targetDate.toISOString().slice(0, 10)}|${s.slotTime}`))

  const days: BotButton[][] = []
  const monthNames = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
  for (let w = 0; w < 5; w++) {
    const row: BotButton[] = []
    for (let d = 0; d < 3; d++) {
      const idx = w * 3 + d
      if (idx >= 15) break
      const dayIso = new Date(start + idx * 86_400_000).toISOString().slice(0, 10)
      const dayDate = new Date(start + idx * 86_400_000 + MSK_OFFSET_MS)
      const label = `${dayDate.getUTCDate()} ${monthNames[dayDate.getUTCMonth()]}`
      const full = taken.has(`${dayIso}|12:00`) && taken.has(`${dayIso}|18:00`)
      row.push({
        label: full ? `${label} ✖` : label,
        emoji: full ? '🚫' : '📅',
        callback_data: `adcal:${dayIso}`,
        style: 'primary',
      })
    }
    if (row.length > 0) days.push(row)
  }
  return days
}

async function sendSlotsForDate(chatId: number, dateIso: string): Promise<void> {
  const [noonFree, eveningFree] = await Promise.all([slotTaken(dateIso, '12:00'), slotTaken(dateIso, '18:00')])
  const pretty = new Date(`${dateIso}T00:00:00.000Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' })
  await botSendRich(
    chatId,
    [
      `📅 <b>${escapeHtml(pretty)}</b> — выбери слот:`,
      '',
      `${noonFree ? '✖️ 12:00 МСК — занято' : '🟢 12:00 МСК — свободно'}`,
      `${eveningFree ? '✖️ 18:00 МСК — занято' : '🟢 18:00 МСК — свободно'}`,
    ].join('\n'),
    {
      keyboard: [
        [
          { label: '12:00 МСК', emoji: noonFree ? '🚫' : '🌞', callback_data: `adslot:${dateIso}:12:00`, style: noonFree ? 'danger' : 'success' },
          { label: '18:00 МСК', emoji: eveningFree ? '🚫' : '🌙', callback_data: `adslot:${dateIso}:18:00`, style: eveningFree ? 'danger' : 'success' },
        ],
        [{ label: 'К другой дате', emoji: '↩️', callback_data: 'adcal:back', style: 'primary' }],
      ],
    },
  )
}

/* ------------------------ /send · рассылка создателей ------------------------ */

export async function startSendFlow(chatId: number): Promise<void> {
  await fsmSet(chatId, 'send', 'wait_text')
  await botSendRich(
    chatId,
    [
      '📣 <b>Рассылка по всей базе</b>',
      '',
      'Пришли текст поста одним сообщением (HTML не нужен — экранирую сам, эмодзи можно).',
      'Потом спросим ссылку для кнопки.',
    ].join('\n'),
  )
}

/* ------------------------ Текстовые шаги FSM ------------------------ */

/**
 * Текст в диалоге FSM. Возвращает true — сообщение поглощено диалогом.
 * Вызывается в webhook ДО мастера розыгрышей и промокода.
 */
export async function handleFsmText(msg: { text?: string; caption?: string; photo?: unknown[] }, chatId: number, user: TgUserLite): Promise<boolean> {
  const st = await fsmGet(chatId)
  if (!st) return false
  const text = msg.text ?? msg.caption ?? ''

  // --- /send: текст поста ---
  if (st.kind === 'send' && st.step === 'wait_text') {
    if (!text) return true
    await fsmSet(chatId, 'send', 'wait_link', { text })
    await botSendRich(chatId, '🔗 Теперь пришли <b>ссылку для кнопки</b> под постом — или «-», если кнопка не нужна.')
    return true
  }
  if (st.kind === 'send' && st.step === 'wait_link') {
    const link = text.trim() === '-' ? '' : text.trim()
    if (link && !/^https?:\/\/\S+$/i.test(link)) {
      await botSendRich(chatId, '❌ Это не похоже на ссылку (нужно http(s)://…). Пришли ещё раз или «-», чтобы обойтись без кнопки.')
      return true
    }
    await fsmSet(chatId, 'send', 'confirm', { ...st.data, link })
    const preview = escapeHtml(String(st.data.text ?? '')).slice(0, 1200)
    await botSendRich(
      chatId,
      [
        '📤 <b>Предпросмотр рассылки</b>',
        '',
        preview,
        '',
        `👥 Получателей: <b>${(await botBroadcastAudience()).ids.length}</b>`,
        link ? `🔗 Кнопка: ${escapeHtml(link)}` : '🔗 Без кнопки',
        '',
        'Запускаем? Идёт пачками по 30 сообщений в секунду.',
      ].join('\n'),
      {
        keyboard: [
          [
            { label: 'Запустить', emoji: '🚀', callback_data: 'sendgo:1', style: 'danger' },
            { label: 'Отмена', emoji: '🗑', callback_data: 'sendgo:0', style: 'primary' },
          ],
        ],
      },
    )
    return true
  }

  // --- /ad: контент слота (текст без картинки) ---
  if (st.kind === 'ad' && st.step === 'wait_content') {
    if (msg.photo?.length) return false // фото уйдёт в handleFsmPhoto
    if (!text) {
      await botSendRich(chatId, '✍️ Пришли текст поста сообщением (или картинку с подписью).')
      return true
    }
    await createAdSlotAndOffer(chatId, user, st, text, null)
    return true
  }

  // --- /sponsor: ждём форвард, а пишут текстом ---
  if (st.kind === 'sponsor' && st.step === 'wait_forward') {
    await botSendRich(chatId, '📨 Жду <b>пересланный пост из твоего канала</b> — просто перешли любое сообщение оттуда.')
    return true
  }

  return false
}

/**
 * Фото (с подписью или без) в диалоге FSM: контент рекламного слота.
 * Возвращает true — сообщение поглощено.
 */
export async function handleFsmPhoto(msg: { photo?: Array<{ file_id?: string }>; caption?: string }, chatId: number, user: TgUserLite): Promise<boolean> {
  const st = await fsmGet(chatId)
  if (!st) return false
  if (st.kind === 'ad' && st.step === 'wait_content') {
    const fileId = msg.photo?.length ? msg.photo[msg.photo.length - 1]?.file_id : undefined
    if (!fileId) return true
    let imageUrl: string | null = null
    try {
      const { resolveTelegramFileUrl } = await import('@/lib/tg-bot')
      imageUrl = await resolveTelegramFileUrl(fileId)
    } catch {}
    if (!imageUrl) {
      await botSendRich(chatId, '❌ Не смог скачать картинку. Попробуй другую или пришли текст без фото.')
      return true
    }
    await createAdSlotAndOffer(chatId, user, st, msg.caption ?? '', imageUrl)
    return true
  }
  return false
}

/**
 * Пересланное сообщение в диалоге FSM: шаг «форвард канала» у /sponsor.
 * Возвращает true — сообщение поглощено. Вызывается ДО общего обработчика
 * источников рекомендаций (v5.50), который тоже съедает пересылки.
 */
export async function handleFsmForward(msg: { forward_from_chat?: { username?: string; title?: string; type?: string } }, chatId: number, user: TgUserLite): Promise<boolean> {
  const st = await fsmGet(chatId)
  if (!st) return false
  if (st.kind === 'sponsor' && st.step === 'wait_forward') {
    const fc = msg.forward_from_chat
    return handleSponsorForward(chatId, user, { username: fc?.username, title: fc?.title })
  }
  return false
}

/* ------------------- Создание слота + оффер оплаты ------------------- */

async function createAdSlotAndOffer(
  chatId: number,
  user: TgUserLite,
  st: FsmState,
  text: string,
  imageUrl: string | null,
): Promise<void> {
  const dateIso = String(st.data.date ?? '')
  const slotTime = String(st.data.slot ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso) || !['12:00', '18:00'].includes(slotTime)) {
    await fsmClear(chatId)
    await botSendRich(chatId, '⌛️ Сессия устарела — начни заново: /ad')
    return
  }
  if (await slotTaken(dateIso, slotTime)) {
    await fsmClear(chatId)
    await botSendRich(chatId, '⚡️ Кто-то успел раньше — слот только что заняли. Загляни в календарь: /ad')
    return
  }
  try {
    // Авто-модерация текста ДО создания инвойса
    await guardAdContent(user.id, [text], `tg_${user.id}`)
  } catch (e) {
    if (e instanceof AutoModError) {
      await fsmClear(chatId)
      await botSendRich(chatId, AUTOMOD_REJECT_MESSAGE)
      return
    }
    throw e
  }
  if (!text.trim() && !imageUrl) {
    await botSendRich(chatId, '✍️ Нужен хотя бы текст или картинка — пришли ещё раз.')
    return
  }
  const slot = await db.adSlot.create({
    data: {
      userId: `tg_${user.id}`,
      text: text.slice(0, 3500),
      imageUrl,
      targetDate: new Date(`${dateIso}T00:00:00.000Z`),
      slotTime,
      runAt: slotRunAt(dateIso, slotTime),
      priceKop: AD_PRICE_KOP,
      currency: 'RUB',
      status: 'PENDING',
    },
    select: { id: true },
  })
  await fsmClear(chatId)
  const pretty = new Date(`${dateIso}T00:00:00.000Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' })
  await botSendRich(
    chatId,
    [
      '🧾 <b>Заявка на слот создана</b>',
      '',
      `📅 ${escapeHtml(pretty)}, <b>${slotTime} МСК</b>`,
      imageUrl ? '🖼 Картинка: есть' : '🖼 Картинка: нет',
      `💰 К оплате: <b>990 ₽</b> (или эквив в Stars)`,
      '',
      'После оплаты слот закрепляется — крон опубликует пост сам, без напоминаний.',
    ].join('\n'),
    { keyboard: paymentKeyboard(`adpay:${slot.id}`, `adchk:${slot.id}`) },
  )
}

/* --------------------------- Оплата (Stars/Platega) --------------------------- */

function paymentKeyboard(prefix: string, checkCallback: string): BotButton[][] {
  const rows: BotButton[][] = [
    [
      { label: '⭐️ Stars (990)', emoji: '⭐️', callback_data: `${prefix}:stars`, style: 'primary' },
    ],
  ]
  if (plategaEnabled()) {
    rows.push([{ label: '💳 Рубли — СБП/карта', emoji: '💳', callback_data: `${prefix}:rub`, style: 'success' }])
  }
  return rows
}

async function sendPaymentOffer(chatId: number, kind: 'sponsor' | 'ad', subject: string, prefix: string): Promise<void> {
  const checkCallback = kind === 'sponsor' ? 'spchk' : 'adchk'
  await botSendRich(
    chatId,
    [
      kind === 'sponsor' ? `🤝 <b>Канал ${subject}</b> прошёл авто-фильтр — можно оплачивать:` : `🧾 Слот <b>${subject}</b> готов к оплате:`,
      '',
      '⭐️ <b>Stars</b> — нативная оплата Telegram',
      '💳 <b>Рубли</b> — СБП/карта через Platega',
    ].join('\n'),
    { keyboard: paymentKeyboard(prefix, checkCallback) },
  )
}

/**
 * Колбэк оплаты: создаёт PendingPayment (+ Sponsor/AdSlot-привязку) и выдаёт счёт.
 * Stars — инвойс через createInvoiceLink (нативный Telegram), рубли — Platega (СБП).
 * Формат: spay:<stars|rub> · adpay:<slotId>:<kind>
 */
async function handlePayCallback(cqId: string, chatId: number, user: TgUserLite, prefix: 'spay' | 'adpay', rest: string): Promise<void> {
  const reply = async (text?: string, alert?: boolean) => {
    await tgApi('answerCallbackQuery', { callback_query_id: cqId, ...(text ? { text, show_alert: alert === true } : {}) })
  }
  const [target, kindRaw] = rest.split(':')
  const kind = kindRaw === 'stars' || kindRaw === 'rub' ? kindRaw : ''
  if (!kind) {
    await reply()
    return
  }

  const priceKop = SPONSOR_PRICE_KOP
  const starsAmount = Math.round(priceKop / 100) * STARS_PER_RUB

  /* ---------- Спонсор: FSM держит username канала ---------- */
  if (prefix === 'spay') {
    const st = await fsmGet(chatId)
    if (st?.kind !== 'sponsor' || !st.data.username) {
      await reply('Сессия устарела — начни заново: /sponsor', true)
      return
    }
    const username = String(st.data.username)
    const title = st.data.title ? String(st.data.title) : null
    const activeGw = await db.giveaway.findFirst({ where: { status: 'active' }, orderBy: { endAt: 'asc' }, select: { id: true } })
    const payment = await db.pendingPayment.create({
      data: {
        userId: `tg_${user.id}`,
        amountKop: priceKop,
        provider: kind === 'stars' ? 'stars' : 'platega',
        purpose: 'sponsor',
      },
      select: { id: true },
    })
    const sponsor = await db.sponsor.create({
      data: {
        userId: `tg_${user.id}`,
        username,
        title,
        paidAmountKop: priceKop,
        currency: kind === 'stars' ? 'XTR' : 'RUB',
        status: 'PENDING',
        giveawayId: activeGw?.id ?? null,
        paymentId: payment.id,
      },
      select: { id: true },
    })
    if (kind === 'stars') {
      const payload = `sponsor:${user.id}:${payment.id}`
      await db.pendingPayment.update({ where: { id: payment.id }, data: { providerPaymentId: payload } })
      const inv = await tgApi<string>('createInvoiceLink', {
        title: 'Спонсорство 990 ₽',
        description: `Канал @${username.slice(0, 60)} — задание «Подписка на спонсоров» у всех участников`,
        payload,
        currency: 'XTR',
        prices: [{ label: 'Спонсорство', amount: starsAmount }],
      })
      if (!inv.ok || !inv.result) {
        await reply('Telegram не выдал счёт — попробуй ещё раз', true)
        return
      }
      await reply()
      await fsmClear(chatId)
      await botSendRich(chatId, `⭐️ Счёт на <b>990 Stars</b> для канала @${escapeHtml(username)} готов — жми кнопку:`, {
        keyboard: [[{ label: 'Оплатить Stars', emoji: '⭐️', url: inv.result, style: 'primary' }]],
      })
      return
    }
    // Рубли (Platega) — общая ветка ниже, но FSM чистим и помним sponsorId
    const created = await plategaCreatePayment({
      amountKop: priceKop,
      paymentId: payment.id,
      description: 'Спонсорство розыгрыша — Tg Swipe (Snap Team)',
      method: PLATEGA_METHOD.SBP,
    })
    if (!created) {
      await db.pendingPayment.updateMany({ where: { id: payment.id, status: 'pending' }, data: { status: 'canceled' } })
      await db.sponsor.delete({ where: { id: sponsor.id } }).catch(() => {})
      await reply('Платёжный провайдер недоступен — попробуй позже или оплати Stars', true)
      return
    }
    await db.pendingPayment.update({ where: { id: payment.id }, data: { providerPaymentId: created.transactionId } })
    await reply()
    await fsmClear(chatId)
    await botSendRich(chatId, `💳 Счёт на <b>990 ₽</b> для канала @${escapeHtml(username)} создан (СБП/карта). После оплаты статус обновится сам:`, {
      keyboard: [
        [{ label: 'Оплатить 990 ₽', emoji: '💳', url: created.redirect, style: 'success' }],
        [{ label: 'Проверить оплату', emoji: '🔄', callback_data: `spchk:${sponsor.id}`, style: 'primary' }],
      ],
    })
    return
  }

  /* ---------- Слот рекламы ---------- */
  if (!/^[a-z0-9]{16,32}$/i.test(target)) {
    await reply('Битая заявка', true)
    return
  }
  const slot = await db.adSlot.findUnique({ where: { id: target }, select: { id: true, status: true, userId: true } })
  if (!slot || slot.userId !== `tg_${user.id}`) {
    await reply('Заявка не найдена', true)
    return
  }
  if (slot.status !== 'PENDING') {
    await reply('Слот уже оплачен ✅', true)
    return
  }

  if (kind === 'stars') {
    const payment = await db.pendingPayment.create({
      data: { userId: `tg_${user.id}`, amountKop: priceKop, provider: 'stars', purpose: `adslot:${slot.id}` },
      select: { id: true },
    })
    await db.adSlot.update({ where: { id: slot.id }, data: { paymentId: payment.id, currency: 'XTR' } })
    const payload = `adslot:${user.id}:${slot.id}:${payment.id}`
    await db.pendingPayment.update({ where: { id: payment.id }, data: { providerPaymentId: payload } })
    const inv = await tgApi<string>('createInvoiceLink', {
      title: 'Рекламный слот 990 ₽',
      description: 'Публикация в календаре Tg Swipe (12:00/18:00 МСК)',
      payload,
      currency: 'XTR',
      prices: [{ label: 'Слот рекламы', amount: starsAmount }],
    })
    if (!inv.ok || !inv.result) {
      await reply('Telegram не выдал счёт — попробуй ещё раз', true)
      return
    }
    await reply()
    await botSendRich(chatId, '⭐️ Счёт на <b>990 Stars</b> готов — жми кнопку:', {
      keyboard: [[{ label: 'Оплатить Stars', emoji: '⭐️', url: inv.result, style: 'primary' }]],
    })
    return
  }

  // Рубли (Platega) для слота
  const payment = await db.pendingPayment.create({
    data: { userId: `tg_${user.id}`, amountKop: priceKop, provider: 'platega', purpose: `adslot:${slot.id}` },
    select: { id: true },
  })
  await db.adSlot.update({ where: { id: slot.id }, data: { paymentId: payment.id, currency: 'RUB' } })
  const created = await plategaCreatePayment({
    amountKop: priceKop,
    paymentId: payment.id,
    description: 'Рекламный слот — Tg Swipe (Snap Team)',
    method: PLATEGA_METHOD.SBP,
  })
  if (!created) {
    await db.pendingPayment.updateMany({ where: { id: payment.id, status: 'pending' }, data: { status: 'canceled' } })
    await reply('Платёжный провайдер недоступен — попробуй позже или оплати Stars', true)
    return
  }
  await db.pendingPayment.update({ where: { id: payment.id }, data: { providerPaymentId: created.transactionId } })
  await reply()
  await botSendRich(chatId, '💳 Счёт на <b>990 ₽</b> создан (СБП/карта). После оплаты слот закрепляется:', {
    keyboard: [
      [{ label: 'Оплатить 990 ₽', emoji: '💳', url: created.redirect, style: 'success' }],
      [{ label: 'Проверить оплату', emoji: '🔄', callback_data: `adchk:${slot.id}`, style: 'primary' }],
    ],
  })
}

/** Ручная проверка статуса Platega (запасной путь к вебхуку) */
async function handleCheckCallback(cqId: string, chatId: number, prefix: 'spchk' | 'adchk', id: string): Promise<void> {
  const reply = async (text?: string, alert?: boolean) => {
    await tgApi('answerCallbackQuery', { callback_query_id: cqId, ...(text ? { text, show_alert: alert === true } : {}) })
  }
  if (!/^[a-z0-9]{16,32}$/i.test(id)) return reply()
  const row = prefix === 'spchk'
    ? await db.sponsor.findUnique({ where: { id }, select: { status: true, paymentId: true } })
    : await db.adSlot.findUnique({ where: { id }, select: { status: true, paymentId: true } })
  if (!row) return reply('Заявка не найдена', true)
  if (row.status === 'ACTIVE' || row.status === 'PAID' || row.status === 'PUBLISHED') {
    await reply('✅ Оплата прошла — всё активно!', true)
    return
  }
  const paymentId = row.paymentId
  if (!paymentId) return reply('Оплата ещё не начата', true)
  const payment = await db.pendingPayment.findUnique({ where: { id: paymentId }, select: { status: true, providerPaymentId: true, provider: true } })
  if (!payment) return reply('Счёт не найден', true)
  if (payment.status === 'succeeded') {
    await reply('✅ Оплата прошла — всё активно!', true)
    return
  }
  if (payment.provider !== 'platega' || !payment.providerPaymentId) {
    await reply('Платёж ещё не оплачен', true)
    return
  }
  const info = await plategaStatusInfo(payment.providerPaymentId)
  if (info.status === 'CONFIRMED') {
    const { creditPendingPayment } = await import('@/lib/payments')
    const ok = await creditPendingPayment(paymentId, payment.providerPaymentId).catch(() => false)
    if (ok) {
      await notifyCommercePaid(`tg_${await chatOwnerOf(chatId)}`, prefix === 'spchk' ? 'sponsor' : 'adslot')
      await reply('✅ Оплата подтверждена — всё активно!', true)
      return
    }
  }
  await reply(`Статус: ${info.status === 'PENDING' ? 'ожидает оплаты' : info.status}`, true)
}

async function chatOwnerOf(chatId: number): Promise<string> {
  // chatId приватного чата = числовой Telegram ID владельца
  return String(chatId)
}

/** Сообщение об успехе оплаты (Stars-вебхук, Platega-вебхук, ручная проверка) */
export async function notifyCommercePaid(userId: string, purpose: 'sponsor' | 'adslot'): Promise<void> {
  const chatId = await botChatIdOfUser(userId).catch(() => null)
  if (!chatId) return
  if (purpose === 'sponsor') {
    await botSendRich(
      chatId,
      [
        '✅ <b>Спонсорство оплачено</b>',
        '',
        'Твой канал привязан к активному розыгрышу: у всех участников появилось задание «Подписка на спонсоров».',
        'Посты канала уже крутятся в спонсорском блоке ленты.',
      ].join('\n'),
    )
  } else {
    await botSendRich(
      chatId,
      [
        '✅ <b>Слот оплачен</b>',
        '',
        `Пост выйдет в канале @${AD_CHANNEL} в выбранное время — 12:00 или 18:00 МСК. Ничего делать не нужно.`,
      ].join('\n'),
    )
  }
}

/* --------------------------- Роутер колбэков --------------------------- */

/**
 * Колбэки коммерческих флоу. Возвращает true — апдейт обработан.
 * Форматы: spay:<stars|rub> · adpay:<slotId>:<kind> · adcal:<date|back> ·
 * adslot:<date>:<time> · spchk:<id> · adchk:<id> · sendgo:<1|0>
 */
export async function handleCommerceCallback(cqId: string, data: string, chatId: number, user: TgUserLite): Promise<boolean> {
  const reply = async (text?: string, alert?: boolean) => {
    await tgApi('answerCallbackQuery', { callback_query_id: cqId, ...(text ? { text, show_alert: alert === true } : {}) })
  }
  if (data.startsWith('spay:')) {
    await handlePayCallback(cqId, chatId, user, 'spay', data.slice('spay:'.length))
    return true
  }
  if (data.startsWith('adpay:')) {
    await handlePayCallback(cqId, chatId, user, 'adpay', data.slice('adpay:'.length))
    return true
  }
  if (data.startsWith('spchk:')) {
    await handleCheckCallback(cqId, chatId, 'spchk', data.slice('spchk:'.length))
    return true
  }
  if (data.startsWith('adchk:')) {
    await handleCheckCallback(cqId, chatId, 'adchk', data.slice('adchk:'.length))
    return true
  }
  if (data.startsWith('adcal:')) {
    const v = data.slice('adcal:'.length)
    if (v === 'back') {
      await reply()
      await startAdFlow(chatId)
      return true
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      await reply()
      return true
    }
    await reply()
    await sendSlotsForDate(chatId, v)
    return true
  }
  if (data.startsWith('adslot:')) {
    // adslot:<date>:<time>
    const rest = data.slice('adslot:'.length)
    const m = rest.match(/^(\d{4}-\d{2}-\d{2}):(12:00|18:00)$/)
    if (!m) {
    await reply()
    return true
  }
    if (await slotTaken(m[1], m[2])) {
      await reply('Слот только что заняли — выбери другой', true)
      await sendSlotsForDate(chatId, m[1])
      return true
    }
    await reply()
    await fsmSet(chatId, 'ad', 'wait_content', { date: m[1], slot: m[2] })
    await botSendRich(
      chatId,
      [
        '✍️ <b>Контент слота</b>',
        '',
        'Пришли текст поста сообщением — или картинку с подписью (она и будет постом).',
        '',
        '⚠️ Текст идёт через авто-фильтр Snap Team. Отменить: /ad заново.',
      ].join('\n'),
    )
    return true
  }
  if (data.startsWith('sendgo:')) {
    const v = data.slice('sendgo:'.length)
    const st = await fsmGet(chatId)
    if (st?.kind !== 'send' || st.step !== 'confirm') {
      await reply('Сессия устарела', true)
      return true
    }
    if (v !== '1') {
      await fsmClear(chatId)
      await reply('Отменено')
      return true
    }
    await reply('Запускаю рассылку…')
    await fsmClear(chatId)
    void runBroadcast(chatId, String(st.data.text ?? ''), st.data.link ? String(st.data.link) : '').catch((e) =>
      console.error('[commerce] broadcast', e),
    )
    return true
  }
  return false
}

/* ------------------------------ Рассылка /send ------------------------------ */

/**
 * Массовая рассылка: пачки по 30 сообщений/сек (ниже лимита Telegram 30 msg/s
 * на чат не упираемся — лимит общий на бота; 30/с безопасно при паузе 1с).
 * 429 → пауза retry_after и продолжение.
 */
async function runBroadcast(ownerChatId: number, text: string, link: string): Promise<void> {
  // v6.6: вся аудитория ЛС — юзеры миниаппа ∪ бот-юзеры (BotUser/botlang),
  // забаненные миниаппа исключены. До этого шлём только юзерам миниаппа.
  const audience = await botBroadcastAudience()
  const html = escapeHtml(text).slice(0, 3500)
  const markup = link
    ? { inline_keyboard: [[{ text: '👉 Открыть', url: link }]] }
    : undefined
  let sent = 0
  let failed = 0
  const chatIds = audience.ids
    .map((id) => Number(id))
    .filter((n) => Number.isInteger(n) && n > 0)

  for (let i = 0; i < chatIds.length; i += 30) {
    const chunk = chatIds.slice(i, i + 30)
    const results = await Promise.all(
      chunk.map((cid) =>
        tgApi('sendMessage', {
          chat_id: cid,
          text: html,
          parse_mode: 'HTML',
          disable_web_page_preview: false,
          ...(markup ? { reply_markup: markup } : {}),
        }),
      ),
    )
    for (const r of results) {
      if (r.ok) sent++
      else failed++
    }
    // 429 в пачке — уважим retry_after, чтобы не продлевать бан
    const retry = results.find((r) => /retry after (\d+)/i.exec(r.description ?? ''))
    if (retry) {
      const sec = Number(/retry after (\d+)/i.exec(retry.description ?? '')?.[1] ?? 3)
      await new Promise((res) => setTimeout(res, Math.min(sec + 1, 30) * 1000))
    } else {
      await new Promise((res) => setTimeout(res, 1000))
    }
  }
  await botSendRich(
    ownerChatId,
    [`📣 <b>Рассылка завершена</b>`, '', `✅ Доставлено: <b>${sent}</b>`, `❌ Ошибок: <b>${failed}</b>`].join('\n'),
  )
}

/* --------------------------- Бот-юзернейм (кэш) --------------------------- */

let botUsernameCache: { name: string; exp: number } | null = null
async function getBotUsernameCached(): Promise<string | null> {
  if (botUsernameCache && botUsernameCache.exp > Date.now()) return botUsernameCache.name
  const me = await tgApi<{ username?: string }>('getMe', {})
  if (me.ok && me.result?.username) {
    botUsernameCache = { name: me.result.username, exp: Date.now() + 10 * 60_000 }
    return me.result.username
  }
  return null
}
