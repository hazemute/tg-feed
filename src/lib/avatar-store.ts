import { createHash } from 'node:crypto'
import { db } from '@/lib/db'

/**
 * Аватарки каналов — ПРЯМЫЕ ССЫЛКИ Telegram CDN (v5.56).
 *
 * ИСТОРИЯ: раньше байты аватарок заливались в Supabase Storage (og:image →
 * upload → вечная ссылка). Лето 2026: Supabase-проект с бакетом ЛЁГ/УДАЛЁН —
 * DNS хоста storage отдаёт NXDOMAIN по всему миру, /api/media отвечал 502,
 * у каналов вместо фото — серые инициалы.
 *
 * РЕШЕНИЕ: больше никакой внешней зависимости. Каждая страница t.me/s/<username>,
 * которую парсер И ТАК качает каждый тик, содержит og:image — прямую ссылку на
 * аватарку в CDN Telegram (cdn*.telesco.pe). Сохраняем САМУ ССЫЛКУ в
 * Channel.avatarUrl: dto заворачивает её в /api/media (Vercel CDN кэш 30 дней),
 * прокси отдаёт файл — проверено 200 OK. Бот API остаётся фолбэком (photoFileId).
 *
 * Контроль изменений по sha1 ССЫЛКИ: одна и та же аватарка не дёргает БД
 * повторно (круг парсера ~1-2 часа). Ссылка Telegram меняется при смене
 * аватарки канала — тогда sha1 другой → обновляем.
 */

/** Извлекает og:image (аватар канала) из HTML страницы t.me/s/<username> */
export function ogAvatarOf(html: string): string | null {
  const m =
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/) ??
    html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/)
  if (!m) return null
  let url = m[1]
  if (url.startsWith('//')) url = `https:${url}`
  return url.startsWith('https://') ? url : null
}

export type AvatarSyncResult =
  | { status: 'ok'; changed: boolean }
  | { status: 'skipped' }
  | { status: 'error'; reason: string }

/** Нормализация ссылки для сравнения: без query (cdn добавляет ?...) */
function urlKey(url: string): string {
  return url.split('?')[0]
}

/**
 * Синхронизация аватарки канала из HTML страницы t.me/s: og:image → ссылка
 * Telegram CDN → Channel.avatarUrl. Вызывается парсером на каждом тике
 * (канал и так скачан); повторные круги дешёвые — при неизменной ссылке
 * только штамп времени. Ошибок сети почти нет: html уже скачан.
 */
export async function syncChannelAvatar(channelId: string, html: string): Promise<AvatarSyncResult> {
  const imageUrl = ogAvatarOf(html)
  if (!imageUrl) return { status: 'skipped' }

  try {
    const hash = createHash('sha1').update(urlKey(imageUrl)).digest('hex')

    const channel = await db.channel.findUnique({
      where: { id: channelId },
      select: { avatarHash: true, avatarUrl: true },
    })
    if (!channel) return { status: 'skipped' }
    if (channel.avatarHash === hash && channel.avatarUrl) {
      // ссылка не менялась — только освежаем штамп времени (дёшево)
      await db.channel
        .update({ where: { id: channelId }, data: { avatarFetchedAt: new Date() } })
        .catch(() => {})
      return { status: 'ok', changed: false }
    }

    await db.channel
      .update({
        where: { id: channelId },
        data: { avatarUrl: imageUrl, avatarHash: hash, avatarFetchedAt: new Date() },
      })
      .catch(() => {})
    return { status: 'ok', changed: true }
  } catch (e) {
    return { status: 'error', reason: String((e as Error)?.message ?? e) }
  }
}

/**
 * Сохраняет аватарку по прямой ссылке (бэкфилл/панель): ссылка Telegram CDN —
 * та же логика, что syncChannelAvatar, но источник — готовый URL.
 */
export async function syncChannelAvatarFromUrl(channelId: string, imageUrl: string): Promise<AvatarSyncResult> {
  if (!/^https:\/\/(cdn\d+\.telesco\.pe|[\w.-]*telegram\.org)\//.test(imageUrl)) {
    return { status: 'error', reason: 'untrusted host' }
  }
  return syncChannelAvatar(channelId, `<meta property="og:image" content="${imageUrl}">`)
}
