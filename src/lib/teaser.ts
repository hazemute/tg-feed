/**
 * ТЕЗЕР ПОСТОВ (v5.70, Task 7-a) — общая чистая логика «Показа в ленте».
 *
 * Раньше режим (teaserMode/teaserLimit) канала применялся ТОЛЬКО на клиенте
 * (PostCard/PostOverlay: не-подписчик + текст длиннее лимита → обрезка/блюр).
 * v5.70 добавляет гибкость Channel.teaserApplyTo — КОМУ из постов применять
 * тизер — и выносит решение в изоморфный хелпер:
 *   - сервер (lib/dto.ts → toPostDTO): обрезает текст mode='cut' прямо в
 *     выдаче /api/feed и остальных роутов;
 *   - клиент (PostCard/PostOverlay): уважает тот же applyTo при рендере.
 * Файл БЕЗ зависимостей — импортируется и сервером, и клиентскими компонентами.
 */

export type TeaserApplyTo = 'all' | 'long' | 'text'

/** Порог «лонгрида» для applyTo='long' (символов очищенного текста).
 *  Обоснование: 600 символов ≈ 2–3 абзаца — только у таких постов за тизером
 *  остаётся существенная часть текста, и обрезка реально конвертирует в
 *  подписку. Короткие заметки (>лимита, но <600) показываем целиком — резать
 *  «хвост» лёгкого поста выглядит куцым и раздражает читателя. */
export const TEASER_LONG_MIN = 600

/** Нормализация значения из БД/DTO: неизвестное/пустое → прежнее поведение (all) */
export function normalizeTeaserApplyTo(raw: unknown): TeaserApplyTo {
  return raw === 'long' || raw === 'text' ? raw : 'all'
}

/** Есть ли у поста медиа (основное или галерея). Опросы/ссылки/файлы в DTO
 *  сериализуются в media → тоже считаются медийными: «показ в ленте» — про
 *  текстовые лонгриды, карточки резать бессмысленно. */
export function teaserHasMedia(post: { media?: unknown; gallery?: unknown[]; mediaUrl?: unknown }): boolean {
  return post.media != null || (Array.isArray(post.gallery) && post.gallery.length > 0)
}

/**
 * Применяется ли тизер к посту при данном applyTo:
 *  - all  → как раньше: любая длина выше лимита (решение по teaserLimit принято
 *           вызывающей стороной — здесь только фильтр applyTo);
 *  - long → только «лонгриды»: текст длиннее max(TEASER_LONG_MIN, teaserLimit);
 *  - text → только текстовые посты БЕЗ медиа.
 * Лимит передаётся, чтобы 'long' не был жестче/мягче пользовательского порога.
 */
export function teaserApplies(
  applyTo: TeaserApplyTo,
  opts: { textLen: number; hasMedia: boolean; teaserLimit?: number },
): boolean {
  switch (applyTo) {
    case 'long':
      return opts.textLen > Math.max(TEASER_LONG_MIN, opts.teaserLimit ?? 0)
    case 'text':
      return !opts.hasMedia
    default:
      return true
  }
}

/** Срез текста по границе слова (не резать слова посередине) */
export function cutAtWord(text: string, limit: number): string {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const lastSpace = cut.lastIndexOf(' ')
  // Пробел слишком далеко от края (сплошной URL/хэштег) — режем жёстко
  return lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut
}
