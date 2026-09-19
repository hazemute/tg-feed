import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { creditPendingPayment } from '@/lib/payments'
import {
  addCapturedEmoji,
  botSendPhotoRich,
  botSendRich,
  listCapturedEmoji,
  premiumMap,
  premiumText,
  setBusinessConnection,
} from '@/lib/tg-emoji'
import {
  buildIconKeyboard,
  buildPlainKeyboard,
  type BotButton,
} from '@/lib/tg-buttons'
import { externalOrigin } from '@/lib/server'
import { botBanned, markBotBan } from '@/lib/tg-bot'

export const dynamic = 'force-dynamic'

/**
 * Webhook Telegram Bot API — единственная точка приёма апдейтов бота.
 *
 * Обслуживает:
 *  • ВХОД НА САЙТ: /start login_<token> → кнопка «Войти» → callback_query
 *    login:<token> → снимок tg-пользователя в LoginAttempt, сайт подхватывает.
 *  • ОПЛАТУ TELEGRAM STARS: message.successful_payment (currency XTR) —
 *    инвойсы из POST /api/payments/stars. Свайпы зачисляются идемпотентно.
 *  • TELEGRAM BUSINESS (v5.22): update.business_connection — премиум-аккаунт
 *    владельца подключается к боту как посредник, чтобы бот отправлял
 *    кастом-эмодзи (см. src/lib/tg-emoji.ts).
 *
 * Регистрация: scripts/set-webhook.ts (URL + secret_token).
 * Если задан TELEGRAM_WEBHOOK_SECRET — проверяем заголовок
 * x-telegram-bot-api-secret-token (Telegram присылает secret_token из setWebhook).
 *
 * Харденинг (после секретной проверки, бизнес-логика не тронута):
 *  • секрет НЕ задан в env — warn в лог раз в 60с (дыра: вебхук принимает
 *    любого; реальный Telegram с secret_token при этом продолжает работать);
 *  • content-type строго application/json — иначе 415 (Telegram шлёт JSON);
 *  • content-length > 512KB — 413 (апдейты Telegram ≤ ~256KB, больше — мусор).
 */

const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN?.trim() ?? ''
/** Владелец бота (премиум-аккаунт-посредник): только его business-подключения принимаются */
const BOT_OWNER_TG_ID = 7851246214

/** Реальные апдейты Telegram максимум ~256KB — всё, что больше, мусор */
const WEBHOOK_MAX_BYTES = 512 * 1024
/** Антиспам предупреждений о незаданном секрете: не чаще раза в 60с */
const SECRET_WARN_INTERVAL_MS = 60_000
let lastSecretWarnAt = 0

/* ------------------- Самолечение allowed_updates ------------------- */

const HEAL_KEY = 'webhook_selfheal_v1'
let healChecked = false // in-memory: 1 раз на инстанс

/**
 * Если вебхук зарегистрирован СТАРОМ setWebhook (без business_connection в
 * allowed_updates), Telegram молча НЕ шлёт business_connection — и подключение
 * «секретаря» никогда не доедет. При первом же апдейте перерегистрируем вебхук
 * сами (тот же URL + secret, drop_pending_updates=false — ничего не теряем).
 */
async function healWebhookAllowedUpdates(request: Request): Promise<void> {
  try {
    const done = await db.botSetting.findUnique({ where: { key: HEAL_KEY } })
    if (done) return
    if (!BOT_TOKEN()) return
    const origin = process.env.NEXT_PUBLIC_APP_URL?.trim() || externalOrigin(request)
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim()
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `${origin}/api/bot/webhook`,
        ...(secret ? { secret_token: secret } : {}),
        allowed_updates: ['message', 'callback_query', 'business_connection'],
        max_connections: 40,
      }),
      signal: AbortSignal.timeout(8000),
    })
    const data = (await res.json().catch(() => null)) as { ok?: boolean } | null
    if (data?.ok) {
      const now = new Date().toISOString()
      await db.botSetting
        .upsert({ where: { key: HEAL_KEY }, create: { key: HEAL_KEY, value: now }, update: { value: now } })
        .catch(() => {})
      console.log('[bot/webhook] allowed_updates self-healed: +business_connection')
    }
  } catch (e) {
    console.error('[bot/webhook] webhook self-heal failed (retry on next instance)', e)
  }
}

