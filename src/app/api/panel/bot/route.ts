import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, externalOrigin, readJson } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'
import { logAdmin } from '@/lib/admin-log'
import {
  DEFAULT_SLOTS,
  botSendRich,
  ensureSeeded,
  forgetCapturedEmoji,
  getBusinessConnection,
  invalidateSlotsCache,
  listCapturedEmoji,
  markSlotCleared,
  premiumText,
  setBusinessConnection,
} from '@/lib/tg-emoji'
import { getCustomEmojiStickers } from '@/lib/tg-bot'

export const dynamic = 'force-dynamic'

/**
 * Панель: ПРЕМИУМ-ЭМОДЗИ БОТА + BUSINESS-ПОДКЛЮЧЕНИЕ (v5.23).
 *
 * GET  → статус business-connection, слоты эмодзи (emoji + custom_emoji_id),
 *        captured — эмодзи, захваченные из сообщений пользователей.
 * POST { action:'slot', slot, customEmojiId } — задать/очистить ID слота
 *        (ID проверяется через getCustomEmojiStickers).
 * POST { action:'adopt', slot, customEmojiId, emoji } — взять захваченный ID в
 *        слот (обновляет и юникод-эмодзи слота — premiumText ищет по символу).
 * POST { action:'forget', customEmojiId } — удалить запись из захваченных.
 * POST { action:'test', chatId? } — тестовое сообщение с текущими слотами
 *        (по умолчанию — чат владельца 7851246214), в ответе — каким каналом
 *        ушло: business / bot_premium / bot_plain.
 * POST { action:'richprobe' } — проба нового Bot API sendRichMessage (rich HTML:
 *        заголовок + styled-кнопки + кастом-эмодзи ВНУТРИ кнопки); ответ —
 *        сырой результат Telegram.
 * POST { action:'business', id? } — вручную задать/сбросить business_connection_id
 *        (обычно он приходит сам вебхуком при подключении чат-бота в настройках).
 * POST { action:'setwebhook' } — перерегистрировать вебхук с правильными
 *        allowed_updates (+business_connection). Ответ содержит сырой результат
 *        setWebhook + getWebhookInfo — видно реальную ошибку, если есть.
 */

const OWNER_TG_ID = 7851246214
/** t.me deep link на мини-апп бота */
const TME_APP_URL = 'https://t.me/tgswipe_bot/tgswipe'

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('slot'),
    slot: z.string().min(1).max(40),
    customEmojiId: z.string().max(64).default(''),
  }),
  z.object({
    action: z.literal('adopt'),
    slot: z.string().min(1).max(40),
    customEmojiId: z.string().min(1).max(64),
    emoji: z.string().min(1).max(32),
  }),
  z.object({
    action: z.literal('forget'),
    customEmojiId: z.string().min(1).max(64),
  }),
  z.object({
    action: z.literal('test'),
    chatId: z.number().int().optional(),
  }),
  z.object({
    action: z.literal('richprobe'),
  }),
  z.object({
    action: z.literal('business'),
    id: z.string().max(80).optional().nullable(),
  }),
  z.object({
    action: z.literal('setwebhook'),
  }),
  z.object({
    action: z.literal('getbc'),
  }),
])

export async function GET(request: Request) {
  const g = guardAdmin(request)
  if (!g.ok) return g.res

  try {
    // Сидируем недостающие слоты + заполняем пустые ID из библиотеки по умолчанию
    await ensureSeeded().catch(() => {})
    const rows = await db.botEmoji.findMany({ orderBy: { slot: 'asc' } })

    const slots = DEFAULT_SLOTS.map((d) => {
      const row = rows.find((r) => r.slot === d.slot)
      return {
        slot: d.slot,
        label: d.label,
        emoji: row?.emoji ?? d.emoji,
        customEmojiId: row?.customEmojiId ?? '',
      }
    })

    const business = await getBusinessConnection()
    const captured = await listCapturedEmoji().catch(() => [])
    return NextResponse.json({
      business,
      slots,
      captured,
      ownerChatId: OWNER_TG_ID,
      premiumCount: slots.filter((s) => s.customEmojiId).length,
    })
  } catch (e) {
    console.error('[panel/bot GET]', e)
    return err('bot config failed', 500)
  }
}

