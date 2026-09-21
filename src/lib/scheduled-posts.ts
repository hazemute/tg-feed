import { db } from '@/lib/db'
import { botPublishToChannel } from '@/lib/tg-bot'

/**
 * ОТЛОЖЕННЫЕ ПОСТЫ (v5.64, Snap Ассистент): «опубликуй завтра в 18:00».
 *
 * Очередь ScheduledPost. Публикация — свипом: владелец открывает вкладку
 * «Канал» (или приходит дневной тик парсера) → из-за срока вышедшие посты
 * уходят в Telegram через бота и попадают в ленту Tg Swipe (таблица Post).
 *
 * Ошибки не стопорят очередь: пост с ошибкой остаётся в очереди и ретраится
 * на следующем свипе, но не дольше 3 суток от времени публикации — потом
 * помечается отменённым (publishedAt ставится, error заполнен), чтобы не
 * копить вечных зомби.
 */

/** Сколько держать неудачные попытки в очереди */
const ERROR_TTL_MS = 3 * 24 * 3600 * 1000

export type SweepResult = { published: number; failed: number; expired: number }

/** Один проход по очереди: публикуем всё, чьё время наступило (пачка ≤ limit) */
export async function publishDueScheduledPosts(limit = 10): Promise<SweepResult> {
  const res: SweepResult = { published: 0, failed: 0, expired: 0 }
  let due: Array<{
    id: string
    text: string
    imageUrl: string | null
    scheduledAt: Date
    createdAt: Date
    channelId: string
    channel: { username: string }
  }> = []
  try {
    due = await db.scheduledPost.findMany({
      where: { publishedAt: null, scheduledAt: { lte: new Date() } },
      orderBy: { scheduledAt: 'asc' },
      take: limit,
      select: {
        id: true,
        text: true,
        imageUrl: true,
        scheduledAt: true,
        createdAt: true,
        channelId: true,
        channel: { select: { username: true } },
      },
    })
  } catch {
    return res // таблицы может не быть на холодной схеме — молча выходим
  }

  for (const sp of due) {
    // Просроченные ошибки (>3 суток) — снимаем с очереди как отменённые
    if (Date.now() - sp.scheduledAt.getTime() > ERROR_TTL_MS) {
      await db.scheduledPost
        .update({ where: { id: sp.id }, data: { publishedAt: new Date(), error: 'cancelled: too many failed attempts' } })
        .catch(() => {})
      res.expired++
      continue
    }

    const r = await botPublishToChannel(sp.channel.username, sp.text, sp.imageUrl).catch(
      () => ({ ok: false as const, error: 'Ошибка Bot API' }),
    )
    if (r.ok && r.link) {
      // messageId из ссылки t.me/<u>/<id> → добавляем пост в ленту Tg Swipe
      const messageId = Number(r.link.split('/').pop())
      const okPost =
        Number.isFinite(messageId) && messageId > 0
          ? await db.post
              .create({
                data: {
                  tgKey: `${sp.channel.username}:${messageId}`,
                  channelId: sp.channelId,
                  text: sp.text,
                  ...(sp.imageUrl ? { mediaUrl: sp.imageUrl, mediaType: 'image' } : { mediaType: 'none' }),
                  publishedAt: new Date(),
                },
              })
              .then(() => true)
              .catch(() => false) // дубликат tgKey — пост уже в ленте, не страшно
          : false
      await db.scheduledPost
        .update({ where: { id: sp.id }, data: { publishedAt: new Date(), link: r.link, error: okPost ? null : 'post skipped from feed (dup)' } })
        .catch(() => {})
      res.published++
    } else {
      await db.scheduledPost
        .update({ where: { id: sp.id }, data: { error: (r.error ?? 'unknown').slice(0, 300) } })
        .catch(() => {})
      res.failed++
    }
  }
  return res
}

/* --- Троттлинг «ленивого» свипа на горячих роутах владельца --- */

let lastSweepAt = 0
const SWEEP_MIN_INTERVAL_MS = 30_000

/**
 * Вызывается fire-and-forget из /api/mychannel и /api/parse/tick.
 * Не чаще раза в 30с на процесс; ошибки глотаются — основная работа не страдает.
 */
export function sweepScheduledPostsThrottled(): void {
  if (Date.now() - lastSweepAt < SWEEP_MIN_INTERVAL_MS) return
  lastSweepAt = Date.now()
  void publishDueScheduledPosts(5).catch(() => {})
}

/** Очередь канала для ассистента: предстоящие + последние опубликованные/ошибочные */
export async function scheduledQueueFor(channelId: string): Promise<string> {
  const [upcoming, recent] = await Promise.all([
    db.scheduledPost.findMany({
      where: { channelId, publishedAt: null },
      orderBy: { scheduledAt: 'asc' },
      take: 10,
      select: { id: true, text: true, scheduledAt: true, error: true },
    }),
    db.scheduledPost.findMany({
      where: { channelId, publishedAt: { not: null } },
      orderBy: { publishedAt: 'desc' },
      take: 5,
      select: { text: true, scheduledAt: true, publishedAt: true, link: true, error: true },
    }),
  ])
  const fmt = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
  const lines: string[] = []
  if (upcoming.length === 0) lines.push('Отложенных постов нет.')
  else {
    lines.push('В очереди (предстоящие):')
    for (const s of upcoming) {
      const preview = s.text.replace(/\s+/g, ' ').slice(0, 60)
      lines.push(`  · id=${s.id} | публикация ${fmt(s.scheduledAt)}${s.error ? ` | ошибка: ${s.error.slice(0, 80)}` : ''} — ${preview}`)
    }
  }
  if (recent.length > 0) {
    lines.push('Недавно отработанные:')
    for (const s of recent) {
      const preview = s.text.replace(/\s+/g, ' ').slice(0, 50)
      lines.push(`  · ${fmt(s.scheduledAt)} → ${s.publishedAt ? `опубликован (${s.link ?? 'ок'})` : `ОТМЕНЁН (${s.error ?? ''})`} — ${preview}`)
    }
  }
  return lines.join('\n')
}
