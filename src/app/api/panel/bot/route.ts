import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'
import { logAdmin } from '@/lib/admin-log'
import {
  DEFAULT_SLOTS,
  botSendRich,
  getBusinessConnection,
  invalidateSlotsCache,
  premiumText,
  setBusinessConnection,
} from '@/lib/tg-emoji'
import { getCustomEmojiStickers } from '@/lib/tg-bot'

export const dynamic = 'force-dynamic'

/**
 * Панель: ПРЕМИУМ-ЭМОДЗИ БОТА + BUSINESS-ПОДКЛЮЧЕНИЕ (v5.22).
 *
 * GET  → статус business-connection, слоты эмодзи (emoji + custom_emoji_id).
 * POST { action:'slot', slot, customEmojiId } — задать/очистить ID слота
 *        (ID проверяется через getCustomEmojiStickers).
 * POST { action:'test', chatId? } — тестовое сообщение с текущими слотами
 *        (по умолчанию — чат владельца 7851246214), в ответе — каким каналом
 *        ушло: business / bot_premium / bot_plain.
 * POST { action:'business', id? } — вручную задать/сбросить business_connection_id
 *        (обычно он приходит сам вебхуком при подключении чат-бота в настройках).
 */

const OWNER_TG_ID = 7851246214

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('slot'),
    slot: z.string().min(1).max(40),
    customEmojiId: z.string().max(64).default(''),
  }),
  z.object({
    action: z.literal('test'),
    chatId: z.number().int().optional(),
  }),
  z.object({
    action: z.literal('business'),
    id: z.string().max(80).optional().nullable(),
  }),
])

export async function GET(request: Request) {
  const g = guardAdmin(request)
  if (!g.ok) return g.res

  try {
    // Сидируем недостающие слоты
    const rows = await db.botEmoji.findMany({ orderBy: { slot: 'asc' } })
    const have = new Set(rows.map((r) => r.slot))
    const missing = DEFAULT_SLOTS.filter((d) => !have.has(d.slot))
    if (missing.length > 0) {
      await db.botEmoji
        .createMany({ data: missing.map((d) => ({ slot: d.slot, emoji: d.emoji, customEmojiId: '' })) })
        .catch(() => {})
      rows.push(...missing.map((d) => ({ slot: d.slot, emoji: d.emoji, customEmojiId: '', updatedAt: new Date() })))
    }

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
    return NextResponse.json({
      business,
      slots,
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
      invalidateSlotsCache()
      await logAdmin('bot_emoji', d.slot, { customEmojiId: id || null })
      return NextResponse.json({ ok: true })
    }

    /* ---------- Тестовая отправка ---------- */
    if (d.action === 'test') {
      const chatId = d.chatId ?? OWNER_TG_ID
      const slots = await db.botEmoji.findMany()
      const filled = slots.filter((s) => s.customEmojiId)
      const preview =
        '🧪 <b>Тест премиум-эмодзи Snap</b>\n\n' +
        (filled.length > 0
          ? filled.slice(0, 8).map((s) => s.emoji).join(' ') + '\n\n'
          : 'Слоты не заполнены — сообщение уйдёт обычными эмодзи.\n\n') +
        'Если выше видны анимированные эмодзи — премиум-канал работает!'
      const wrapped = await premiumText(preview)
      const r = await botSendRich(chatId, wrapped, { skipPremiumWrap: true })
      if (!r.ok) return err(r.error ?? 'Не удалось отправить тест')
      await logAdmin('bot_test', String(chatId), { via: r.via })
      return NextResponse.json({ ok: true, via: r.via })
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
