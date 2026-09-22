/**
 * Очистка текстов постов Tg Swipe (v5.15) — «чтобы не было непонятных тупых постов».
 *
 * Три уровня:
 *  1) cleanPostText()  — ПОЛНАЯ зачистка при парсинге (новые/обновлённые посты):
 *     невидимые символы, канальные подписи-хвосты, простыни хэштегов/ссылок,
 *     повторяющиеся строки, спам-пунктуация, utm-хвосты в ссылках.
 *  2) cleanForRender() — ЛЁГКАЯ зачистка на выдаче (dto): покрывает легаси-посты
 *     в БД без перезаписи — быстрее и обратимо (данные не трогаем).
 *  3) looksLikeGarbage() — детерминированный детект «мусорного» поста для
 *     мгновенной фильтрации ленты (не ждёт ИИ-модерацию).
 *
 * Принцип консервативности: убираем только ЯВНЫЙ мусор. Легитимный контент
 * (каталоги ссылок, длинные посты, CAPS-заголовки) не задевается.
 */

/* ------------------------- невидимый мусор ------------------------- */

/** Zero-width, bidi-управляющие, BOM, soft-hyphen, control (кроме \n) */
const INVISIBLE_RE =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD\u180E\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

/* ------------------------- спам-пунктуация ------------------------- */

function clampPunctuation(t: string): string {
  return t
    .replace(/([!?])\1{3,}/g, '$1$1$1') // !!!!! → !!!
    .replace(/\.{7,}/g, '…')
    .replace(/([…])\1{2,}/g, '…')
    .replace(/([!])\s*(?=[А-Яа-яA-Za-z])/g, '$1 ')
}

/** Одинаковые эмодзи 6+ подряд → 3 (линии «🔥🔥🔥🔥🔥🔥🔥🔥» читабельнее короче) */
function clampEmojiRuns(t: string): string {
  // Базовый символ + модификаторы/VS16 — считаем одним эмодзи
  return t.replace(
    /([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}](?:\uFE0F|\u200D[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}])*)\1{5,}/gu,
    '$1$1$1',
  )
}

/* ------------------------- ссылки: utm/трекеры ------------------------- */

const TRACKER_PARAMS = /^(utm_|gclid|fbclid|yclid|msclkid|ref_|igshid|si=)/i

function stripTrackers(url: string): string {
  const q = url.indexOf('?')
  if (q === -1) return url
  const base = url.slice(0, q)
  const params = url.slice(q + 1).split('&')
  const kept = params.filter((p) => p.length > 0 && !TRACKER_PARAMS.test(p.split('=')[0] ?? ''))
  return kept.length > 0 ? `${base}?${kept.join('&')}` : base
}

/** Чистит utm/трекеры внутри markdown-ссылок [текст](url) */
function cleanLinkTargets(t: string): string {
  return t.replace(/\]\((https?:\/\/[^)\s]+)\)/g, (full, url: string) => {
    const clean = stripTrackers(url)
    return clean === url ? full : `](${clean})`
  })
}

/** Пустые markdown-ссылки — рендер-мусор */
function dropEmptyLinks(t: string): string {
  return t.replace(/\[\s*\]\(\s*\)/g, '').replace(/\[\s*\]/g, '')
}

/* ------------------------- хэштег-простыни ------------------------- */

