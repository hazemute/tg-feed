import { NextResponse } from 'next/server'
import { err, readJson } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'
import { logAdmin } from '@/lib/admin-log'
import { botBroadcastAudience } from '@/lib/bot-audience'

export const dynamic = 'force-dynamic'

/**
 * v6.6: РАССЫЛКА ПО ВСЕЙ АУДИТОРИИ БОТА (вкладка «Рассылка» панели).
 *
 * GET  /api/panel/broadcast[?withIds=1]
 *   — статистика аудитории: юзеры миниаппа ∪ бот-юзеры (BotUser + botlang),
 *     забаненные исключены. ?withIds=1 отдаёт и сам список chat_id — UI шлёт
 *     рассылку чанками, показывая живой прогресс.
 *
 * POST /api/panel/broadcast
 *   { text, link?, dryRun? }                     → превью/валидация без отправки
 *   { text, link?, testChatId }                  → тест-отправка одному чату
 *   { text, link?, ids: string[] (≤300) }        → отправка чанка (ids обязаны
 *                                                  входить в аудиторию)
 * Текст — ПЛАЙНТЕКСТ: сервер сам экранирует HTML (паритет с /send в боте).
 * Скорость: подблоки по 30 сообщений с паузой 1с (лимит Telegram ~30 msg/s),
 * 429 → пауза retry_after. Каждый чанк пишется в AdminLog (Журнал → «Рассылка»).
 */

const MAX_TEXT = 3500 // как в /send — Telegram режет сообщение на 4096
const CHUNK_PER_REQUEST = 300
const SUB_BATCH = 30
const SUB_BATCH_PAUSE_MS = 1000

type TgResult = { ok: boolean; result?: unknown; description?: string }