export async function POST(request: Request) {
  const g = guardAdmin(request)
  if (!g.ok) return g.res

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('Некорректные данные')
    const d = parsed.data

    /* ---------- Слот эмодзи ---------- */
    if (d.action === 'slot') {
      const def = DEFAULT_SLOTS.find((x) => x.slot === d.slot)
      if (!def) return err('Неизвестный слот')
      const id = d.customEmojiId.trim()
      if (id) {
        const info = await getCustomEmojiStickers([id])
        if (!info.get(id)) {
          return err('Telegram не знает такой custom_emoji_id — проверьте ID')
        }
      }
      await db.botEmoji.upsert({
        where: { slot: d.slot },
        create: { slot: d.slot, emoji: def.emoji, customEmojiId: id },
        update: { customEmojiId: id },
      })
      // Пустое значение = админ ОСОЗНАННО очистил слот — сид его не перезальёт
      await markSlotCleared(d.slot, id === '')
      invalidateSlotsCache()
      await logAdmin('bot_emoji', d.slot, { customEmojiId: id || null })
      return NextResponse.json({ ok: true })
    }

    /* ---------- Взять захваченный ID в слот (обновляет и символ эмодзи) ---------- */
    if (d.action === 'adopt') {
      const def = DEFAULT_SLOTS.find((x) => x.slot === d.slot)
      if (!def) return err('Неизвестный слот')
      const info = await getCustomEmojiStickers([d.customEmojiId])
      if (!info.get(d.customEmojiId)) {
        return err('Telegram не знает такой custom_emoji_id — проверьте ID')
      }
      const emoji = d.emoji.trim()
      if (!emoji || emoji.length > 32) return err('Некорректный символ эмодзи')
      await db.botEmoji.upsert({
        where: { slot: d.slot },
        create: { slot: d.slot, emoji, customEmojiId: d.customEmojiId },
        update: { emoji, customEmojiId: d.customEmojiId },
      })
      await markSlotCleared(d.slot, false)
      invalidateSlotsCache()
      await logAdmin('bot_emoji_adopt', d.slot, { customEmojiId: d.customEmojiId, emoji })
      return NextResponse.json({ ok: true })
    }

    /* ---------- Удалить запись из захваченных ---------- */
    if (d.action === 'forget') {
      await forgetCapturedEmoji(d.customEmojiId)
      await logAdmin('bot_emoji_forget', d.customEmojiId)
      return NextResponse.json({ ok: true })
    }

    /* ---------- Тестовая отправка ---------- */
    if (d.action === 'test') {
      const chatId = d.chatId ?? OWNER_TG_ID
      const slots = await db.botEmoji.findMany()
      const filled = slots.filter((s) => s.customEmojiId)
      const preview =
        '🧪 <b>Тест премиум-эмодзи Tg Swipe</b>\n\n' +
        (filled.length > 0
          ? filled.slice(0, 8).map((s) => s.emoji).join(' ') + '\n\n'
          : 'Слоты не заполнены — сообщение уйдёт обычными эмодзи.\n\n') +
        'Если выше видны анимированные эмодзи — премиум-канал работает!'
      const wrapped = await premiumText(preview)
      const r = await botSendRich(chatId, wrapped, { skipPremiumWrap: true })
      if (!r.ok) return err(r.error ?? 'Не удалось отправить тест')
      await logAdmin('bot_test', String(chatId), { via: r.via })

      // Диагностика: если бизнес-канал не сработал — сырой запрос БЕЗ клавиатуры,
      // чтобы увидеть настоящую ошибку Telegram (клавиатура / соединение / чат)
      let diag: { attempt?: unknown; note?: string } | undefined
      if (r.via !== 'business') {
        const bc = await getBusinessConnection().catch(() => null)
        const token = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? ''
        if (bc?.isEnabled && bc.id && token) {
          const attempt = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: '🔎 Диагностика business-канала Tg Swipe (без клавиатуры)',
              business_connection_id: bc.id,
            }),
            signal: AbortSignal.timeout(10_000),
          })
            .then((x) => x.json() as Promise<unknown>)
            .catch((e) => ({ ok: false, description: String((e as Error)?.message ?? e) }))
          diag = { attempt, note: 'raw sendMessage через business_connection_id, без reply_markup и parse_mode' }
        } else {
          diag = { note: `business-connection неактивен: ${JSON.stringify(bc)}` }
        }
      }

      return NextResponse.json({
        ok: true,
        via: r.via,
        businessError: r.businessError ?? null,
        premiumError: r.premiumError ?? null,
        diag: diag ?? null,
      })
    }

    /* ---------- Проба нового Bot API: sendRichMessage (styled-кнопки + эмодзи в кнопках) ---------- */
    if (d.action === 'richprobe') {
      const token = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? ''
      if (!token) return err('TELEGRAM_BOT_TOKEN не задан на сервере', 500)
      const chatId = OWNER_TG_ID
      // Rich HTML: заголовок + строка текста + кнопки со стилями,
      // во второй кнопке — кастом-эмодзи ВНУТРИ текста кнопки
      const fire = await premiumText('🔥')
      const rocket = await premiumText('🚀')
      const html =
        `<h3>🧪 Rich-проба Tg Swipe</h3>` +
        `<p>Кнопки в стилях Telegram + премиум-эмодзи внутри кнопки.</p>` +
        `<tg-button-row align="left">` +
        `<tg-button type="url" style="success" url="${TME_APP_URL}">${rocket} Открыть Swipe</tg-button>` +
        `<tg-button type="url" style="link" url="https://t.me/SnapTeamDev">${fire} Наш канал</tg-button>` +
        `</tg-button-row>`
      const raw = await fetch(`https://api.telegram.org/bot${token}/sendRichMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, rich_message: { html } }),
        signal: AbortSignal.timeout(10_000),
      })
        .then((x) => x.json() as Promise<unknown>)
        .catch((e) => ({ ok: false, description: String((e as Error)?.message ?? e) }))
      await logAdmin('bot_richprobe', String(chatId))
      return NextResponse.json({ ok: true, raw })
    }

    /* ---------- Перерегистрация вебхука (вручную) ---------- */
    if (d.action === 'setwebhook') {
      const token = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? ''
      if (!token) return err('TELEGRAM_BOT_TOKEN не задан на сервере', 500)
      const origin = process.env.NEXT_PUBLIC_APP_URL?.trim() || externalOrigin(request)
      const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim()
      const set = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: `${origin}/api/bot/webhook`,
          ...(secret ? { secret_token: secret } : {}),
          allowed_updates: ['message', 'callback_query', 'business_connection'],
          max_connections: 40,
        }),
        signal: AbortSignal.timeout(10_000),
      })
        .then((r) => r.json() as Promise<{ ok?: boolean; description?: string; result?: unknown }>)
        .catch((e) => ({ ok: false, description: String((e as Error)?.message ?? e) }))
      const info = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
        signal: AbortSignal.timeout(10_000),
      })
        .then((r) => r.json() as Promise<{ ok?: boolean; result?: Record<string, unknown> }>)
        .catch(() => null)
      if (set.ok) {
        const now = new Date().toISOString()
        // Тот же флаг, что и у самолечения в вебхуке — чтобы не дублировал
        await db.botSetting
          .upsert({ where: { key: 'webhook_selfheal_v1' }, create: { key: 'webhook_selfheal_v1', value: now }, update: { value: now } })
          .catch(() => {})
      }
      await logAdmin('bot_setwebhook', origin, { ok: set.ok === true })
      return NextResponse.json({ ok: set.ok === true, origin, setWebhook: set, webhookInfo: info?.result ?? null })
    }

    /* ---------- Business-connection: официальная проверка у Telegram ---------- */
    if (d.action === 'getbc') {
      const bc = await getBusinessConnection().catch(() => null)
      const token = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? ''
      if (!bc?.id || !token) {
        return NextResponse.json({ ok: true, stored: bc, telegram: null, note: 'нет сохранённого подключения или токена' })
      }
      const telegram = await fetch(`https://api.telegram.org/bot${token}/getBusinessConnection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_connection_id: bc.id }),
        signal: AbortSignal.timeout(10_000),
      })
        .then((x) => x.json() as Promise<unknown>)
        .catch((e) => ({ ok: false, description: String((e as Error)?.message ?? e) }))
      return NextResponse.json({ ok: true, stored: bc, telegram })
    }

    /* ---------- Business-connection вручную ---------- */
    const id = (d.id ?? '').trim()
    await setBusinessConnection(
      id ? { id, userId: OWNER_TG_ID, isEnabled: true } : { id: '', userId: OWNER_TG_ID, isEnabled: false },
    )
    await logAdmin('bot_business', id || 'reset')
    return NextResponse.json({ ok: true, business: await getBusinessConnection() })
  } catch (e) {
    console.error('[panel/bot POST]', e)
    return err('bot action failed', 500)
  }
}
