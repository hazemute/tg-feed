import { escapeHtml } from '@/lib/tg-bot'

/**
 * КАРТОЧКИ ПОСТОВ В ЛС (v6.1.2) — общий визуальный язык всех «постовых»
 * сообщений бота (реактивация, недельный дайджест, уведомления активности).
 *
 * Принципы:
 *  • обложка — собственная картинка поста (sendPhoto по file_id/URL) вместо
 *    безликого текста; нет картинки → тот же дизайн текстом;
 *  • контент поста — только внутри <blockquote> (выглядит как цитата из
 *    Telegram-канала — узнаваемо и аккуратно);
 *  • markdown-lite постов (там **жирный**, `код`, > цитаты) для ЛС чистим
 *    до читаемого текста — обрезка HTML-тегов ломала вёрстку;
 *  • премиум-эмодзи/иконки кнопок подставляет botSendRich/botSendPhotoRich
 *    сами (premiumText + buildIconKeyboard) — здесь только юникод;
 *  • функции ЧИСТЫЕ (без БД/сети) — можно смоук-тестить локально.
 */

/** Стриппер markdown-lite (жирный/курсив/код/спойлер/ссылки/цитаты/заголовки) для сниппетов.
 *  v6.2.0: + заголовки «## », + остаточные «**»-пары без закрывающей половины —
 *  исходники каналов пишут markdown, который Telegram не рендерит, и звёздочки
 *  протекали в ЛС бота (скриншот владельца). */
export function dmSnippet(text: string, max = 140): string {
  const plain = text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\|\|(.+?)\|\|/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1')
    .replace(/^#{1,4}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > max ? `${plain.slice(0, max).trimEnd()}…` : plain
}

/** Первый элемент галереи (legacy-строки или MediaItem{url}) */
function firstGalleryItem(gallery?: string | null): string | null {
  if (!gallery) return null
  try {
    const arr: unknown = JSON.parse(gallery)
    if (!Array.isArray(arr) || arr.length === 0) return null
    const first = arr[0] as unknown
    if (typeof first === 'string') return first || null
    if (first && typeof first === 'object') {
      const url = (first as { url?: unknown }).url
      return typeof url === 'string' && url ? url : null
    }
    return null
  } catch {
    return null
  }
}

/**
 * Сырое фото поста для sendPhoto (без нашего прокси-обёртывания):
 *  • `tgfile:<file_id>` → `<file_id>` (вечный, Bot API шлёт мгновенно);
 *  • `https://…telesco.pe/…` (и прочие https) → как есть — Telegram скачивает сам;
 *  • относительные прокси-URL и видео не подходят → null (пошлём текстом).
 */
export function sendablePhotoOf(post: {
  mediaUrl?: string | null
  mediaType?: string | null
  gallery?: string | null
}): string | null {
  if (post.mediaType && post.mediaType !== 'image') return null
  const cand = (post.mediaUrl ?? '').trim() || firstGalleryItem(post.gallery)
  if (!cand) return null
  if (cand.startsWith('tgfile:')) {
    const fid = cand.slice('tgfile:'.length).trim()
    return fid || null
  }
  if (cand.startsWith('https://')) return cand
  return null
}

/**
 * Цитата поста: заголовок канала (опционально ссылкой) + сниппет.
 * Выглядит как пересланный кусок поста — «живой» и аккуратный.
 */
export function postQuoteHtml(
  channelTitle: string,
  text: string,
  opts?: { max?: number; href?: string | null },
): string {
  const title = escapeHtml(channelTitle.slice(0, 64))
  const snippet = escapeHtml(dmSnippet(text, opts?.max ?? 160))
  const head = opts?.href
    ? `<a href="${opts.href}"><b>${title}</b></a>`
    : `<b>${title}</b>`
  return `<blockquote>${head}\n${snippet}</blockquote>`
}