const HASHTAG_LINE_RE = /^(?:#[^\s#]+\s*){6,}$/gm

/**
 * Строка, состоящая из 6+ хэштегов (канальные SEO-простыни в конце постов):
 * оставляем первые 5 + «…». Строки с обычным текстом не трогаем.
 */
function clampHashtagLines(t: string): string {
  return t.replace(HASHTAG_LINE_RE, (line) => {
    const tags = line.trim().split(/\s+/)
    return tags.length <= 5 ? line : `${tags.slice(0, 5).join(' ')} …`
  })
}

/* ------------------------- повторяющиеся строки ------------------------- */

/**
 * Подряд идущие одинаковые строки (схлопываются в одну) и строки-приглашения
 * канала, повторенные 3+ раз в посте (не подряд): «Подпишись @x» ×5 → ×1.
 */
function dedupeLines(t: string): string {
  const lines = t.split('\n')
  const out: string[] = []
  let prev = ''
  for (const raw of lines) {
    const line = raw.trimEnd()
    const key = line.trim()
    if (key.length > 0 && key === prev.trim()) continue
    out.push(line)
    prev = line
  }

  // Не подряд: одна и та же содержательная строка (≥12 симв., есть буквы)
  // встречается 3+ раза в посте — оставляем первое вхождение
  const counts = new Map<string, number>()
  for (const line of out) {
    const key = line.trim()
    if (key.length >= 12 && /[a-zA-Zа-яёА-ЯЁ]/.test(key)) {
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  if (counts.size > 0) {
    const seen = new Set<string>()
    const result: string[] = []
    for (const line of out) {
      const key = line.trim()
      const n = counts.get(key) ?? 0
      if (n >= 3 && key.length >= 12) {
        if (seen.has(key)) continue
        seen.add(key)
      }
      result.push(line)
    }
    return result.join('\n')
  }
  return out.join('\n')
}

/* ------------------- канальные подписи-хвосты ------------------- */

/**
 * Приглашения-хвосты в конце поста: строка-призыв с @каналом/ссылкой без
 * содержательного текста («Подпишись @x», «t.me/xxx», «канал | @chat»).
 * Убираем до 3 последних строк, если каждая — чистый призыв
 * (handles + CTA-слова и разделители, без точки/вопроса внутри).
 */
function isTailPromoLine(raw: string): boolean {
  const s = raw.trim()
  if (s.length === 0 || s.length > 90) return false
  const core = s.replace(/[🚀🔥👉📢💎⭐️🎯✅☑️👍⚡️💊❗️‼️⚠️]+/gu, '').trim()
  if (core.length === 0) return false // только эмодзи — не призыв, оставим
  if (/[.?!…]/.test(core.replace(/[!]+$/, ''))) return false // содержательная фраза
  const hasHandle = /@[\wа-яё-]{4,}/i.test(core) || /t\.me\/[\w_]{3,}/i.test(core)
  if (!hasHandle) return false
  const rest = core
    .replace(/@[\wа-яё-]{4,}/gi, '')
    .replace(/t\.me\/[\w_]{3,}/gi, '')
    .replace(/(?:подпис[а-яё]*|join[a-z]*|follow\s?(?:us|me)?)[\s!:-]*/gi, '')
    .replace(/[\s|/—–•·,#]+/g, '')
  return rest.length <= 12
}

function stripTailPromo(t: string): string {
  const lines = t.split('\n')
  let stripped = 0
  for (let i = lines.length - 1; i >= 0 && stripped < 3; i--) {
    const line = lines[i]?.trim() ?? ''
    if (line.length === 0) {
      if (i < lines.length - 1 - stripped) break
      continue
    }
    if (isTailPromoLine(line)) {
      lines.splice(i, 1)
      stripped++
      continue
    }
    break
  }
  return lines.join('\n')
}

/* ------------------------- полная очистка ------------------------- */

/**
 * Полная зачистка markdown-текста поста. Вызывается в parse-engine при
 * СОЗДАНИИ поста (и при смене текста на ре-парсинге). БД хранит чистый текст.
 * v5.81: + срез ведущих пробелов/табов/NBSP у КАЖДОЙ строки — Telegram
 * (и парсер t.me/s) приносит абзацные отступы («красная строка»), которые
 * в веб-рендере выглядят как случайные сдвиги текста. Разметка markdown-lite
 * отступами не управляется — срез безопасен.
 */
const LEADING_WS_RE = /^[ \t\u00A0\u2007\u202F]+/gm

export function cleanPostText(text: string): string {
  if (!text) return text
  let t = text
    .replace(INVISIBLE_RE, '')
    .replace(/\r\n?/g, '\n')
    .replace(LEADING_WS_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')

  t = dedupeLines(t)
  t = clampPunctuation(t)
  t = clampEmojiRuns(t)
  t = clampHashtagLines(t)
  t = cleanLinkTargets(t)
  t = dropEmptyLinks(t)
  t = stripTailPromo(t)

  return t.trim()
}

/**
 * Лёгкая зачистка НА ВЫДАЧЕ (dto): покрывает легаси-посты без перезаписи БД.
 * Быстрая — только линейные замены без split/по-строчных проходов.
 * v5.81: + срез ведущих отступов строк (тот же «красная строка» у старых постов).
 */
export function cleanForRender(text: string): string {
  if (!text) return text
  return text
    .replace(INVISIBLE_RE, '')
    .replace(/\r\n?/g, '\n')
    .replace(LEADING_WS_RE, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/([!?])\1{4,}/g, '$1$1$1')
    .replace(/\.{9,}/g, '…')
}

/* ------------------------- детект мусора ------------------------- */

/**
 * Детерминированный «мусорный» пост (каша, обрывки, простыня символов).
 * Мгновенный фильтр ленты — ИИ-модерация подключается к остальному.
 * Возвращает true только для ЯВНОГО мусора:
 *  • почти нет букв/цифр при достаточной длине (спам-символы, ASCII-арт);
 *  • один символ занимает >60% поста;
 *  • 90%+ CAPS при 8+ «словах» и длине 120+ (кричащий спам-блок);
 *  • много строк из повторяющихся 2-3 символов («аб аб аб аб…»).
 */
export function looksLikeGarbage(text: string | null | undefined): boolean {
  const t = (text ?? '').trim()
  if (t.length < 40) return false // короткие посты (картинка + смайл) — норм

  // Убираем markdown-ссылки: URL-часть не показатель «буквальности»
  const visible = t.replace(/\]\([^)\s]+\)/g, ']').replace(/https?:\/\/\S+/g, '')

  const letters = visible.match(/[a-zA-Zа-яёА-ЯЁ0-9]/g)?.length ?? 0
  if (visible.length >= 45 && letters / visible.length < 0.2) return true

  const freq = new Map<string, number>()
  for (const ch of visible) {
    if (/\s/.test(ch)) continue
    freq.set(ch, (freq.get(ch) ?? 0) + 1)
  }
  let maxRun = 0
  for (const n of freq.values()) maxRun = Math.max(maxRun, n)
  if (visible.length >= 60 && maxRun / visible.length > 0.6) return true

  const caps = visible.match(/[A-ZА-ЯЁ]/g)?.length ?? 0
  const lower = visible.match(/[a-zа-яё]/g)?.length ?? 0
  if (visible.length >= 120 && caps >= 30 && caps / Math.max(1, caps + lower) > 0.9) return true

  // «аб аб аб аб» — строки из повторов коротких фрагментов
  const junkLines = t.split('\n').filter((line) => {
    const s = line.trim()
    if (s.length < 20) return false
    const parts = s.split(/\s+/)
    if (parts.length < 6) return false
    const uniq = new Set(parts.map((p) => p.slice(0, 2)))
    return uniq.size <= 2
  })
  if (junkLines.length >= 3) return true

  return false
}
