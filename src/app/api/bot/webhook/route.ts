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
import { externalOrigin, timingSafeEqualStr } from '@/lib/server'
import { botBanned, botEnabled, markBotBan, TELEGRAM_REQUIRED_UPDATES } from '@/lib/tg-bot'
import { joinGiveaway, kickDueGiveaways, refreshGiveawayButton } from '@/lib/giveaways'
import {
  handleBoostCheck,
  handleWizardCallback,
  handleWizardPhoto,
  handleWizardText,
  sendJoinOnboarding,
  sendMyGiveawayCard,
  startGiveawayWizard,
  tryRedeemPromoText,
} from '@/lib/giveaway-wizard'
import {
  awardForwardTickets,
  collectForwardedSource,
  extractForwardChannel,
  kickSourceParse,
  FORWARD_SOURCE_CAP,
} from '@/lib/source-profile'
import { FORWARD_SOURCES_GOAL } from '@/lib/giveaway-tickets'
import { ingestChannelPost, type TgChannelMessage } from '@/lib/channel-ingest'
import { backfillChannelHistory } from '@/lib/channel-backfill'
import { getChatInfo } from '@/lib/tg-bot'
import { setMailOptout } from '@/lib/retention-cron'
import {
  sendHelpMenu,
  sendPromoHint,
  sendTicketsStatus,
  startSponsorFlow,
  startAdFlow,
  startSendFlow,
  handleFsmText,
  handleFsmPhoto,
  handleFsmForward,
  handleCommerceCallback,
} from '@/lib/commerce-wizard'
import { isBlacklisted } from '@/services/autoMod'
import { after } from 'next/server'

export const dynamic = 'force-dynamic'
/**
 * v5.77: мягкий кап длительности. Тяжёлые цепочки (приветствие с фото,
 * gw:join с проверкой подписок) раньше могли превышать дефолтный лимит
 * serverless — платформа убивала функцию молча, Telegram получал не-2xx/таймаут
 * и ретраил апдейт, что усугубляло зависания. 55с < 60с платформенного лимита.
 */
export const maxDuration = 55

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

// ===== v5.98: OWNER-идентификаторы (ADMIN_TG_IDS env) — /send и админ-блок /help =====
const adminTgIdSet = new Set(
  (process.env.ADMIN_TG_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith('tg_') ? s.slice(3) : s)),
)

/**
 * v5.98: меню команд бота (setMyCommands) — раз в сутки (троттлинг через
 * BotSetting). Fire-and-forget из вебхука: серверless сам поднимет меню,
 * отдельный скрипт не нужен.
 */
let botMenuBusy = false
async function ensureBotMenu(): Promise<void> {
  if (!botEnabled() || botMenuBusy) return
  botMenuBusy = true
  try {
    const marker = await db.botSetting
      .findUnique({ where: { key: 'botmenu_set_at' }, select: { value: true } })
      .catch(() => null)
    if (marker && Date.now() - (Number(marker.value) || 0) < 24 * 3600_000) return
    const ok = await botCall('setMyCommands', {
      commands: [
        { command: 'start', description: 'Открыть Tg Swipe' },
        { command: 'tickets', description: 'Розыгрыш и фарм билетов' },
        { command: 'promo', description: 'Секретный промокод' },
        { command: 'sponsor', description: 'Спонсорство розыгрыша — 990 ₽' },
        { command: 'ad', description: 'Рекламный слот 12:00/18:00 — 990 ₽' },
        { command: 'help', description: 'Все команды' },
      ],
    })
    if (ok) {
      await db.botSetting
        .upsert({
          where: { key: 'botmenu_set_at' },
          create: { key: 'botmenu_set_at', value: String(Date.now()) },
          update: { value: String(Date.now()) },
        })
        .catch(() => {})
    }
  } catch {
    // меню не критично
  } finally {
    botMenuBusy = false
  }
}

/** Реальные апдейты Telegram максимум ~256KB — всё, что больше, мусор */
const WEBHOOK_MAX_BYTES = 512 * 1024
/** Антиспам предупреждений о незаданном секрете: не чаще раза в 60с */
const SECRET_WARN_INTERVAL_MS = 60_000
let lastSecretWarnAt = 0

/* ------------------- Самолечение webhook-URL + allowed_updates ------------------- */

const HEAL_KEY = 'webhook_selfheal_v3' // v3: троттлинг-сверка URL (не одноразовый флаг)
/** Троттлинг самолечения: не чаще раза в 15 минут на инстанс (getWebhookInfo не бесплатен) */
const HEAL_INTERVAL_MS = 15 * 60_000
let lastHealAt = 0

/**
 * v5.77: САМОЛЕЧЕНИЕ ВЕБХУКА ВНУТРИ САМОГО ВЕБХУКА.
 *
 * После «очистки деплоев» (v5.75.1) вебхук мог остаться зарегистрированным на
 * dpl-URL конкретного деплоя — Telegram шлёт апдейты в никуда: бот молчит,
 * кнопки крутят бесконечный спиннер. Раньше лечение жило в /api/health и под
 * одноразовым флагом webhook_selfheal_v2 — если health никто не пингует,
 * бот молчал вечно.
 *
 * Теперь при каждом апдейте (троттлинг 15 мин) сверяем фактический URL из
 * getWebhookInfo с каноническим прод-доменом и перерегистрируем при расхождении.
 * Канонический домен ВЫШЕ внешнего origin запроса — иначе самолечение
 * perpetuate'ит dpl-URL (умирает вместе с деплоем).
 */
