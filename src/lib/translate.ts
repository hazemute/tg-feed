/**
 * БЕСПЛАТНЫЙ БЫСТРЫЙ ПЕРЕВОД (запрос владельца: «не через нейронку… бесплатно
 * и быстро»): публичный эндпоинт Google Translate (client=gtx) — без ключей,
 * без лимитов OpenRouter, ~0.2-1с на 1500 символов.
 *
 * Текст режется на куски по границам предложений (лимит gtx на GET ~2КБ URL —
 * шлём POST-формой, кусок ≤1400 символов для запаса), куски переводятся
 * последовательно и склеиваются. Раскладка поста (переносы) сохраняется
 * приблизительно — для превью/лонгридов достаточно.
 *
 * LLM-фолбэк остаётся в /api/translate/stream: если gtx недоступен (сеть,
 * блокировка), перевод всё равно состоится, как раньше.
 */

const GTX_URL = 'https://translate.googleapis.com/translate_a/single'

/** Один кусок → перевод. null при любой ошибке (тихо, вызывающий уходит в фолбэк) */
async function gtxChunk(text: string, lang: string, signalMs: number): Promise<string | null> {
  try {
    const body = new URLSearchParams({
      client: 'gtx',
      sl: 'auto',
      tl: lang,
      dt: 't',
      ie: 'UTF-8',
      oe: 'UTF-8',
      q: text,
    })
    const res = await fetch(
      `${GTX_URL}?client=gtx&sl=auto&tl=${encodeURIComponent(lang)}&dt=t&ie=UTF-8&oe=UTF-8`,
      {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: body.toString(),
      signal: AbortSignal.timeout(signalMs),
      cache: 'no-store',
    })
    if (!res.ok) return null
    const data = (await res.json()) as unknown
    // Форма ответа: [ [ [перевод, оригинал, ...], ... ], ... ]
    if (!Array.isArray(data) || !Array.isArray(data[0])) return null
    let out = ''
    for (const seg of data[0] as unknown[]) {
      if (Array.isArray(seg) && typeof seg[0] === 'string') out += seg[0]
    }
    return out.trim().length > 0 ? out : null
  } catch {
    return null
  }
}

/** Резка по предложениям/переносам: куски ≤ maxLen, слова не рвём */
function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > maxLen) {
    // граница: конец предложения или перенос или пробел не дальше maxLen
    let cut = -1
    for (const re of [/[.!?…](\s|$)/g, /\n/g]) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      let last = -1
      while ((m = re.exec(rest)) !== null) {
        if (m.index > maxLen) break
        last = m.index + m[0].length
      }
      if (last > maxLen * 0.5) {
        cut = last
        break
      }
    }
    if (cut <= 0) cut = rest.lastIndexOf(' ', maxLen)
    if (cut <= 0) cut = maxLen
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\s+/, '')
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

/** Перевод всего текста через gtx. null — не получилось (вызывающий фолбэчится на LLM) */
export async function gtxTranslate(text: string, lang: string): Promise<string | null> {
  const chunks = chunkText(text, 1400)
  const parts: string[] = []
  for (const chunk of chunks) {
    const out = await gtxChunk(chunk, lang, 9000)
    if (out === null) return null
    parts.push(out)
  }
  return parts.join(' ').replace(/\s+\n/g, '\n').trim() || null
}