/* ------------------------- Типы апдейтов (минимум) ------------------------- */

type TgFrom = {
  id: number
  username?: string
  first_name?: string
  last_name?: string
  photo_url?: string
  is_premium?: boolean
  language_code?: string
}

type TgEntity = {
  type?: string
  offset?: number
  length?: number
  custom_emoji_id?: string
}

type TgUpdate = {
  update_id?: number
  message?: {
    chat?: { id?: number }
    from?: TgFrom
    text?: string
    /** Entities текста: здесь прилетает type='custom_emoji' с custom_emoji_id —
     *  так бот узнаёт ID премиум-эмодзи из сообщений пользователей */
    entities?: TgEntity[]
    caption?: string
    caption_entities?: TgEntity[]
    successful_payment?: {
      currency?: string
      total_amount?: number
      invoice_payload?: string
      telegram_payment_charge_id?: string
    }
  }
  callback_query?: {
    id: string
    data?: string
    from?: TgFrom
    message?: { chat?: { id?: number }; message_id?: number }
  }
  business_connection?: {
    id?: string
    user?: { id?: number; is_premium?: boolean }
    is_enabled?: boolean
  }
}

/* --------------------------- Вызовы Bot API --------------------------- */

type InlineButton = { text: string; callback_data?: string; url?: string }

async function botCall<T = unknown>(
  method: string,
  payload: Record<string, unknown>,
): Promise<T | null> {
  if (!BOT_TOKEN()) return null
  // Флуд-бан: не тратим вызовы (каждый вызов под баном продлевает наказание)
  if (botBanned()) return null
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    })
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean
      result?: T
      parameters?: { retry_after?: number }
    } | null
    // 429: ставим глобальную паузу (tg-bot.ts) — ретраи и фолбэки замолкают
    if (res.status === 429) {
      const retry = Number(data?.parameters?.retry_after ?? 30)
      void markBotBan(Number.isFinite(retry) && retry > 0 ? retry : 30)
    }
    return data?.ok ? (data.result ?? null) : null
  } catch {
    return null
  }
}

function snapshotOf(from: TgFrom | undefined): string | null {
  if (!from || typeof from.id !== 'number' || from.id <= 0) return null
  return JSON.stringify({
    id: from.id,
    username: from.username,
    first_name: from.first_name,
    last_name: from.last_name,
    photo_url: from.photo_url,
    is_premium: from.is_premium,
    language_code: from.language_code,
  })
}

function nameOf(from: TgFrom | undefined): string {
  return (from?.first_name || from?.username || 'друг').slice(0, 64)
}

const SITE_URL = 'https://tg-swipe.vercel.app'
/** t.me deep link на мини-апп бота — открывает ленту прямо в Telegram */
const TME_APP_URL = 'https://t.me/tgswipe_bot/tgswipe'

/* ------------------------------ Обработчики ------------------------------ */

/** /start login_<token> — прислать сообщение с кнопкой «Войти» */
async function handleStartLogin(token: string, from: TgFrom | undefined, chatId?: number) {
  if (!chatId) return
  const attempt = await db.loginAttempt.findUnique({ where: { id: token } }).catch(() => null)
  const valid =
    attempt && attempt.status === 'pending' && attempt.expiresAt.getTime() > Date.now()

  if (!valid) {
    await botSendRich(
      chatId,
      [
        '⚠️ <b>Ссылка для входа устарела</b>',
        '',
        'Она действует 15 минут — так безопаснее.',
        '',
        '✨ Просто начни вход заново: открой Tg Swipe и нажми «Вход по Telegram» — новая ссылка придёт в тот же момент.',
      ].join('\n'),
    )
    return
  }

  await botSendRich(
    chatId,
    [
      `🔐 <b>Подтверждение входа</b>`,
      '',
      `Привет, ${escapeHtml(nameOf(from))}! Ты запрашиваешь вход в <b>Tg Swipe</b>.`,
      '',
      '✅ Одно нажатие кнопки ниже — и в приложении откроются:',
      '  • твой профиль и подписки',
      '  • сохранённые посты',
      '  • баланс и продвижение канала',
      '',
      '🛡 Пароли не нужны — всё подтверждается твоим Telegram.',
    ].join('\n'),
    {
      keyboard: [
        // Иконка ✅ из слота + зелёная кнопка (style: success, Bot API v5.29)
        [{ label: 'Это я, войти', emoji: '✅', callback_data: `login:${token}`, style: 'success' }],
        [{ label: 'Открыть Tg Swipe', emoji: '🌐', url: SITE_URL }],
      ] satisfies BotButton[][],
    },
  )
}

