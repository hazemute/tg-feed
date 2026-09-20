import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { cronAuthorized, guardIp } from '@/lib/guard'
import { runParser, backfillCustomEmoji } from '@/lib/parse-engine'
import { notifyNewPosts } from '@/lib/tg-bot'
import { nextAdaptiveBatch, enrichMissingMedia, refreshChannelCards, refreshHotChannelStats, cardBatchSize } from '@/lib/parse-scheduler'
import { pruneAll } from '@/lib/retention'
import { checkDueGiveaways } from '@/lib/giveaways'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * POST|GET /api/parse/tick — ОДИН тик адаптивного шедулера (для cron-сервиса).
 *
 * Постоянное отслеживание новых постов с минимальным расходом: каждый тик
 * обрабатывает маленькую ротационную партию каналов (~6 + 2 «горячих»),
 * плюс доливает медиа паре постов без картинок (embed-бэкфилл).
 * Призывайте эндпоинт каждые 60–120 секунд — нагрузка постоянная и низкая,
 * свежие каналы опрашиваются чаще за счёт приоритетных слотов.
 * Авторизация: Authorization: Bearer $CRON_SECRET (как /api/parse).
 */
async function handle(request: Request) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const ip = guardIp(request, { limit: 60, windowMs: 60_000, bucket: 'cron-tick' })
  if (!ip.ok) return ip.res

  const started = Date.now()
  try {
    /* ---------- Ретроактивный бэкфилл реестра премиум-эмодзи (v5.26) ----------
        ИДЕТ ДО парсинга и независимо от него: пустая партия каналов не должна
        пропускать бэкфилл. ID из маркеров старых постов резолвятся без
        перепарсинга канала — иначе эмодзи остаются статичными до неизвестного
        момента. Троттлинг 25 мин через BotSetting: Bot API дёргается только
        за ID, которых ещё нет в реестре. */
    let emojiBackfill: { scanned: number; added: number } | null = null
    const BACKFILL_KEY = 'emoji_backfill_at'
    const BACKFILL_TTL_MS = 25 * 60_000
    try {
      const last = await db.botSetting.findUnique({ where: { key: BACKFILL_KEY } })
      const lastAt = last ? Date.parse(last.value) : 0
      if (Date.now() - lastAt > BACKFILL_TTL_MS && Date.now() - started < 90_000) {
        emojiBackfill = await backfillCustomEmoji()
        await db.botSetting
          .upsert({
            where: { key: BACKFILL_KEY },
            create: { key: BACKFILL_KEY, value: new Date().toISOString() },
            update: { value: new Date().toISOString() },
          })
          .catch(() => {})
        if (emojiBackfill.added > 0) console.log('[tick] emoji backfill:', emojiBackfill)
      }
    } catch (e) {
      console.error('[tick] emoji backfill failed', e)
    }

    const batch = await nextAdaptiveBatch()
    if (batch.length === 0) {
      return NextResponse.json({ ok: true, batch: 0, added: 0, enriched: 0, emojiBackfill })
    }

    // per=5 новых постов на канал, тайм-бюджет 35с — тик остаётся лёгким.
    // Бюджет сжат не случайно: после парсинга гарантированно должны успеть
    // обновиться карточки каналов (аватар/подписчики) — раньше порог 45с
    // при медленном t.me (~10-15с/канал) не оставлял им ни секунды, и
    // сотни каналов навсегда оставались без подписчиков/аватаров.
    const result = await runParser(5, undefined, batch.length, Date.now() + 35_000, 1, batch)

    let notified = { sent: 0, failed: 0, recipients: 0 }
    try {
      notified = await notifyNewPosts(result.newPosts)
    } catch (e) {
      console.error('[tick] notify failed', e)
    }

    // v5.49: ЖИВАЯ статистика подписчиков (fast lane) — до 6 популярных каналов
    // за тик обновляют membersCount через лёгкий getChatMemberCount. Идёт ДО
    // карточек: подписчики важнее аватарок, а бюджет Bot API у fast lane свой
    // (1 лёгкий вызов/канал; 429 останавливает обе партии через markBotBan)
    let stats: { refreshed: number; skipped: boolean } = { refreshed: 0, skipped: true }
    try {
      stats = await refreshHotChannelStats()
    } catch (e) {
      console.error('[tick] stats failed', e)
    }

    // карточки каналов (аватар + подписчики через Bot API) — ГАРАНТИРОВАННЫЙ
    // слот сразу после парсинга. Размер партии АДАПТИВНЫЙ (cardBatchSize):
    // после флуд-бана начинается с 2 каналов и растёт на +2 за спокойный тик
    // (кап 12) — burst после бана мгновенно возвращал наказание, делая его вечным.
    let cards = { refreshed: 0, scanned: 0 }
    if (Date.now() - started < 70_000) {
      try {
        cards = await refreshChannelCards(cardBatchSize())
      } catch (e) {
        console.error('[tick] cards failed', e)
      }
    }

    // бэкфилл медиа — только если ещё остался бюджет (самый нижний приоритет)
    let enriched = 0
    if (Date.now() - started < 85_000) {
      try {
        enriched = (await enrichMissingMedia()).enriched
      } catch (e) {
        console.error('[tick] enrich failed', e)
      }
    }

    // Ретеншен лог-таблиц: троттлинг 19ч + Redis-лок — на каждом тике почти
    // бесплатен (мгновенный skipped), раз в сутки реально подрезает журналы
    const pruned = await pruneAll().catch(() => null)

    // Розыгрыши: публикация запланированных + итоги просроченных (страховка,
    // если у бота не было трафика — вебхук дергает планировщик лениво)
    const giveaways = await checkDueGiveaways().catch(() => null)

    return NextResponse.json({
      ok: true,
      batch: batch.length,
      added: result.newPosts.length,
      truncated: result.truncated ?? false,
      enriched,
      stats,
      cards,
      notified,
      emojiBackfill,
      pruned,
      giveaways,
      ms: Date.now() - started,
    })
  } catch (e) {
    console.error('[tick]', e)
    return NextResponse.json({ error: 'tick failed' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  return handle(request)
}

export async function GET(request: Request) {
  return handle(request)
}
