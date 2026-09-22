import { db } from '@/lib/db'
import { botPublishToChannel } from '@/lib/tg-bot'
import { escapeHtml } from '@/lib/tg-bot'
import { AD_CHANNEL } from '@/lib/commerce-wizard'

/**
 * АВТОПУБЛИКАЦИЯ РЕКЛАМНОГО КАЛЕНДАРЯ (v5.98).
 *
 * Слоты со status='PAID' публикуются в канал @SnapTeamDev (AD_CHANNEL) в момент
 * runAt (дата + 12:00/18:00 МСК — мгновенно вычислен при оплате и хранится в
 * UTC). Вызывается из общего тика (/api/parse/tick) и из standalone-роута
 * /api/ads/publish-tick (для крона). Тик приходит каждую минуту — пост выходит
 * с задержкой ≤1 мин от назначенного времени.
 *
 * Идемпотентность: PAID → PUBLISHED — атомарный updateMany по status.
 */

export type AdPublishResult = { published: number; failed: number; skipped: number }

export async function publishDueAdSlots(now: Date = new Date()): Promise<AdPublishResult> {
  const due = await db.adSlot
    .findMany({
      where: { status: 'PAID', runAt: { lte: now } },
      orderBy: { runAt: 'asc' },
      take: 10,
      select: { id: true, text: true, imageUrl: true, link: true },
    })
    .catch(() => [])
  if (due.length === 0) return { published: 0, failed: 0, skipped: 0 }

  let published = 0
  let failed = 0
  let skipped = 0

  for (const slot of due) {
    // Атомарный захват слота: параллельный инстанс не опубликует второй раз
    const claimed = await db.adSlot.updateMany({
      where: { id: slot.id, status: 'PAID' },
      data: { status: 'PUBLISHED' },
    })
    if (claimed.count === 0) {
      skipped++
      continue
    }
    // Кнопка-ссылка под постом (необязательная) — через entities кнопки Bot API
    // botPublishToChannel умеет текст+фото; кнопку прикладываем отдельным звеном:
    // публикация с reply-клавиатурой недоступна в канале, поэтому ссылку пишем
    // отдельной строкой, если она есть.
    const text = slot.text.trim()
    const footer = slot.link ? `\n\n🔗 ${slot.link}` : ''
    const post = `${escapeHtml(text).slice(0, 3500)}${escapeHtml(footer)}`
    const r = await botPublishToChannel(AD_CHANNEL, post, slot.imageUrl)
    if (r.ok && r.link) {
      // message id из ссылки t.me/<channel>/<id>
      const m = r.link.match(/\/(\d+)\s*$/)
      if (m) {
        await db.adSlot
          .update({ where: { id: slot.id }, data: { publishedMessageId: Number(m[1]) } })
          .catch(() => {})
      }
      published++
    } else {
      // Публикация не прошла (бот не админ / 429) — вернуть в PAID, крон повторит
      await db.adSlot.updateMany({ where: { id: slot.id, status: 'PUBLISHED' }, data: { status: 'PAID' } })
      failed++
      console.error('[ad-slots] publish failed', slot.id, r.error)
    }
  }
  return { published, failed, skipped }
}