/** Приветственный /start — КАРТИНКА + премиум-подпись + кнопки */
async function handleStart(from: TgFrom | undefined, chatId?: number) {
  if (!chatId) return
  const name = escapeHtml(nameOf(from))
  await botSendPhotoRich(
    chatId,
    [
      `👋 <b>Привет, ${name}!</b>`,
      '',
      'Это <b>Tg Swipe</b> — умная лента Telegram.',
      '',
      '⚡ <b>Свайпай</b> — лента подстраивается под твои интересы',
      '📖 <b>Читай</b> любые каналы без подписок',
      '🚀 <b>Продвигай</b> свой канал в топ ленты',
      '',
      '✨ Подпишись на наш канал — новости, обновления и фишки — первыми:',
    ].join('\n'),
    {
      keyboard: [
        [{ label: 'Подписаться на канал', emoji: '✨', url: 'https://t.me/SnapTeamDev' }],
        [{ label: 'Открыть Tg Swipe', emoji: '📖', url: TME_APP_URL, style: 'primary' }],
      ] satisfies BotButton[][],
    },
  )
}

/* ------------------ Приём custom_emoji от пользователей ------------------ */

/**
 * Entity custom_emoji: offset/length в UTF-16 code units — JS slice нативно совпадает.
 * Возвращает пары custom_emoji_id → юникод-эмодзи (фолбэк из текста сообщения).
 */
function extractCustomEmoji(
  text: string | undefined,
  entities: TgEntity[] | undefined,
): Array<{ id: string; emoji: string }> {
  if (!text || !entities?.length) return []
  const out: Array<{ id: string; emoji: string }> = []
  const seen = new Set<string>()
  for (const e of entities) {
    if (e.type !== 'custom_emoji' || !e.custom_emoji_id) continue
    // offset/length — UTF-16 code units; отрицательный offset уводит slice
    // в конец строки и захватывает НЕ ТОТ символ — отсекаем
    if (
      typeof e.offset !== 'number' ||
      typeof e.length !== 'number' ||
      e.length <= 0 ||
      e.offset < 0
    )
      continue
    const emoji = text.slice(e.offset, e.offset + e.length)
    if (!emoji || seen.has(e.custom_emoji_id)) continue
    seen.add(e.custom_emoji_id)
    out.push({ id: e.custom_emoji_id, emoji })
  }
  return out
}

/**
 * Любое сообщение юзера с премиум-эмодзи: ID складываются в БД (панель → Бот),
 * владельцу бот отвечает списком ID — ОФИЦИАЛЬНЫЙ способ узнать custom_emoji_id
 * (вместо сторонних ботов). Остальным юзерам бот не отвечает — молча копит библиотеку.
 */
async function handleCustomEmojiCapture(msg: NonNullable<TgUpdate['message']>): Promise<void> {
  const found = [
    ...extractCustomEmoji(msg.text, msg.entities),
    ...extractCustomEmoji(msg.caption, msg.caption_entities),
  ]
  if (found.length === 0) return

  const fromId = msg.from?.id ?? 0
  const fromName = (msg.from?.first_name || msg.from?.username || 'user').slice(0, 64)
  const at = new Date().toISOString()
  await addCapturedEmoji(
    found.map((f) => ({ id: f.id, emoji: f.emoji, fromId, fromName, at })),
  ).catch(() => {})

  // Ответ только владельцу — юзеров не тревожим
  if (fromId === BOT_OWNER_TG_ID && msg.chat?.id) {
    const lines = found
      .map((f) => `${f.emoji} → <code>${escapeHtml(f.id)}</code>`)
      .join('\n')
    await botSendRich(
      msg.chat.id,
      [
        `📌 ${found.length > 1 ? `Захвачено ${found.length} ID` : 'Захвачен custom_emoji_id'}:`,
        '',
        lines,
        '',
        '────────────',
        'Куда вставить: панель → Бот → «Захваченные» → «В слот».',
        'Текущие слоты: /emojis',
      ].join('\n'),
    ).catch(() => {})
  }
}

