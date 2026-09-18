import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * Webhook Telegram Bot API — единственная точка приёма апдейтов бота.
 *
 * Сейчас обслуживает ВХОД НА САЙТ:
 *   • /start login_<token>  → бот присылает сообщение с inline-кнопкой «Войти»;
 *   • нажатие кнопки (callback_query login:<token>) → фиксируем в LoginAttempt
 *     снимок tg-пользователя (callback_query.from), сайт подхватывает опросом.
 *
 * Регистрация: scripts/set-webhook.ts (URL + secret_token).
 * Если задан TELEGRAM_WEBHOOK_SECRET — проверяем заголовок
 * x-telegram-bot-api-secret-token (Telegram присылает secret_token из setWebhook).
 */

const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN?.trim() ?? ''

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

type TgUpdate = {
  update_id?: number
  message?: {
    chat?: { id?: number }
    from?: TgFrom
    text?: string
  }
  callback_query?: {
    id: string
    data?: string
    from?: TgFrom
    message?: { chat?: { id?: number }; message_id?: number }
  }
}

/* --------------------------- Вызовы Bot API --------------------------- */

type InlineButton = { text: string; callback_data?: string; url?: string }

async function botCall<T = unknown>(
  method: string,
  payload: Record<string, unknown>,
): Promise<T | null> {
  if (!BOT_TOKEN()) return null
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    })
    const data = (await res.json()) as { ok?: boolean; result?: T }
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

/* ------------------------------ Обработчики ------------------------------ */

/** /start login_<token> — прислать сообщение с кнопкой «Войти» */
async function handleStartLogin(token: string, from: TgFrom | undefined, chatId?: number) {
  if (!chatId) return
  const attempt = await db.loginAttempt.findUnique({ where: { id: token } }).catch(() => null)
  const valid =
    attempt && attempt.status === 'pending' && attempt.expiresAt.getTime() > Date.now()

  if (!valid) {
    await botCall('sendMessage', {
      chat_id: chatId,
      text:
        '⌛️ Ссылка входа устарела.\n\nВернитесь на сайт и нажмите «Вход по Telegram» ещё раз — ссылка живёт 15 минут.',
      parse_mode: 'HTML',
    })
    return
  }

  await botCall('sendMessage', {
    chat_id: chatId,
    text: `Привет, <b>${escapeHtml(nameOf(from))}</b>! 👋\n\nПодтвердите вход на сайт <b>Tg Swipe</b> — умная лента Telegram-каналов.\n\nНажмите кнопку ниже, и вы автоматически войдёте на сайте под своим аккаунтом.`,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Войти на сайт', callback_data: `login:${token}` }],
        [{ text: '🌐 Открыть Tg Swipe', url: SITE_URL }],
      ],
    },
  })
}

/** Приветственный /start без параметра */
async function handleStart(from: TgFrom | undefined, chatId?: number) {
  if (!chatId) return
  await botCall('sendMessage', {
    chat_id: chatId,
    text: `Привет, <b>${escapeHtml(nameOf(from))}</b>! 👋\n\n<b>Tg Swipe</b> — умная лента открытых Telegram-каналов: свайпайте посты по интересам, сохраняйте лучшее, подписывайтесь в один тап.\n\n• Открыть приложение — кнопка меню внизу\n• Открыть сайт — кнопка ниже\n• Здесь же я подтверждаю вход на сайт`,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🌐 Открыть сайт', url: SITE_URL }],
      ],
    },
  })
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
      text: 'Не удалось получить данные Telegram. Попробуйте ещё раз.',
      show_alert: true,
    })
    return
  }

  const attempt = await db.loginAttempt.findUnique({ where: { id: token } }).catch(() => null)

  if (!attempt || (attempt.status === 'pending' && attempt.expiresAt.getTime() < Date.now())) {
    await botCall('answerCallbackQuery', {
      callback_query_id: cbId,
      text: '⌛️ Ссылка устарела — вернитесь на сайт и создайте новую.',
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
    text: '✅ Готово! Возвращайтесь на сайт — вы вошли.',
    show_alert: false,
  })

  // Убираем кнопку «Войти» (чтобы не жмакали повторно), оставляем ссылку на сайт
  if (msgChatId && msgId) {
    void botCall('editMessageText', {
      chat_id: msgChatId,
      message_id: msgId,
      text: `✅ <b>Вход подтверждён</b> — ${escapeHtml(nameOf(from))}, вы вошли на сайт Tg Swipe.\n\nВернитесь на вкладку сайта: профиль, подписки и история подтянутся автоматически.`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '🌐 Открыть Tg Swipe', url: SITE_URL }]],
      },
    })
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
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
  }

  let update: TgUpdate
  try {
    update = (await request.json()) as TgUpdate
  } catch {
    return NextResponse.json({ ok: true }) // мусор не роняет вебхук
  }

  try {
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
  } catch (e) {
    console.error('[bot/webhook]', e)
  }

  // Всегда 200 — Telegram ретраит только не-2xx
  return NextResponse.json({ ok: true })
}