/** Прямой вызов Bot API — тот же паттерн, что в commerce-wizard (/send). */
async function tgApi(method: string, body: Record<string, unknown>): Promise<TgResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  if (!token) return { ok: false, description: 'TELEGRAM_BOT_TOKEN не задан' }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; result?: unknown; description?: string }
      | null
    if (data?.ok) return { ok: true, result: data.result }
    return { ok: false, description: data?.description ?? `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, description: String((e as Error)?.message ?? e) }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Валидация текста/ссылки → { html, link } | строка-ошибка */
function validatePayload(raw: { text?: unknown; link?: unknown }): { html: string; link: string } | string {
  const text = typeof raw.text === 'string' ? raw.text.trim() : ''
  if (!text) return 'Текст рассылки пуст'
  if (text.length > MAX_TEXT) return `Текст слишком длинный: ${text.length} > ${MAX_TEXT} символов`
  const link = typeof raw.link === 'string' ? raw.link.trim() : ''
  if (link && !/^https?:\/\/\S+$/i.test(link)) return 'Ссылка должна начинаться с http(s)://'
  return { html: escapeHtml(text), link }
}

/** Последовательная отправка пачке chat_id с уважением к 429 */
async function sendMany(
  chatIds: string[],
  html: string,
  link: string,
): Promise<{ sent: number; failed: number; errors: Array<{ id: string; error: string }> }> {
  const markup = link ? { inline_keyboard: [[{ text: '👉 Открыть', url: link }]] } : undefined
  let sent = 0
  let failed = 0
  const errors: Array<{ id: string; error: string }> = []

  for (let i = 0; i < chatIds.length; i += SUB_BATCH) {
    const batch = chatIds.slice(i, i + SUB_BATCH)
    const results = await Promise.all(
      batch.map(async (id) => {
        const r = await tgApi('sendMessage', {
          chat_id: Number(id),
          text: html,
          parse_mode: 'HTML',
          disable_web_page_preview: false,
          ...(markup ? { reply_markup: markup } : {}),
        })
        return { id, r }
      }),
    )
    let retryAfterSec = 0
    for (const { id, r } of results) {
      if (r.ok) {
        sent++
      } else {
        failed++
        if (errors.length < 40) errors.push({ id, error: (r.description ?? 'unknown').slice(0, 160) })
        const m = /retry after (\d+)/i.exec(r.description ?? '')
        if (m) retryAfterSec = Math.max(retryAfterSec, Number(m[1]))
      }
    }
    // 429 в пачке — уважим retry_after, чтобы не продлевать бан
    if (retryAfterSec > 0) {
      await new Promise((res) => setTimeout(res, Math.min(retryAfterSec + 1, 30) * 1000))
    } else if (i + SUB_BATCH < chatIds.length) {
      await new Promise((res) => setTimeout(res, SUB_BATCH_PAUSE_MS))
    }
  }
  return { sent, failed, errors }
}

export async function GET(request: Request) {
  const g = guardAdmin(request, { limit: 120, windowMs: 60_000, bucket: 'panel-broadcast' })
  if (!g.ok) return g.res

  try {
    const url = new URL(request.url)
    const withIds = url.searchParams.get('withIds') === '1'
    const audience = await botBroadcastAudience()
    return NextResponse.json({
      ok: true,
      stats: {
        total: audience.ids.length,
        app: audience.appCount,
        botOnly: audience.botOnlyCount,
        banned: audience.bannedCount,
      },
      ...(withIds ? { ids: audience.ids } : {}),
    })
  } catch (e) {
    console.error('[panel/broadcast GET]', e)
    return err('Не удалось посчитать аудиторию', 500)
  }
}

type BroadcastBody = {
  text?: unknown
  link?: unknown
  ids?: unknown
  testChatId?: unknown
  dryRun?: unknown
}

export async function POST(request: Request) {
  const g = guardAdmin(request, { limit: 30, windowMs: 60_000, bucket: 'panel-broadcast-post' })
  if (!g.ok) return g.res

  const body = await readJson<BroadcastBody>(request)
  if (!body || typeof body !== 'object') {
    return err('Некорректный JSON', 400)
  }

  const v = validatePayload(body)
  if (typeof v === 'string') return err(v, 400)
  const { html, link } = v
  const dryRun = body.dryRun === true

  try {
    const audience = await botBroadcastAudience()

    // ---------- dryRun: только превью, никаких вызовов Bot API ----------
    if (dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        html,
        wouldSend: audience.ids.length,
        stats: { total: audience.ids.length, app: audience.appCount, botOnly: audience.botOnlyCount },
      })
    }

    // ---------- тест-отправка одному чату ----------
    const testRaw = typeof body.testChatId === 'string' ? body.testChatId.trim() : ''
    if (testRaw) {
      if (!/^\d{3,}$/.test(testRaw)) return err('testChatId должен быть числом', 400)
      const r = await tgApi('sendMessage', {
        chat_id: Number(testRaw),
        text: html,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
        ...(link ? { reply_markup: { inline_keyboard: [[{ text: '👉 Открыть', url: link }]] } } : {}),
      })
      await logAdmin('broadcast', r.ok ? `test:${testRaw}` : `test-fail:${testRaw}`, {
        link: link || null,
        error: r.ok ? null : (r.description ?? '').slice(0, 200),
        preview: html.slice(0, 120),
      })
      return NextResponse.json({
        ok: r.ok,
        test: true,
        error: r.ok ? null : (r.description ?? 'Ошибка Telegram'),
      })
    }

    // ---------- чанк массовой отправки ----------
    const rawIds = Array.isArray(body.ids) ? body.ids : []
    if (rawIds.length === 0) {
      return err('Не передан список получателей (ids)', 400)
    }
    if (rawIds.length > CHUNK_PER_REQUEST) {
      return err(`Максимум ${CHUNK_PER_REQUEST} получателей за запрос`, 400)
    }
    const requested = [...new Set(rawIds.filter((x): x is string => typeof x === 'string' && /^\d{3,}$/.test(x)))]
    if (requested.length === 0) {
      return err('В ids нет валидных chat_id', 400)
    }
    // Отправляем ТОЛЬКО тем, кто реально в аудитории (защита от подмены списка)
    const audienceSet = new Set(audience.ids)
    const targets = requested.filter((id) => audienceSet.has(id))
    if (targets.length === 0) {
      return err('Ни один id не входит в текущую аудиторию', 400)
    }

    const { sent, failed, errors } = await sendMany(targets, html, link)
    await logAdmin('broadcast', `chunk ${sent}+${failed}`, {
      chunkSize: targets.length,
      audience: audience.ids.length,
      link: link || null,
      errors: errors.slice(0, 10),
      preview: html.slice(0, 120),
    })
    return NextResponse.json({ ok: true, sent, failed, errors })
  } catch (e) {
    console.error('[panel/broadcast POST]', e)
    return err('Рассылка не выполнена', 500)
  }
}