/** /emojis — текущая конфигурация слотов + последние захваченные (для владельца) */
async function handleEmojisCommand(from: TgFrom | undefined, chatId?: number) {
  if (!chatId) return
  if (from?.id !== BOT_OWNER_TG_ID) {
    await botCall('sendMessage', {
      chat_id: chatId,
      text: '⚙️ Настройка эмодзи доступна только владельцу бота.',
    })
    return
  }
  const rows = await db.botEmoji.findMany({ orderBy: { slot: 'asc' } }).catch(() => [])
  const slotLines = rows.map(
    (r) => `${r.emoji} <code>${escapeHtml(r.slot)}</code> → ${
      r.customEmojiId ? `<code>${escapeHtml(r.customEmojiId)}</code>` : '—'
    }`,
  )
  const captured = (await listCapturedEmoji().catch(() => [])).slice(0, 12)
  const capLines = captured.map(
    (c) => `${c.emoji} <code>${escapeHtml(c.id)}</code> · ${escapeHtml(c.fromName)} · ${c.at.slice(0, 10)}`,
  )
  const filled = rows.filter((r) => r.customEmojiId).length
  await botSendRich(
    chatId,
    [
      `⚙️ <b>Слоты премиум-эмодзи</b> — ${filled}/${rows.length} заполнено`,
      '',
      ...(slotLines.length > 0 ? slotLines : ['—']),
      '',
      '────────────',
      `📌 <b>Захваченные из сообщений</b>${captured.length > 0 ? ':' : ' — пока пусто'}`,
      ...(capLines.length > 0 ? ['', ...capLines] : []),
    ].join('\n'),
  ).catch(() => {})
}

