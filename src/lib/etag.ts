import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'

/**
 * ETag/304 для горячих GET-эндпоинтов (v5.49 — «миллисекундная загрузка»).
 *
 * Персистентный клиентский кэш (lib/api.ts) хранит тело ответа в localStorage
 * и на каждом следующем заходе в миниапп шлёт If-None-Match. Если данные не
 * менялись, сервер отвечает ПУСТЫМ 304 (~100 байт вместо килобайт) — рендер
 * идёт из локального кэша мгновенно, сеть почти не участвует. Изменились —
 * полный 200, кэш обновится и переживёт следующую сессию.
 *
 * Персонализированные ответы безопасны: ETag считается от конкретного payload
 * (у каждого пользователя свой), клиент хранит записи по пути запроса.
 */

export function jsonWithEtag<T>(
  request: Request,
  payload: T,
  extraHeaders?: Record<string, string>,
): NextResponse {
  const etag = `W/"${createHash('sha1')
    .update(JSON.stringify(payload))
    .digest('base64url')
    .slice(0, 24)}"`
  const inm = request.headers.get('if-none-match')
  if (inm && inm.split(',').map((s) => s.trim()).includes(etag)) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: etag, ...(extraHeaders ?? {}) },
    })
  }
  const res = NextResponse.json(payload)
  res.headers.set('ETag', etag)
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) res.headers.set(k, v)
  }
  return res
}