async function healWebhook(request: Request): Promise<void> {
  const now = Date.now()
  if (now - lastHealAt < HEAL_INTERVAL_MS) return
  lastHealAt = now
  try {
    const token = BOT_TOKEN()
    if (!token) return
    const origin =
      process.env.NEXT_PUBLIC_APP_URL?.trim() ||
      (process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim()
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL.trim()}`
        : '') ||
      externalOrigin(request)
    if (!origin) return
    const expectedUrl = `${origin.replace(/\/$/, '')}/api/bot/webhook`

    // 1) Фактический URL вебхука (расхождение = мёртвый/чужой домен)
    const infoRes = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
      signal: AbortSignal.timeout(6000),
    })
    const info = (await infoRes.json().catch(() => null)) as {
      ok?: boolean
      result?: {
        url?: string
        last_error_message?: string
        pending_update_count?: number
        allowed_updates?: string[]
      }
    } | null
    const currentUrl = info?.result?.url ?? ''
    /* v5.80: перерегистрируем не только при расхождении URL, но и когда в
       allowed_updates нет новых типов апдейтов (channel_post для мгновенных
       постов привязанных каналов) — иначе фича молча не работает до смены URL.
       v5.92: список вынесен в TELEGRAM_REQUIRED_UPDATES — health и вебхук
       больше не могут разъехаться. */
    const REQUIRED_UPDATES = TELEGRAM_REQUIRED_UPDATES
    const allowed = info?.result?.allowed_updates ?? []
    const updatesOk =
      allowed.length === 0 // пусто = дефолт Telegram (все кроме selected) — считаем нормой
        ? true
        : REQUIRED_UPDATES.every((u) => allowed.includes(u))
    if (currentUrl === expectedUrl && updatesOk) return // уже здоров

    console.warn(
      `[bot/webhook] вебхук требует перерегистрации: URL "${currentUrl || '<пусто>'}" (updates: ${allowed.join(',') || 'дефолт'}) → "${expectedUrl}" (last_error: ${info?.result?.last_error_message ?? '—'})`,
    )

    // 2) Перерегистрация на канонический домен (drop_pending=false — очередь доезжает)
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim()
    const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: expectedUrl,
        ...(secret ? { secret_token: secret } : {}),
        allowed_updates: TELEGRAM_REQUIRED_UPDATES,
        max_connections: 40,
        drop_pending_updates: false,
      }),
      signal: AbortSignal.timeout(8000),
    })
    const data = (await res.json().catch(() => null)) as { ok?: boolean } | null
    if (data?.ok) {
      await db.botSetting
        .upsert({ where: { key: HEAL_KEY }, create: { key: HEAL_KEY, value: new Date().toISOString() }, update: { value: new Date().toISOString() } })
        .catch(() => {})
      console.log('[bot/webhook] webhook self-healed →', expectedUrl)
    }
  } catch (e) {
    console.error('[bot/webhook] webhook self-heal failed (retry on next update)', e)
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
    chat?: { id?: number; type?: string }
    from?: TgFrom
    text?: string
    /** Entities текста: здесь прилетает type='custom_emoji' с custom_emoji_id —
     *  так бот узнаёт ID премиум-эмодзи из сообщений пользователей */
    entities?: TgEntity[]
    caption?: string
    caption_entities?: TgEntity[]
    /** Фото (мастер розыгрышей — шаг «картинка поста») */
    photo?: Array<{ file_id?: string; width?: number; height?: number }>
    /** v5.50: источники рекомендаций — пересылка постов из любимых каналов.
     *  forward_origin — современный формат (Bot API 7.0+), forward_from_chat —
     *  легаси. Обрабатываются ТОЛЬКО пересылки ИЗ КАНАЛОВ (type='channel'). */
    forward_origin?: {
      type?: string
      chat?: { id?: number; title?: string; username?: string }
    }
    forward_from_chat?: { id?: number; title?: string; username?: string }
    forward_from?: { id?: number; is_bot?: boolean }
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
    message?: { chat?: { id?: number; type?: string }; message_id?: number }
  }
  business_connection?: {
    id?: string
    user?: { id?: number; is_premium?: boolean }
    is_enabled?: boolean
  }
  /** v5.70: статус самого бота в чате/канале — копим реестр BotChat
   *  (для заданий «вступай в чат» с приватным инвайтом: бот не может зайти
   *  по ссылке сам — владелец добавляет его админом, чат приезжает сюда).
   *  v5.80: тот же апдейт ЗАВЕРШАЕТ привязку канала в «Мой канал» — юзер
   *  добавил бота админом в свой канал (см. claim-заявку из миниаппа). */
  my_chat_member?: {
    chat?: { id?: number; title?: string; username?: string; type?: string }
    new_chat_member?: {
      status?: string
      user?: { id?: number; is_bot?: boolean }
    }
  }
  /** v5.80: посты привязанных каналов — мгновенный инжест в ленту
   *  (раньше пост ждал обхода t.me/s парсером — минуты задержки) */
  channel_post?: TgChannelMessage & { chat?: { id?: number; title?: string; username?: string; type?: string } }
  edited_channel_post?: TgChannelMessage & { chat?: { id?: number; title?: string; username?: string; type?: string } }
}

/* --------------------------- Вызовы Bot API --------------------------- */

/**
 * v5.80 — ЗАВЕРШЕНИЕ ПРИВЯЗКИ КАНАЛА через добавление бота.
 *
 * Юзер в «Мой канал» вводит @юзернейм канала → в БД пишется заявка
 * claim_pending:<uname> → { userId } (см. POST /api/mychannel claimStart).
 * Как только юзер добавляет бота администратором канала, Telegram шлёт
 * my_chat_member — здесь находим заявку, отдаём канал заявителю и чишим заявку.
 * Дублирующий путь самопроверки (getBotChatRights fresh) живёт в
 * /api/mychannel/claim-status — покрывает случай «бот был админом ещё ДО
 * заявки» (тогда my_chat_member не приходит вовсе).
 */
async function completePendingClaim(
  chat: { id?: number; title?: string; username?: string },
): Promise<{ userId: string; title: string } | null> {
  try {
    const uname = (chat.username ?? '').replace(/^@/, '').toLowerCase()
    if (!uname) return null // приватный канал — привязка по юзернейму недоступна

    const pendingKey = `claim_pending:${uname}`
    const raw = await db.botSetting.findUnique({ where: { key: pendingKey } })
    if (!raw) return null
    let pending: { userId?: string; at?: string } | null = null
    try {
      pending = JSON.parse(raw.value) as { userId?: string; at?: string }
    } catch {
      pending = null
    }
    const userId = typeof pending?.userId === 'string' ? pending.userId : ''
    const at = Date.parse(pending?.at ?? '')
    if (!userId.startsWith('tg_') || !Number.isFinite(at) || Date.now() - at > 48 * 3600_000) {
      await db.botSetting.delete({ where: { key: pendingKey } }).catch(() => {})
      return null
    }

    const channel = await db.channel.findUnique({ where: { username: uname }, select: { id: true, title: true, claimedById: true } })
    if (!channel) return null
    if (channel.claimedById && channel.claimedById !== userId) {
      // Уже привязан другому — заявку снимаем
      await db.botSetting.delete({ where: { key: pendingKey } }).catch(() => {})
      return null
    }

    await db.channel.update({
      where: { id: channel.id },
      data: {
        claimedById: userId,
        claimedAt: new Date(),
        status: 'active',
        // настоящий chat id вместо чернового claim_<uname> — единый формат с парсером
        ...(chat.id != null ? { tgId: String(chat.id) } : {}),
        ...(chat.title ? { title: chat.title.slice(0, 120) } : {}),
      },
    })
    await db.botSetting.delete({ where: { key: pendingKey } }).catch(() => {})

    // Вечная аватарка + подписчики из Bot API (фоном, не задерживаем апдейт)
    void getChatInfo(uname)
      .then((info) => {
        if (!info) return
        return db.channel
          .update({
            where: { id: channel.id },
            data: {
              ...(info.photoFileId ? { photoFileId: info.photoFileId, avatarFetchedAt: new Date() } : {}),
              ...(info.members ? { membersCount: info.members } : {}),
              ...(info.description ? { description: info.description.slice(0, 500) } : {}),
            },
          })
          .catch(() => {})
      })
      .catch(() => {})

    return { userId, title: channel.title }
  } catch (e) {
    console.error('[bot/webhook] completePendingClaim', e instanceof Error ? e.message.slice(0, 200) : e)
    return null
  }
}

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

/**
 * v5.50 «В ОДИН КЛИК»: юзер пересылает боту посты из своих любимых каналов —
 * бот мгновенно считывает каналы из пересылаемых сообщений, складывает их
 * в профиль источников и на 5-м уникальном выдаёт билет в розыгрыш.
 * Профиль — сильнейший сигнал персональной ленты + очередь парсинга.
 *
 * Возвращает true, если апдейт — пересылка поста из канала (обработан,
 * дальше не идём: текст пересланного поста — контент, а НЕ промокод/команда).
 */
async function handleForwardSources(
  msg: NonNullable<NonNullable<TgUpdate['message']>>,
  from: TgFrom,
  chatId: number,
): Promise<boolean> {
  // Только приватный чат «юзер ↔ бот»: в группах бот молчит
  if (msg.chat?.id !== from.id) return false
  const ch = extractForwardChannel(msg)
  if (!ch) return false // пересылка от юзера/бота — не наш сценарий

  const userId = `tg_${from.id}`
  const res = await collectForwardedSource(userId, ch)

  if (res.atCap) {
    await botSendRich(
      chatId,
      `📬 Профиль источников полон (${FORWARD_SOURCE_CAP} каналов). Это более чем достаточно для точных рекомендаций!`,
    )
    return true
  }

  // Канал записан → приоритетный парс: свежие посты любимого источника — в ленту
  if (res.added) kickSourceParse(ch)

  if (!res.added) {
    // Дубликат: короткое подтверждение без разбора подробностей
    await botSendRich(
      chatId,
      `📬 «${escapeHtml(ch.title)}» уже в твоём профиле источников — всего ${res.total}.`,
    )
    return true
  }

  const title = escapeHtml(ch.title)
  if (res.crossedGoal) {
    // Порог 5 каналов: билет во все активные розыгрыши
    const awards = await awardForwardTickets({
      userId,
      tgId: from.id,
      username: from.username,
      firstName: from.first_name,
    })
    if (awards.awardedGiveaways.length > 0) {
      await botSendRich(
        chatId,
        [
          `📬 <b>Готово!</b> Пять каналов собраны — билет в розыгрыш твой 🎟`,
          '',
          `Розыгрыш «${escapeHtml(awards.awardedGiveaways[0])}» теперь учитывает твой шанс на победу.`,
          '',
          '✨ Лента уже подстроилась под твои любимые каналы — свежие посты оттуда будут появляться чаще.',
        ].join('\n'),
        {
          keyboard: [[
            { label: 'Смотреть ленту', emoji: '📖', url: TME_APP_URL, style: 'primary' },
          ]],
        },
      )
    } else {
      await botSendRich(
        chatId,
        [
          `📬 <b>Готово!</b> ${FORWARD_SOURCES_GOAL} каналов записаны в твой профиль источников.`,
          '',
          '✨ Лента уже подстроилась под твои любимые каналы — свежие посты оттуда будут появляться чаще.',
          '🎟 Активного розыгрыша сейчас нет — билет начислим в следующем, как только он стартует.',
        ].join('\n'),
        {
          keyboard: [[
            { label: 'Смотреть ленту', emoji: '📖', url: TME_APP_URL, style: 'primary' },
          ]],
        },
      )
    }
    return true
  }

  if (res.total < FORWARD_SOURCES_GOAL) {
    const left = FORWARD_SOURCES_GOAL - res.total
    await botSendRich(
      chatId,
      [
        `📬 «${title}» — принято! <b>${res.total}/${FORWARD_SOURCES_GOAL}</b>`,
        '',
        `Перешли ещё посты из ${left} ${left === 1 ? 'канала' : 'каналов'}, где ты сидишь каждый день — и получишь билет в розыгрыш 🎟`,
      ].join('\n'),
    )
  } else {
    await botSendRich(
      chatId,
      `📬 «${title}» добавлен в профиль источников (${res.total}). Лента станет ещё точнее ✨`,
    )
  }
  return true
}

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
        [{ label: 'Открыть Tg Swipe', emoji: '🌐', url: SITE_URL, style: 'primary' }],
      ] satisfies BotButton[][],
    },
  )
}

/** Приветственный /start — КАРТИНКА + премиум-подпись + кнопки */
async function handleStart(from: TgFrom | undefined, chatId?: number) {
  if (!chatId) return
  // v5.33: первый /start — ВЫБОР ЯЗЫКА (по-английски, кнопки Ru/En);
  // выбранный язык сохраняется (BotSetting) и все следующие приветствия — на нём
  const saved = await getBotLang(chatId)
  if (!saved) {
    await botSendRich(
      chatId,
      [
        '👋 <b>Welcome to Tg Swipe!</b>',
        '',
        'A smart feed of Telegram channels — swipe, read and promote.',
        '',
        '<b>Choose a language to continue:</b>',
      ].join('\n'),
      {
        keyboard: [
          [{ label: 'Русский 🇷🇺', callback_data: 'lang:ru', style: 'primary' }],
          [{ label: 'English 🇬🇧', callback_data: 'lang:en', style: 'primary' }],
        ] satisfies BotButton[][],
      },
    )
    return
  }
  await sendGreeting(chatId, saved, from)
}

/** Язык бота для чата (выбор после /start) — хранится в BotSetting */
const BOTLANG_PREFIX = 'botlang:'
async function getBotLang(chatId: number): Promise<'ru' | 'en' | null> {
  const row = await db.botSetting
    .findUnique({ where: { key: `${BOTLANG_PREFIX}${chatId}` } })
    .catch(() => null)
  return row?.value === 'ru' || row?.value === 'en' ? row.value : null
}

async function setBotLang(chatId: number, lang: 'ru' | 'en'): Promise<void> {
  await db.botSetting
    .upsert({
      where: { key: `${BOTLANG_PREFIX}${chatId}` },
      create: { key: `${BOTLANG_PREFIX}${chatId}`, value: lang },
      update: { value: lang },
    })
    .catch(() => {})
}

/** callback lang:<ru|en> — сохранить выбор и отправить приветствие на нём */
async function handleLangCallback(
  cbId: string,
  lang: 'ru' | 'en',
  from: TgFrom | undefined,
  chatId?: number,
) {
  if (!chatId) {
    await botCall('answerCallbackQuery', { callback_query_id: cbId })
    return
  }
  await setBotLang(chatId, lang)
  await botCall('answerCallbackQuery', {
    callback_query_id: cbId,
    text: lang === 'ru' ? '✅ Язык: русский' : '✅ Language: English',
  })
  await sendGreeting(chatId, lang, from)
}

/** Приветствие на выбранном языке — картинка + премиум-подпись + кнопки */
async function sendGreeting(chatId: number, lang: 'ru' | 'en', from: TgFrom | undefined) {
  const name = escapeHtml(nameOf(from))
  if (lang === 'en') {
    await botSendPhotoRich(
      chatId,
      [
        `👋 <b>Hi, ${name}!</b>`,
        '',
        'This is <b>Tg Swipe</b> — a smart Telegram feed.',
        '',
        '⚡ <b>Swipe</b> — the feed adapts to your interests',
        '📖 <b>Read</b> any channels without subscribing',
        '🚀 <b>Promote</b> your channel to the top of the feed',
        '',
        '✨ Subscribe to our channel — news, updates and features first:',
      ].join('\n'),
      {
        keyboard: [
          // v5.76: ВСЕ кнопки цветные (официальный style Bot API)
          [{ label: 'Subscribe to the channel', emoji: '✨', url: 'https://t.me/SnapTeamDev', style: 'primary' }],
          [{ label: 'Open Tg Swipe', emoji: '📖', url: TME_APP_URL, style: 'success' }],
          // v5.43: документы сервиса — постоянные ссылки (требование платёжного провайдера)
          [
            { label: 'Pricing & payments', emoji: '💳', url: `${SITE_URL}/pricing`, style: 'danger' },
            { label: 'Legal docs', emoji: '📄', url: `${SITE_URL}/terms`, style: 'primary' },
          ],
        ] satisfies BotButton[][],
      },
    )
    return
  }
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
          // v5.76: ВСЕ кнопки цветные (официальный style Bot API)
          [{ label: 'Подписаться на канал', emoji: '✨', url: 'https://t.me/SnapTeamDev', style: 'primary' }],
          [{ label: 'Открыть Tg Swipe', emoji: '📖', url: TME_APP_URL, style: 'success' }],
          // v5.43: документы сервиса — постоянные ссылки (требование платёжного провайдера)
          [
            { label: 'Тарифы и оплата', emoji: '💳', url: `${SITE_URL}/pricing`, style: 'danger' },
            { label: 'Документы', emoji: '📄', url: `${SITE_URL}/terms`, style: 'primary' },
          ],
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

/**
 * callback gw:join:<giveawayId> — кнопка «Участвовать (N)» розыгрыша.
 * Автопроверка подписок → заявка / список каналов; счётчик кнопки — в реальном времени.
 */
async function handleGiveawayJoin(
  cbId: string,
  giveawayId: string,
  from: TgFrom | undefined,
  chatId?: number,
) {
  // v5.77: СНАЧАЛА мгновенно закрываем спиннер — раньше answerCallbackQuery
  // уходил только после joinGiveaway (до 5 × getChatMember по 8с + DB), и у
  // пользователя кнопка «грузила бесконечно». Результат приходим сообщением ниже.
  await botCall('answerCallbackQuery', {
    callback_query_id: cbId,
    text: '⏳ Проверяем условия…',
  }).catch(() => {})
  if (!from || typeof from.id !== 'number') return
  const r = await joinGiveaway(giveawayId, {
    id: `tg_${from.id}`,
    tgId: from.id,
    username: from.username,
    firstName: from.first_name,
  }).catch(
    (): { ok: false; reason: 'db'; message: string } => ({
      ok: false,
      reason: 'db',
      message: 'Не получилось — попробуйте ещё раз',
    }),
  )

  if (r.ok) {
    // Спиннер уже закрыт ранним answer; фидбек — сообщением + живым счётчиком кнопки
    if (!r.already && chatId) {
      await botSendRich(chatId, '🎉 <b>Ты в игре!</b> Заявка принята — удачи!').catch(() => {})
    }
    // Реалтайм-счётчик: кнопка «Участвовать (N)» обновляется у всех
    if (!r.already) void refreshGiveawayButton(giveawayId, r.count)
    // v5.46: при первой заявке — ЛС-карточка заданий (как заработать билеты)
    if (!r.already && chatId && from.id) {
      void sendJoinOnboarding(chatId, giveawayId, `tg_${from.id}`).catch(() => {})
    }
    return
  }

  if (r.reason === 'need_subscribe') {
    // Кнопки подписки на недостающие каналы — сообщением (удобно тапать)
    if (chatId && r.channels.length > 0) {
      await botSendRich(
        chatId,
        [
          '🔗 <b>Сначала подпишись</b> — это условие розыгрыша:',
          '',
          ...r.channels.map((c) => `• @${escapeHtml(c)}`),
          '',
          'Подписался — жми «Участвовать» ещё раз!',
        ].join('\n'),
        {
          keyboard: r.channels.map((c) => [{
            label: `Подписаться на @${c}`,
            emoji: '✨',
            url: `https://t.me/${c}`,
            style: 'primary',
          }]) satisfies BotButton[][],
        },
      ).catch(() => {})
    } else if (chatId) {
      await botSendRich(chatId, r.message).catch(() => {})
    }
    return
  }

  // ended / not_active / прочее — сообщение с причиной
  if (chatId) {
    await botSendRich(chatId, r.message).catch(() => {})
  }
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

  // v5.98: sponsor:<uid>:<paymentId> — оплата спонсорства Stars
  if (parts.length === 3 && parts[0] === 'sponsor') {
    const [, uid, paymentId] = parts
    const payment = await db.pendingPayment.findUnique({ where: { id: paymentId } }).catch(() => null)
    if (!payment || payment.userId !== uid || payment.provider !== 'stars') return
    const credited = await creditPendingPayment(payment.id, sp.telegram_payment_charge_id ?? null)
    if (credited && chatId) {
      const { notifyCommercePaid } = await import('@/lib/commerce-wizard')
      await notifyCommercePaid(uid, 'sponsor')
    }
    return
  }

  // v5.98: adslot:<uid>:<slotId>:<paymentId> — оплата рекламного слота Stars
  if (parts.length === 4 && parts[0] === 'adslot') {
    const [, uid, , paymentId] = parts
    const payment = await db.pendingPayment.findUnique({ where: { id: paymentId } }).catch(() => null)
    if (!payment || payment.userId !== uid || payment.provider !== 'stars') return
    const credited = await creditPendingPayment(payment.id, sp.telegram_payment_charge_id ?? null)
    if (credited && chatId) {
      const { notifyCommercePaid } = await import('@/lib/commerce-wizard')
      await notifyCommercePaid(uid, 'adslot')
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
        `💵 <b>${swipes} ₽</b> зачислено на рублёвый баланс.`,
        '',
        'Тратится на всё: свайпы для нейросетей, тарифы Snap, продвижение каналов.',
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

/**
 * v6.6: копим ВСЮ аудиторию ЛС бота (BotUser). Каждый приватный апдейт —
 * upsert chat_id + последний известный username/имя. Идемпотентно и дёшево
 * (один upsert на апдейт), рассылки потом доходят до всех, кто трогал бота.
 */
async function rememberBotUser(from: TgFrom): Promise<void> {
  try {
    const chatId = String(from.id)
    const username = from.username ?? null
    const firstName = (from.first_name ?? '').trim() || null
    await db.botUser.upsert({
      where: { chatId },
      // username/firstName обновляем только если пришли непустые — не затираем
      // прошлые данные апдейтами без профиля
      create: { chatId, username, firstName },
      update: {
        ...(username ? { username } : {}),
        ...(firstName ? { firstName } : {}),
      },
    })
  } catch {
    /* таблицы нет / БД мигала — рассылка просто не увидит этого юзера */
  }
}

export async function POST(request: Request) {
  // Секрет вебхука (setWebhook secret_token → Telegram эхом шлёт заголовок)
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim()
  let trusted = false
  if (secret) {
    const got = (request.headers.get('x-telegram-bot-api-secret-token') ?? '').trim()
    if (!timingSafeEqualStr(got, secret)) {
      return NextResponse.json({ ok: false }, { status: 401 })
    }
    trusted = true
  } else if (Date.now() - lastSecretWarnAt > SECRET_WARN_INTERVAL_MS) {
    // Дыра в конфигурации: без секрета вебхук отвечает ЛЮБОму отправителю
    // (ложные апдейты тратят БД/вызовы Bot API). Не спамим — раз в 60с.
    lastSecretWarnAt = Date.now()
    console.warn(
      '[bot/webhook] TELEGRAM_WEBHOOK_SECRET не задан — вебхук принимает запросы без проверки подлинности (задай secret_token в setWebhook)',
    )
  }
  // v5.54: ДЕНЕЖНЫЕ апдейты (Stars-пополнения) без секрета НЕ принимаются —
  // поддельный successful_payment зачислял свайпы бесплатно (fail-closed ниже).

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

  // v5.77: самолечение webhook-URL (троттлинг 15 мин внутри функции) — раньше
  // здесь был одноразовый флаг, и бот молчал вечно, пока health никто не пингует
  await healWebhook(request)

  let update: TgUpdate
  try {
    update = (await request.json()) as TgUpdate
  } catch {
    return NextResponse.json({ ok: true }) // мусор не роняет вебхук
  }

  // v5.98: ЧЁРНЫЙ СПИСОК — апдейты забаненных молча игнорируются (наглухо, 200 ok:
  // Telegram не ретраит). Проверка ДО любой ветки — ни ответы, ни инвойсы.
  const blacklistedFromId = update.message?.from?.id ?? update.callback_query?.from?.id ?? 0
  if (blacklistedFromId > 0 && (await isBlacklisted(blacklistedFromId))) {
    return NextResponse.json({ ok: true })
  }

  // v6.6: АУДИТОРИЯ РАССЫЛОК — каждый приватный контакт с ботом (сообщение,
  // нажатие кнопки) сохраняет chat_id в BotUser. Fire-and-forget: не тормозит
  // обработку, сбой БД не мешает боту отвечать.
  const dmFrom = update.message?.from ?? update.callback_query?.from
  const dmChatType = update.message?.chat?.type ?? update.callback_query?.message?.chat?.type
  if (dmChatType === 'private' && dmFrom?.id && dmFrom.id > 0) {
    void rememberBotUser(dmFrom)
  }

  // v5.98: меню команд бота (setMyCommands) — раз в сутки, fire-and-forget
  void ensureBotMenu()

  try {
    // v5.80: ПОСТ КАНАЛА ВЛАДЕЛЬЦА — мгновенный инжест в ленту (channel_post /
    // edited_channel_post). Обрабатываем ПЕРВЫМ: это самый частый апдейт
    // привязанных каналов, и он не должен ждать за тяжёлыми ветками.
    const rawPost = update.channel_post ?? update.edited_channel_post
    if (rawPost?.chat) {
      const { chat, ...msg } = rawPost
      const edited = update.edited_channel_post != null
      const res = await ingestChannelPost(chat, msg as TgChannelMessage, { edited })
      if (res.ok) {
        console.log(
          `[bot/webhook] channel_post @${chat.username ?? chat.id} #${msg.message_id}: ${
            res.created ? 'created' : res.updated ? 'updated' : 'gallery+'
          }`,
        )
      } else if (res.reason && res.reason !== 'канал не привязан' && res.reason !== 'канала нет в базе') {
        console.warn(`[bot/webhook] channel_post skip: ${res.reason}`)
      }
      return NextResponse.json({ ok: true })
    }

    // v5.70: статус бота в чате/канале (my_chat_member) — реестр BotChat для
    // заданий «вступай в чат» с приватным инвайтом. Обрабатываем ДО остального:
    // апдейт самодостаточен и не касается юзеров миниаппа.
    // v5.80: если бот стал админом КАНАЛА — завершаем pending-привязку
    // из «Мой канал» (юзер только что добавил бота в свой канал).
    const mcm = update.my_chat_member
    if (mcm?.chat?.id != null) {
      const status = mcm.new_chat_member?.status ?? ''
      const isAdmin = status === 'administrator'
      const title = (mcm.chat.title ?? mcm.chat.username ?? String(mcm.chat.id)).slice(0, 120)
      const type = mcm.chat.type ?? 'supergroup'
      await db.botChat
        .upsert({
          where: { chatId: String(mcm.chat.id) },
          create: { chatId: String(mcm.chat.id), title, type, isAdmin },
          update: { title, type, isAdmin },
        })
        .catch(() => {})
      console.log(`[bot/webhook] my_chat_member: chat=${mcm.chat.id} "${title}" (${type}) → ${status}`)

      if (isAdmin && type === 'channel') {
        const claimed = await completePendingClaim(mcm.chat)
        if (claimed) {
          // v5.96: импорт истории канала сразу после привязки (after — не тормозим вебхук)
          const uname = (mcm.chat.username ?? '').replace(/^@/, '').toLowerCase()
          if (uname) {
            after(() => backfillChannelHistory(uname, { pages: 12, per: 50 }).catch(() => {}))
          }
          // Владелец узнаёт об успехе сразу — даже если миниапп закрыт
          await botCall(
            'sendMessage',
            {
              chat_id: claimed.userId.replace(/^tg_/, ''),
              text: `✅ Канал «${claimed.title}» привязан к Tg Swipe!\n\nТеперь он в твоём «Моем канале»: статистика живая, а новые посты появляются в миниаппе мгновенно.`,
            },
          ).catch(() => {})
        }
      }
      return NextResponse.json({ ok: true })
    }

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
    // Розыгрыши: ленивый планировщик (публикация запланированных + итоги просроченных),
    // троттлинг внутри kickDueGiveaways (не чаще раза в 30с на инстанс)
    void kickDueGiveaways().catch(() => {})
    // v5.93: «Не писать мне» — добровольный отказ от реактивационных пушей и
    // дайджеста (кнопка есть в обоих письмах крона удержания). Наградные
    // уведомления (лидерборды/стрики/цели) остаются — это транзакционные ЛС.
    if (cq?.data === 'mail:off') {
      const uid = cq.from?.id ? `tg_${cq.from.id}` : ''
      if (uid) await setMailOptout(uid, true).catch(() => {})
      await botCall('answerCallbackQuery', {
        callback_query_id: cq.id,
        text: 'Готово — такие сообщения больше не приходят',
      })
      return NextResponse.json({ ok: true })
    }
    if (cq?.data?.startsWith('gw:join:')) {
      const gid = cq.data.slice('gw:join:'.length)
      // id — cuid (25 символов, латиница/цифры) — фильтр от мусорных колбэков
      if (/^[a-z0-9]{16,32}$/i.test(gid)) {
        await handleGiveawayJoin(cq.id, gid, cq.from, cq.message?.chat?.id)
      } else {
        await botCall('answerCallbackQuery', { callback_query_id: cq.id })
      }
      return NextResponse.json({ ok: true })
    }
    // v5.46: мастер розыгрыша (только владелец бота)
    if (cq?.data?.startsWith('gww:')) {
      const chatId = cq.message?.chat?.id
      const reply = async (text?: string, alert?: boolean) => {
        await botCall('answerCallbackQuery', {
          callback_query_id: cq.id,
          ...(text ? { text, show_alert: alert === true } : {}),
        })
      }
      if (chatId) {
        await handleWizardCallback(
          chatId,
          cq.from?.id ?? 0,
          cq.from?.id === BOT_OWNER_TG_ID,
          cq.data,
          reply,
        ).catch((e) => console.error('[bot/webhook] gww', e))
      } else {
        await reply()
      }
      return NextResponse.json({ ok: true })
    }
    // v5.46: «Проверить буст» — задание розыгрыша
    if (cq?.data?.startsWith('gwb:')) {
      const gid = cq.data.slice('gwb:'.length)
      const chatId = cq.message?.chat?.id
      const reply = async (text?: string, alert?: boolean) => {
        await botCall('answerCallbackQuery', {
          callback_query_id: cq.id,
          ...(text ? { text, show_alert: alert === true } : {}),
        })
      }
      if (/^[a-z0-9]{16,32}$/i.test(gid) && chatId) {
        await handleBoostCheck(cq.id, gid, cq.from, chatId, reply).catch((e) =>
          console.error('[bot/webhook] gwb', e),
        )
      } else {
        await reply()
      }
      return NextResponse.json({ ok: true })
    }
    if (cq?.data?.startsWith('lang:')) {
      const code = cq.data.slice('lang:'.length)
      if (code === 'ru' || code === 'en') {
        await handleLangCallback(cq.id, code, cq.from, cq.message?.chat?.id)
      } else {
        await botCall('answerCallbackQuery', { callback_query_id: cq.id })
      }
      return NextResponse.json({ ok: true })
    }
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
      if (!trusted) {
        console.error('[bot/webhook] successful_payment без секрета вебхука — отклонено (fail-closed)')
        return NextResponse.json({ ok: false }, { status: 401 })
      }
      await handleStarsPayment(msg.successful_payment, msg.chat?.id)
      return NextResponse.json({ ok: true })
    }
    // v5.98: КОММЕРЧЕСКИЕ КОЛБЭКИ (спонсорство/реклама/рассылка) — до остальных,
    // префиксы уникальны (spay:/adpay:/adcal:/adslot:/spchk:/adchk:/sendgo:)
    const cqC = update.callback_query
    if (cqC?.data && /\b(spay|adpay|adcal|adslot|spchk|adchk|sendgo):/.test(cqC.data)) {
      const cdata: string = cqC.data
      const chatC = cqC.message?.chat?.id
      if (chatC && cqC.from?.id) {
        await handleCommerceCallback(
          cqC.id,
          cdata,
          chatC,
          { id: cqC.from.id, username: cqC.from.username, first_name: cqC.from.first_name },
        ).catch((e) => console.error('[bot/webhook] commerce cb', e))
      } else {
        await botCall('answerCallbackQuery', { callback_query_id: cqC.id })
      }
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
      // v5.46: реферальная ссылка — t.me/<bot>?start=ref_<referrerTgId>.
      // Записываем приглашение; «друг успешен», когда откроет Mini App (auth).
      if (param.startsWith('ref_')) {
        const refTg = Number(param.slice('ref_'.length))
        if (Number.isInteger(refTg) && refTg > 0 && msg.from?.id && msg.chat?.id) {
          const { recordReferral } = await import('@/lib/giveaway-tickets')
          const r = await recordReferral(refTg, msg.from.id)
          if (r.ok && !r.already) {
            const name = escapeHtml(nameOf(msg.from))
            await botSendRich(
              msg.chat.id,
              [
                `🤝 Привет, ${name}! Тебя пригласил друг в <b>Tg Swipe</b>.`,
                '',
                'Открой приложение — он получит билет в розыгрыше, а ты — доступ к умной ленте, розыгрышам и бонусам.',
              ].join('\n'),
              {
                keyboard: [[
                  { label: '📖 Открыть Tg Swipe', emoji: '🚀', url: TME_APP_URL, style: 'primary' },
                ]],
              },
            )
            // Пригласившему — радостная новость + досчёт задания referral
            const refUserId = `tg_${refTg}`
            const inviter = await db.user.findUnique({
              where: { id: refUserId },
              select: { id: true, username: true, firstName: true },
            }).catch(() => null)
            if (inviter) {
              const { referralProgress, checkAndAwardAuto } = await import('@/lib/giveaway-tickets')
              const invited = await referralProgress(refUserId).catch(() => 0)
              await botSendRich(
                refTg,
                [
                  `🎉 <b>${escapeHtml(nameOf(msg.from))}</b> присоединился по твоей ссылке!`,
                  '',
                  `🤝 Друзей в Mini App: <b>${invited}</b> — как только наберёшь нужное количество, билет за задание «рефералы» начислятся автоматически.`,
                ].join('\n'),
              ).catch(() => {})
              void checkAndAwardAuto({
                id: inviter.id,
                username: inviter.username ?? undefined,
                firstName: inviter.firstName ?? undefined,
                tgId: refTg,
              }).catch(() => {})
            }
          } else if (r.already) {
            // Уже приглашён — тихо приветствуем
            await botSendRich(msg.chat.id, [
              `👋 Привет! Продолжай в <b>Tg Swipe</b>:`,
              '',
              '📖 Открыть приложение → кнопка ниже.',
            ].join('\n'), {
              keyboard: [[{ label: 'Открыть Tg Swipe', emoji: '📖', url: TME_APP_URL, style: 'primary' }]],
            })
          }
          return NextResponse.json({ ok: true })
        }
      }
      await handleStart(msg.from, msg.chat?.id)
    }

    // ===== v5.46: РОЗЫГРЫШИ — команды, мастер, промокоды =====
    const chatId = msg?.chat?.id
    const fromId = msg?.from?.id ?? 0
    const isBotAdmin = fromId === BOT_OWNER_TG_ID

    // ===== v5.98: КОММАНДЫ МЕНЮ И КОММЕРЦИИ =====
    if (msg?.text && chatId && fromId > 0) {
      const t = msg.text
      const userLite = { id: fromId, username: msg.from?.username, first_name: msg.from?.first_name }
      if (/^\/help(@\w+)?$/i.test(t)) {
        await sendHelpMenu(chatId, isBotAdmin || adminTgIdSet.has(String(fromId)))
        return NextResponse.json({ ok: true })
      }
      if (/^\/promo(@\w+)?$/i.test(t)) {
        await sendPromoHint(chatId)
        return NextResponse.json({ ok: true })
      }
      if (/^\/tickets(@\w+)?$/i.test(t)) {
        await sendTicketsStatus(chatId, `tg_${fromId}`)
        return NextResponse.json({ ok: true })
      }
      if (/^\/sponsor(@\w+)?$/i.test(t)) {
        await startSponsorFlow(chatId, userLite)
        return NextResponse.json({ ok: true })
      }
      if (/^\/ad(@\w+)?$/i.test(t)) {
        await startAdFlow(chatId)
        return NextResponse.json({ ok: true })
      }
      if (/^\/send(@\w+)?$/i.test(t)) {
        if (isBotAdmin || adminTgIdSet.has(String(fromId))) {
          await startSendFlow(chatId)
        } else {
          await botSendRich(chatId, '🚫 Рассылка доступна только создателям Snap Team.')
        }
        return NextResponse.json({ ok: true })
      }
    }

    // ===== v5.98: FSM ДИАЛОГИ — форвард канала (спонсорство) ДО общих пересылок =====
    if (msg && chatId && fromId > 0 && (msg.forward_origin || msg.forward_from_chat || msg.forward_from)) {
      const fsmAbsorbed = await handleFsmForward(
        msg as { forward_from_chat?: { username?: string; title?: string; type?: string } },
        chatId,
        { id: fromId, username: msg.from?.username, first_name: msg.from?.first_name },
      ).catch((e) => {
        console.error('[bot/webhook] fsm forward', e)
        return false
      })
      if (fsmAbsorbed) return NextResponse.json({ ok: true })
    }

    // ===== v5.50: ИСТОЧНИКИ РЕКОМЕНДАЦИЙ («В один клик») =====
    // ЛОВИМ ДО мастера/промокода: текст пересланного поста — это контент,
    // а не команда или промокод. Пересылки юзера (не канала) проходят дальше.
    if (
      msg &&
      chatId &&
      fromId > 0 &&
      (msg.forward_origin || msg.forward_from_chat || msg.forward_from)
    ) {
      const absorbed = await handleForwardSources(msg, msg.from!, chatId).catch((e) => {
        console.error('[bot/webhook] forward-sources', e)
        return false
      })
      if (absorbed) {
        if (msg.entities?.length || msg.caption_entities?.length) {
          void handleCustomEmojiCapture(msg).catch(() => {})
        }
        return NextResponse.json({ ok: true })
      }
    }
    if (msg?.text && chatId && /^\/newgw(@\w+)?$/i.test(msg.text)) {
      await startGiveawayWizard(chatId, isBotAdmin)
      return NextResponse.json({ ok: true })
    }
    if (msg?.text && chatId && /^\/mygw(@\w+)?$/i.test(msg.text)) {
      if (fromId > 0) await sendMyGiveawayCard(chatId, `tg_${fromId}`)
      return NextResponse.json({ ok: true })
    }
    // v5.98: FSM — фото в диалоге рекламы (контент слота)
    if (msg?.photo?.length && chatId && fromId > 0) {
      const fsmAbsorbed = await handleFsmPhoto(msg, chatId, {
        id: fromId,
        username: msg.from?.username,
        first_name: msg.from?.first_name,
      }).catch((e) => {
        console.error('[bot/webhook] fsm photo', e)
        return false
      })
      if (fsmAbsorbed) return NextResponse.json({ ok: true })
    }
    // Мастер: фото (шаг «картинка поста»)
    if (msg?.photo?.length && chatId) {
      const absorbed = await handleWizardPhoto(chatId, msg.photo).catch(() => false)
      if (absorbed) return NextResponse.json({ ok: true })
    }
    // v5.98: FSM — текстовые шаги диалогов (реклама/спонсорство/рассылка)
    if (msg && chatId && fromId > 0 && (msg.text != null || msg.caption != null || msg.photo?.length)) {
      const fsmAbsorbed = await handleFsmText(
        msg as { text?: string; caption?: string; photo?: unknown[] },
        chatId,
        { id: fromId, username: msg.from?.username, first_name: msg.from?.first_name },
      ).catch((e) => {
        console.error('[bot/webhook] fsm text', e)
        return false
      })
      if (fsmAbsorbed && msg) {
        if (msg.entities?.length || msg.caption_entities?.length) {
          void handleCustomEmojiCapture(msg).catch(() => {})
        }
        return NextResponse.json({ ok: true })
      }
    }
    // Мастер: текстовые ответы (только владелец-админ в диалоге)
    if (msg?.text && chatId && isBotAdmin) {
      const absorbed = await handleWizardText(chatId, fromId, msg.text, isBotAdmin).catch((e) => {
        console.error('[bot/webhook] wizard text', e)
        return false
      })
      if (absorbed) {
        // Захват эмодзи всё равно делаем (пусть копится библиотека)
        if (msg.entities?.length || msg.caption_entities?.length) {
          void handleCustomEmojiCapture(msg).catch(() => {})
        }
        return NextResponse.json({ ok: true })
      }
    }
    // Промокод розыгрыша: юзер просто пишет код боту
    if (msg?.text && chatId && fromId > 0 && !msg.text.startsWith('/')) {
      const hit = await tryRedeemPromoText(
        chatId,
        `tg_${fromId}`,
        msg.from?.username,
        msg.from?.first_name,
        fromId,
        msg.text,
      ).catch((e) => {
        console.error('[bot/webhook] promo', e)
        return false
      })
      if (hit) return NextResponse.json({ ok: true })
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