/** callback_query login:<token> — подтверждение входа */
async function handleLoginCallback(
  cbId: string,
  token: string,
  from: TgFrom | undefined,
  msgChatId?: number,
  msgId?: number,
) {
  const snap = snapshotOf(from)
  if (!snap) {
    await botCall('answerCallbackQuery', {
      callback_query_id: cbId,
      text: '⚠️ Telegram не передал данные аккаунта — нажми кнопку ещё раз.',
      show_alert: true,
    })
    return
  }

  const attempt = await db.loginAttempt.findUnique({ where: { id: token } }).catch(() => null)

  if (!attempt || (attempt.status === 'pending' && attempt.expiresAt.getTime() < Date.now())) {
    await botCall('answerCallbackQuery', {
      callback_query_id: cbId,
      text: '⌛️ Ссылка уже недействительна — создай новую на сайте.',
      show_alert: true,
    })
    return
  }

  if (attempt.status === 'pending') {
    // Атомарно переводим в confirmed (повторное нажатие не затирает данные)
    await db.loginAttempt.updateMany({
      where: { id: token, status: 'pending' },
      data: { status: 'confirmed', tgUserJson: snap, confirmedAt: new Date() },
    })
  }

  await botCall('answerCallbackQuery', {
    callback_query_id: cbId,
    text: '🎉 Ты в Tg Swipe!',
    show_alert: false,
  })

  // Убираем кнопку «Войти» (чтобы не жмакали повторно), оставляем ссылку на сайт.
  // Иконка 📖 из слота; если edit с иконками отвергнут — повтор без них.
  if (msgChatId && msgId) {
    const doneText = await premiumText(
      [
        `✅ <b>Готово, ${escapeHtml(nameOf(from))} — ты внутри!</b>`,
        '',
        '🎉 Лента, подписки и сохранённые посты уже синхронизированы с твоим аккаунтом.',
        '',
        'Аккаунт закреплён за твоим Telegram — повторный вход не потребуется. Приятного чтения!',
      ].join('\n'),
    )
    const feedRows: BotButton[][] = [
      [{ label: 'Читать ленту', emoji: '📖', url: SITE_URL, style: 'primary' }],
    ]
    const base = {
      chat_id: msgChatId,
      message_id: msgId,
      text: doneText,
      parse_mode: 'HTML',
    }
    const sent = await botCall('editMessageText', {
      ...base,
      reply_markup: buildIconKeyboard(feedRows, await premiumMap()).markup,
    })
    // Повтор без иконок — только если редактирование отвергнуто НЕ из-за 429
    // (под баном второй вызов лишь продлевает наказание)
    if (!sent && !botBanned()) {
      void botCall('editMessageText', {
        ...base,
        reply_markup: buildPlainKeyboard(feedRows),
      })
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/* ---------------------- Оплата Telegram Stars ---------------------- */

/**
 * message.successful_payment (currency XTR) — оплата инвойса из
 * /api/payments/stars. Payload: topup:<userId>:<swipes>:<paymentId>.
 * Зачисление идемпотентно (creditPendingPayment), повторные апдейты безвредны.
 */
async function handleStarsPayment(sp: NonNullable<NonNullable<TgUpdate['message']>['successful_payment']>, chatId?: number) {
  if (sp.currency !== 'XTR') return // другая валюта нам не приходила и не нужна
  const parts = (sp.invoice_payload ?? '').split(':')

  // Тарифный платёж: tier:<uid>:<purpose>:<paymentId> (purpose = plus_month|...)
  if (parts.length === 4 && parts[0] === 'tier') {
    const [, uid, purpose, paymentId] = parts
    const payment = await db.pendingPayment.findUnique({ where: { id: paymentId } }).catch(() => null)
    if (!payment || payment.userId !== uid || payment.provider !== 'stars') return
    if (typeof sp.total_amount === 'number' && sp.total_amount !== payment.amountKop / 100) {
      console.error('[bot/webhook] tier stars amount mismatch', { paymentId, expected: payment.amountKop / 100, got: sp.total_amount })
      return
    }
    const credited = await creditPendingPayment(payment.id, sp.telegram_payment_charge_id ?? null)
    if (credited && chatId) {
      const label = purpose?.startsWith('pro') ? 'Tg Swipe Pro' : 'Tg Swipe Plus'
      await botSendRich(
        chatId,
        [
          '⭐️ <b>Платёж получен</b>',
          '',
          `Тариф <b>${label}</b> активирован — все премиум-функции уже открыты.`,
          '',
          '🎉 Приятного чтения!',
        ].join('\n'),
      )
    }
    return
  }

  // topup:<uid>:<swipes>:<paymentId>
  if (parts.length !== 4 || parts[0] !== 'topup') return
  const [, uid, swipesStr, paymentId] = parts
  const swipes = Number(swipesStr)
  if (!uid || !Number.isFinite(swipes) || swipes <= 0 || !paymentId) return

  const payment = await db.pendingPayment.findUnique({ where: { id: paymentId } }).catch(() => null)
  if (!payment || payment.userId !== uid || payment.provider !== 'stars') return

  // Сверяем сумму: Stars к оплате = свайпам из payload
  if (typeof sp.total_amount === 'number' && sp.total_amount !== swipes) {
    console.error('[bot/webhook] stars amount mismatch', { paymentId, expected: swipes, got: sp.total_amount })
    return
  }

  const credited = await creditPendingPayment(payment.id, sp.telegram_payment_charge_id ?? null)
  if (credited && chatId) {
    await botSendRich(
      chatId,
      [
        '⭐️ <b>Платёж получен</b>',
        '',
        `🚀 <b>${swipes} свайпов</b> зачислено на баланс продвижения.`,
        '',
        '📖 Запустить кампанию можно в «Мой канал» → «Продвижение».',
      ].join('\n'),
      {
        keyboard: [
          [{ label: 'Продвинуть канал', emoji: '🚀', url: SITE_URL, style: 'primary' }],
        ] satisfies BotButton[][],
      },
    )
  }
}

/* --------------------------------- Роут --------------------------------- */

export async function POST(request: Request) {
  // Секрет вебхука (setWebhook secret_token → Telegram эхом шлёт заголовок)
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim()
  if (secret) {
    const got = (request.headers.get('x-telegram-bot-api-secret-token') ?? '').trim()
    if (got !== secret) {
      return NextResponse.json({ ok: false }, { status: 401 })
    }
  } else if (Date.now() - lastSecretWarnAt > SECRET_WARN_INTERVAL_MS) {
    // Дыра в конфигурации: без секрета вебхук отвечает ЛЮБОму отправителю
    // (ложные апдейты тратят БД/вызовы Bot API). Не спамим — раз в 60с.
    lastSecretWarnAt = Date.now()
    console.warn(
      '[bot/webhook] TELEGRAM_WEBHOOK_SECRET не задан — вебхук принимает запросы без проверки подлинности (задай secret_token в setWebhook)',
    )
  }

  // Content-type: Telegram шлёт строго application/json; прочее — сканеры/мусор
  const contentType = (request.headers.get('content-type') ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (contentType !== 'application/json') {
    return NextResponse.json({ ok: false }, { status: 415 })
  }

  // Кап размера тела по заявленному content-length (до чтения тела)
  const declaredLen = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declaredLen) && declaredLen > WEBHOOK_MAX_BYTES) {
    return NextResponse.json({ ok: false }, { status: 413 })
  }

  // Самолечение allowed_updates (1 раз на инстанс; no-op если уже healed)
  if (!healChecked) {
    healChecked = true
    await healWebhookAllowedUpdates(request)
  }

  let update: TgUpdate
  try {
    update = (await request.json()) as TgUpdate
  } catch {
    return NextResponse.json({ ok: true }) // мусор не роняет вебхук
  }

  try {
    // Telegram Business: премиум-аккаунт владельца подключился как посредник
    const bc = update.business_connection
    if (bc?.id && bc.user?.id) {
      if (bc.user.id === BOT_OWNER_TG_ID) {
        await setBusinessConnection({
          id: bc.id,
          userId: bc.user.id,
          isEnabled: bc.is_enabled !== false,
        }).catch(() => {})
      } else {
        // Диагностика: подключение с ЧУЖОГО аккаунта — сохраним, чтобы владелец
        // мог понять, с какого ID он реально подключил бота
        await db.botSetting
          .upsert({
            where: { key: 'business_connection_rejected' },
            create: {
              key: 'business_connection_rejected',
              value: JSON.stringify({ id: bc.id, userId: bc.user.id, isEnabled: bc.is_enabled !== false, at: new Date().toISOString() }),
            },
            update: {
              value: JSON.stringify({ id: bc.id, userId: bc.user.id, isEnabled: bc.is_enabled !== false, at: new Date().toISOString() }),
            },
          })
          .catch(() => {})
      }
      return NextResponse.json({ ok: true })
    }

    const cq = update.callback_query
    if (cq?.data?.startsWith('login:')) {
      const token = cq.data.slice('login:'.length)
      if (/^[a-f0-9]{48}$/.test(token)) {
        await handleLoginCallback(
          cq.id,
          token,
          cq.from,
          cq.message?.chat?.id,
          cq.message?.message_id,
        )
      } else {
        await botCall('answerCallbackQuery', { callback_query_id: cq.id })
      }
      return NextResponse.json({ ok: true })
    }

    const msg = update.message
    if (msg?.successful_payment) {
      await handleStarsPayment(msg.successful_payment, msg.chat?.id)
      return NextResponse.json({ ok: true })
    }
    if (msg?.text?.startsWith('/emojis')) {
      await handleEmojisCommand(msg.from, msg.chat?.id)
      return NextResponse.json({ ok: true })
    }
    if (msg?.text?.startsWith('/start')) {
      const parts = msg.text.split(/\s+/)
      const param = parts[1] ?? ''
      if (param.startsWith('login_')) {
        const token = param.slice('login_'.length)
        if (/^[a-f0-9]{48}$/.test(token)) {
          await handleStartLogin(token, msg.from, msg.chat?.id)
          return NextResponse.json({ ok: true })
        }
      }
      await handleStart(msg.from, msg.chat?.id)
    }
    // Захват custom_emoji из любого сообщения (текст или подпись медиа)
    if (msg && (msg.entities?.length || msg.caption_entities?.length)) {
      await handleCustomEmojiCapture(msg)
    }
  } catch (e) {
    console.error('[bot/webhook]', e)
  }

  // Всегда 200 — Telegram ретраит только не-2xx
  return NextResponse.json({ ok: true })
}
