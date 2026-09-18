/**
 * Markdown-lite для постов Tg Swipe.
 *
 * Телеграм-разметка постов (b/i/s/code/pre/a/tg-spoiler/blockquote) из веб-превью
 * t.me/s конвертируется парсером в компактный markdown-диалект, который рендерится
 * на клиенте без внешних зависимостей:
 *
 *   **жирный**  __курсив__  ~~зачёркнутый~~  `код`
 *   ```блок кода```  ||спойлер||  [текст](url)  > цитата (в начале строки)
 *
 * Диалект совместим с привычной разметкой Telegram — посты, скопированные
 * авторами «как есть», тоже отрендерятся.
 */

// ---------- Серверная часть: HTML t.me/s → markdown-lite ----------

const INLINE_MARKS: Record<string, string> = {
  b: '**',
  strong: '**',
  i: '__',
  em: '__',
  s: '~~',
  del: '~~',
  strike: '~~',
  u: '^^',
  ins: '^^',
  code: '`',
  'tg-spoiler': '||',
}

/** '//telegram.org/…' → 'https://telegram.org/…' (протокол-относительные URL превью) */
function absolutizeUrl(u: string): string {
  return u.startsWith('//') ? `https:${u}` : u
}

type Mark =
  | { kind: 'inline'; mark: string; tag: string; start: number }
  | { kind: 'link'; href: string; start: number }
  | { kind: 'pre'; start: number }
  | { kind: 'quote'; start: number }

/** Декодирование HTML-сущностей (дублирует логику parse-engine для автономности) */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&#(\d+);/g, (_, c) => safeFromCode(Number(c)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeFromCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
}

function safeFromCode(code: number): string {
  if (!Number.isFinite(code) || code < 32 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/**
 * Преобразует HTML-фрагмент текста поста в markdown-lite.
 * Поддерживает: b/strong, i/em, s/del, code, pre, a[href], tg-spoiler,
 * blockquote, br; прочие теги (span, tg-emoji и т.п.) распаковываются в текст.
 */
export function htmlToMarkdownLite(html: string): string {
  const out: string[] = []
  const stack: Mark[] = []
  let pos = 0

  // Допускаем самозакрывающиеся теги (<br/>, <hr/>) — иначе они остаются текстом
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^>]*?)?\/?)>/g
  let m: RegExpExecArray | null

  const pushText = (raw: string) => {
    if (raw) out.push(decodeEntities(raw).replace(/[ \t]+/g, ' '))
  }

  /** Инлайн премиум-эмодзи: <i class="tgme_widget_message_inline_emoji" style="…url('…')">😀</i>
   *  → маркер ![e](url); без фоновой картинки остаётся символ-фолбэк.
   *  Перехватываем ВСЕ такие <i> — иначе вложенная разметка ломает markdown. */
  const tryInlineEmoji = (): boolean => {
    if (!m) return false
    const [, rawTag, attrs] = m
    if (rawTag.toLowerCase() !== 'i') return false
    const cls = attrs ?? ''
    if (!cls.includes('tgme_widget_message_inline_emoji')) return false
    const close = html.indexOf('</i>', pos)
    if (close === -1) return false
    const urlMatch = cls.match(/url\((['"]?)([^)'"]+)\1\)/)
    const inner = decodeEntities(html.slice(pos, close).replace(/<[^>]+>/g, '')).trim()
    const url = urlMatch ? absolutizeUrl(decodeEntities(urlMatch[2].trim())) : null
    out.push(url ? `![e](${url})` : inner)
    pos = close + 4
    return true
  }

  /** Премиум-эмодзи современного превью: <tg-emoji emoji-id="ID">…статичный фолбэк…</tg-emoji>
   *  → маркер ![e:ID](thumb) — ID нужен клиенту для анимированной версии
   *  (Bot API getCustomEmojiStickers → webm через /api/emoji/[id]).
   *  Некоторые паки пишут emoji-id="ID #TAG" (текстовая метка рядом) — берём
   *  первый токен как ID, метку используем как фолбэк-текст. */
  const tryTgEmoji = (): boolean => {
    if (!m) return false
    if (m[1].toLowerCase() !== 'tg-emoji') return false
    const rawId = (m[2] ?? '').match(/emoji-id="([^"]+)"/)?.[1] ?? ''
    const idParts = rawId.split(/\s+/).filter(Boolean)
    const id = /^\d+$/.test(idParts[0] ?? '') ? idParts[0] : ''
    const tag = idParts.find((p) => p.startsWith('#')) ?? ''
    const close = html.indexOf('</tg-emoji>', pos)
    if (close === -1) return false
    const inner = html.slice(pos, close)
    const bg = inner.match(/background-image:\s*url\((['"]?)([^)'"]+)\1\)/)?.[2]
    const fallback = decodeEntities(inner.replace(/<[^>]+>/g, '')).trim()
    const url = bg ? absolutizeUrl(decodeEntities(bg.trim())) : null
    if (id && url) out.push(`![e:${id}](${url})`)
    else if (url) out.push(`![e](${url})`)
    else if (fallback) out.push(fallback)
    else if (tag) out.push(tag)
    pos = close + '</tg-emoji>'.length
    return true
  }

  /** Закрывает маркер i и все открытые поверх него (некорректная вложенность) */
  const closeMark = (i: number) => {
    while (stack.length > i) {
      const mk = stack[stack.length - 1]
      if (mk.kind === 'inline') {
        if (out.length === mk.start) out.length = mk.start // пустой маркер — убрать **
        else out.push(mk.mark)
      } else if (mk.kind === 'link') {
        const inner = out.splice(mk.start).join('')
        const href = mk.href || 'https://t.me'
        out.push(inner.trim().length > 0 ? `[${inner.trim()}](${href})` : `[${href}](${href})`)
      } else if (mk.kind === 'pre') {
        out.push('\n```\n')
      } else if (mk.kind === 'quote') {
        const inner = out.splice(mk.start).join('')
        out.push(
          inner
            .split('\n')
            .map((line) => (line.trim().length > 0 ? `> ${line.trim()}` : ''))
            .join('\n') + '\n',
        )
      }
      stack.pop()
    }
  }

  /** Таблица Telegram (Bot API поддерживает <table>) → pipe-разметка markdown.
   *  Ячейки рекурсивно прогоняются через htmlToMarkdownLite (b/i/code/ссылки живут),
   *  новые строки схлопываются в пробел, «|» экранируется. */
  const tryTable = (): boolean => {
    if (!m || m[1].toLowerCase() !== 'table') return false
    const lower = html.toLowerCase()
    const close = lower.indexOf('</table>', pos)
    if (close === -1) return false
    const inner = html.slice(pos, close)
    pos = close + '</table>'.length
    const rows: string[][] = []
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
    let r: RegExpExecArray | null
    while ((r = trRe.exec(inner))) {
      const cells: string[] = []
      const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi
      let c: RegExpExecArray | null
      while ((c = tdRe.exec(r[1]))) {
        const cell = htmlToMarkdownLite(c[1])
          .replace(/\n+/g, ' ')
          .replace(/\|/g, '\\|')
          .replace(/\s+/g, ' ')
          .trim()
        if (cell.length > 0 || cells.length > 0) cells.push(cell)
      }
      if (cells.length > 0) rows.push(cells)
    }
    if (rows.length === 0) return true
    const width = Math.max(...rows.map((rw) => rw.length))
    for (const rw of rows) while (rw.length < width) rw.push('')
    out.push('\n')
    for (const rw of rows) out.push(`| ${rw.join(' | ')} |\n`)
    out.push('\n')
    return true
  }

  while (pos < html.length) {
    tagRe.lastIndex = pos
    m = tagRe.exec(html)
    if (!m) {
      pushText(html.slice(pos))
      break
    }
    pushText(html.slice(pos, m.index))
    if (tryInlineEmoji()) continue
    if (tryTgEmoji()) continue
    if (tryTable()) continue
    const [full, rawTag, attrs] = m
    const tag = rawTag.toLowerCase()
    pos = m.index + full.length

    if (tag === 'br') {
      out.push('\n')
      continue
    }

    if (tag === 'hr') {
      out.push('\n---\n')
      continue
    }

    if (full.startsWith('</')) {
      // закрывающий тег: закрываем верхний маркер этого типа (и всё поверх него)
      for (let i = stack.length - 1; i >= 0; i--) {
        const mk = stack[i]
        const same =
          (mk.kind === 'inline' && (mk.tag === tag || (tag === 'span' && mk.tag === 'tg-spoiler'))) ||
          (mk.kind === 'link' && tag === 'a') ||
          (mk.kind === 'pre' && tag === 'pre') ||
          (mk.kind === 'quote' && tag === 'blockquote')
        if (same) {
          closeMark(i)
          break
        }
      }
      continue
    }

    // открывающий тег
    if (tag === 'a') {
      const href = (attrs ?? '').match(/href="([^"]*)"/)?.[1] ?? ''
      stack.push({ kind: 'link', href, start: out.length })
      continue
    }
    // Спойлеры в веб-превью приходят классом (span/i с class="tg-spoiler") —
    // превращаем в ||…|| наравне с настоящим тегом <tg-spoiler>
    if ((attrs ?? '').includes('tg-spoiler')) {
      stack.push({ kind: 'inline', mark: '||', tag: 'tg-spoiler', start: out.length })
      out.push('||')
      continue
    }
    if (tag === 'pre') {
      stack.push({ kind: 'pre', start: out.length })
      out.push('\n```\n')
      continue
    }
    if (tag === 'blockquote') {
      stack.push({ kind: 'quote', start: out.length })
      out.push('\n')
      continue
    }
    const mark = INLINE_MARKS[tag]
    if (mark) {
      stack.push({ kind: 'inline', mark, tag, start: out.length })
      out.push(mark)
      continue
    }
    // span/tg-emoji/u и прочее — просто распаковываем
  }

  // незакрытые маркеры добиваем в конце (битая разметка не должна рвать пост)
  closeMark(0)

  let result = out
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  // Экранированные <br/> как текст (некоторые боты вставляют их в сообщение)
  result = result.replace(/<\/?br\s*\/?>/gi, '\n')

  // Битая разметка: маркер с нечётным числом вхождений не имеет пары —
  // убираем такие маркеры полностью, пост остаётся читабельным текстом
  for (const mark of ['**', '~~', '||', '^^', '__']) {
    const count = result.split(mark).length - 1
    if (count % 2 === 1) result = result.split(mark).join('')
  }

  // Вложенные обёртки вокруг эмодзи/символов (**__🔥__**) → чистый символ
  result = normalizeDecorations(result)

  return result.trim()
}

/**
 * Схлопывание декоративных обёрток вокруг эмодзи/символов прямо на клиенте:
 * __**👍**__ → 👍, **__**‼️**__** → ‼️ (вложенность любой глубины).
 * Контент обёртки — только маркеры и не-буквы/цифры/пробелы/скобки;
 * настоящие выделения слов (**15%**, **Объективный**, __слово__) не трогаются.
 * Скобки [ ] исключены из контента: «**текст **[**метка**](url)**» — это граница
 * жирного текста и жирной метки ссылки, а не декоративная обёртка «[»
 * (прежде схлопывание съедало маркер, и весь абзац рассыпался).
 * Рекурсивно по слоям — за один проход снимается внешний слой, до 5 проходов.
 */
export function normalizeDecorations(text: string): string {
  const re = /(\*\*|__|~~|\|\||\^\^)((?:\*\*|__|~~|\|\||\^\^|[^а-яёА-ЯЁa-zA-Z0-9\s\[\]])+?)\1/g
  let out = text
  for (let i = 0; i < 5; i++) {
    const next = out.replace(re, '$2')
    if (next === out) break
    out = next
  }
  return out
}

/** Убирает markdown-разметку, оставляя чистый текст (для превью/уведомлений/поиска) */
export function stripMarkdown(text: string): string {
  const cleaned = reorderMarkersAroundLinks(decodeHrefAmpersands(text))
    .replace(/<br\s*\/?>/gi, ' ') // легаси-HTML старых постов
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[e(?:v)?(?::\d+)?\]\([^)]*\)/g, '') // инлайн-картинки эмодзи — не текст
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/__([^_]*)__/g, '$1')
    .replace(/~~([^~]*)~~/g, '$1')
    .replace(/\|\|([^|]*)\|\|/g, '$1')
    .replace(/\^\^([^^]*)\^\^/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1')
    .replace(/^(>\s?)+/gm, '')
    .replace(/^#{1,3}\s+/gm, '')
    .replace(/^\s{0,3}\[( |x|X)\]\s+/gm, '')
    .replace(/^\s{0,3}([-\*_])\s*(?:\1\s*){2,}$/gm, ' ')
    .replace(/\\\|/g, ' ')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  // финальная зачистка декора: «__**👍**__» → «👍» (после снятия обёрток)
  return normalizeDecorations(cleaned)
}

// ---------- Клиентская часть: markdown-lite → блоки и спаны ----------

export type Span =
  | { t: 'plain'; v: string }
  | { t: 'bold'; v: string; kids?: Span[] }
  | { t: 'italic'; v: string; kids?: Span[] }
  | { t: 'strike'; v: string; kids?: Span[] }
  | { t: 'underline'; v: string; kids?: Span[] }
  | { t: 'code'; v: string }
  | { t: 'spoiler'; v: string; kids?: Span[] }
  | { t: 'link'; v: string; href: string; kids?: Span[] }
  | { t: 'emoji'; url: string; id?: string; animated?: boolean; lottie?: boolean }

export type Block =
  | { type: 'p'; spans: Span[] }
  | { type: 'heading'; level: 1 | 2 | 3; spans: Span[] }
  | { type: 'quote'; spans: Span[]; depth: number }
  | { type: 'code'; v: string; lang?: string }
  | { type: 'hr' }
  | { type: 'list'; ordered: boolean; start: number; items: Span[][] }
  | { type: 'todo'; items: { done: boolean; spans: Span[] }[] }
  | { type: 'table'; header?: Span[][]; rows: Span[][][] }

/**
 * Регэксп спанов markdown-lite: премиум-эмодзи, жирный, курсив, зачёркнутый,
 * underline, инлайн-код, спойлер, ссылка, url, @упоминание.
 *
 * Стилевые маркеры допускают внутри себя одиночные символы того же класса
 * (одиночная «*» внутри жирного, «|» внутри спойлера — «||текст | ещё||»)
 * и пересекают переносы строк — так пишет Telegram (<b>…<br/>…</b>).
 * Ленивая свёртка с (?!XX) даёт кратчайшую парную свёртку и не съедает
 * соседние вхождения того же маркера.
 *
 * Инлайн-код `…` может пересекать перенос строки — авторы часто оставляют
 * закрывающую кавычку на следующей строке (судебные акты, цитаты, код).
 *
 * Курсив __…__ не открывается ВНУТРИ слова/идентификатора (lookbehind
 * (?<![A-Za-z0-9_])): «@user__» и «prod1__» не разворачиваются в курсив
 * и не склеиваются в пары через абзац.
 *
 * Группы: 1 emoji, 2 bold, 3 italic, 4 strike, 5 code, 6 spoiler,
 * 7 underline, 8 link [[метка]](url) (двойные скобки), 9 link [метка](url)
 * (метка ≤160 симв., максимум один перенос строки без пустых строк), 10 url, 11 mention.
 */
const SPAN_RE =
  /(!\[e(?:v|l)?(?::\d+)?\]\([^)\s]+\))|(\*\*(?:(?!\*\*)[\s\S])+?\*\*)|((?<![a-zA-Z0-9_])__(?:(?!__)[\s\S])+?__)|(~~(?:(?!~~)[\s\S])+?~~)|(`[^`]+`)|(\|\|(?:(?!\|\|)[\s\S])+?\|\|)|(\^\^(?:(?!\^\^)[\s\S])+?\^\^)|(\[\[[^\]\n]{1,160}\]\]\([^)\s]+\))|(\[(?:[^\]\n]|\n(?!\n)){1,160}\]\([^)\s]+\))|(\bhttps?:\/\/[^\s<>()]+[^\s<>().,!?"';:])|(@[a-zA-Z][a-zA-Z0-9_]{3,})/g

const MAX_SPAN_DEPTH = 3

/** plain-спан: срезаем сиротские маркеры (непарные после парсинга) — это мусор разметки */
function plainClean(v: string): Span[] {
  return [{ t: 'plain', v: v.replace(/\*\*|__|~~|\|\||\^\^/g, '') }]
}

/**
 * Чинит неверный порядок маркеров из вложенной разметки t.me/s:
 * `**текст [жирный**](url)` → `**текст [жирный](url)**` — закрывающий маркер,
 * прилипший к тексту ссылки, переезжает за скобку.
 *
 * ВАЖНО (сканирующая реализация вместо слепого регэкспа): маркер переставляется
 * только если он НЕПАРНЫЙ внутри метки ссылки. Корректные ссылки вида
 * `[**жирная метка**](url)` (маркер парный внутри метки) больше не ломаются —
 * прежний слепой swap превращал их в «[**iOS](url)**», после чего жирный
 * склеивался через «](url)» и весь абзац рассыпался.
 */
const MARKERS = ['**', '__', '~~', '||', '^^'] as const

function reorderMarkersAroundLinks(text: string): string {
  const pieces: string[] = []
  let pos = 0
  const CLOSE_RE = /\]\([^)\s]+\)/g
  CLOSE_RE.lastIndex = 0
  for (let m = CLOSE_RE.exec(text); m; m = CLOSE_RE.exec(text)) {
    const closeStart = m.index
    const closeEnd = closeStart + m[0].length
    // открывающая «[» ближайшая слева (в той же строке, без «]» между)
    let open = -1
    for (let i = closeStart - 1; i >= 0 && i >= closeStart - 600; i--) {
      const ch = text[i]
      if (ch === '\n' || ch === ']') break
      if (ch === '[') {
        open = i
        break
      }
    }
    if (open === -1) continue
    let label = text.slice(open + 1, closeStart)
    const trailing: string[] = []
    for (const mk of MARKERS) {
      // считаем парные вхождения маркера в метке
      let count = 0
      for (let idx = label.indexOf(mk); idx !== -1; idx = label.indexOf(mk, idx + mk.length)) count++
      if (count % 2 === 1 && count > 0) {
        const last = label.lastIndexOf(mk)
        if (last !== -1) {
          label = label.slice(0, last) + label.slice(last + mk.length)
          trailing.push(mk)
        }
      }
    }
    if (trailing.length > 0) {
      pieces.push(text.slice(pos, open + 1), label, m[0], ...trailing)
      pos = closeEnd
    }
  }
  if (pieces.length === 0) return text
  pieces.push(text.slice(pos))
  return pieces.join('')
}

/** Многократное кодирование амперсандов в URL ссылок (t.me/s: &amp;amp;…) → чистый & */
function decodeHrefAmpersands(text: string): string {
  let changed = true
  let pass = 0
  while (changed && pass < 4) {
    changed = false
    text = text.replace(/(\]\([^)\s]+)/g, (m) => {
      const dec = m.replace(/&amp;/g, '&')
      if (dec !== m) changed = true
      return dec
    })
    pass++
  }
  return text
}

/** Разбирает строку (внутри абзаца/цитаты) на стилизованные спаны.
 *  Контент стилевых спанов парсится рекурсивно — внутри жирного/спойлера/
 *  текста ссылки могут быть свои ссылки, эмодзи и прочая разметка. */
export function spansOf(line: string, depth = 0): Span[] {
  const spans: Span[] = []
  let last = 0
  const pushPlain = (v: string) => {
    if (v) spans.push(...plainClean(v))
  }
  for (const m of line.matchAll(SPAN_RE)) {
    const i = m.index ?? 0
    pushPlain(line.slice(last, i))
    // Группы: 1 emoji, 2 bold, 3 italic, 4 strike, 5 code, 6 spoiler,
    // 7 underline, 8 link [[..]], 9 link [..], 10 url, 11 mention (см. SPAN_RE)
    if (m[2] !== undefined) {
      const v = m[2].slice(2, -2)
      spans.push({ t: 'bold', v: v.trim(), kids: depth < MAX_SPAN_DEPTH ? spansOf(v, depth + 1) : undefined })
    } else if (m[3] !== undefined) {
      const v = m[3].slice(2, -2)
      spans.push({ t: 'italic', v: v.trim(), kids: depth < MAX_SPAN_DEPTH ? spansOf(v, depth + 1) : undefined })
    } else if (m[4] !== undefined) {
      const v = m[4].slice(2, -2)
      spans.push({ t: 'strike', v: v.trim(), kids: depth < MAX_SPAN_DEPTH ? spansOf(v, depth + 1) : undefined })
    } else if (m[7] !== undefined) {
      const v = m[7].slice(2, -2)
      spans.push({ t: 'underline', v: v.trim(), kids: depth < MAX_SPAN_DEPTH ? spansOf(v, depth + 1) : undefined })
    } else if (m[5] !== undefined) {
      spans.push({ t: 'code', v: m[5].slice(1, -1) })
    } else if (m[6] !== undefined) {
      const v = m[6].slice(2, -2)
      spans.push({ t: 'spoiler', v: v.trim(), kids: depth < MAX_SPAN_DEPTH ? spansOf(v, depth + 1) : undefined })
    } else if (m[8] !== undefined) {
      // двойные скобки [[метка]](url) — вложенные «[»/«]» в тексте метки
      const inner = m[8].slice(2, m[8].indexOf(']'))
      const href = m[8].slice(m[8].indexOf('(') + 1, -1).replace(/&amp;/g, '&')
      spans.push({
        t: 'link',
        v: inner.replace(/&amp;/g, '&'),
        href,
        kids: depth < MAX_SPAN_DEPTH ? spansOf(inner, depth + 1) : undefined,
      })
    } else if (m[9] !== undefined) {
      const label = m[9].slice(1, m[9].indexOf(']'))
      const href = m[9].slice(m[9].indexOf('(') + 1, -1).replace(/&amp;/g, '&')
      spans.push({
        t: 'link',
        // v — фолбэк без меток разметки и сущностей (реальный рендер идёт по kids)
        v: (label || href)
          .replace(/\*\*|__|~~|\|\||\^\^/g, '')
          .replace(/&amp;/g, '&'),
        href,
        kids: depth < MAX_SPAN_DEPTH ? spansOf(label, depth + 1) : undefined,
      })
    } else if (m[1] !== undefined) {
      // ![e](url) / ![e:ID](url) / ![ev:ID](url) / ![el:ID](url) — премиум-эмодзи Telegram;
      // ev — видео-стикер (<video>), el — Lottie (.tgs через lottie-web)
      const em = m[1].match(/^!\[e(v|l)?(?::(\d+))?\]\(([^)\s]+)\)$/)
      if (em) {
        spans.push({
          t: 'emoji',
          url: em[3],
          ...(em[2] ? { id: em[2] } : {}),
          ...(em[1] === 'v' ? { animated: true } : {}),
          ...(em[1] === 'l' ? { lottie: true } : {}),
        })
      }
    } else if (m[10] !== undefined) {
      spans.push({ t: 'link', v: m[10], href: m[10] })
    } else if (m[11] !== undefined) {
      spans.push({ t: 'link', v: m[11], href: `https://t.me/${m[11].slice(1)}` })
    }
    last = i + m[0].length
  }
  pushPlain(line.slice(last))
  return spans
}

/**
 * Легаси-зачистка старых постов: парсер прежних версий складывал в БД
 * литеральный HTML (<br/>, <b>…). Markdown-парсер клиенту такое рендерит
 * как текст — нормализуем заранее: <br> → перенос строки.
 */
function normalizeLegacyHtml(text: string): string {
  return text
    .replace(/(?:<br\s*\/?>\s*){2,}/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
}

/**
 * Легаси-эмодзи старых парсеров: ![e:ID #TAG] (метка без URL) → «#TAG» —
 * дальше она подсвечивается как обычный хэштег. Битый маркер не должен
 * утекать в видимый текст поста.
 */
function normalizeLegacyEmojiMarkers(text: string): string {
  return text.replace(/!\[e(?:v)?(?::\d+)?\s*(#[^\]\s]{1,40})\]/g, '$1')
}

/**
 * HTML-сущности в сохранённых текстах старых парсеров (&gt; &amp; …) —
 * декодируем безопасное подмножество; &amp; — последним (иначе «&amp;gt;»
 * превратится в «&gt;» дважды).
 */
function normalizeLegacyEntities(text: string): string {
  let out = text
  for (let i = 0; i < 3; i++) {
    const next = out
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&laquo;/g, '«')
      .replace(/&raquo;/g, '»')
      .replace(/&amp;/g, '&')
    if (next === out) break
    out = next
  }
  return out
}

/** Разбирает строку-ячейку таблицы на ячейки с учётом экранирования «\|» */
function splitTableCells(row: string): string[] {
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]
    if (ch === '\\' && row[i + 1] === '|') {
      cur += '|'
      i++
      continue
    }
    if (ch === '|') {
      cells.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  cells.push(cur.trim())
  return cells
}

const TABLE_SEP_CELL_RE = /^:?-{2,}:?$/

/** Строка-разделитель таблицы: | --- | :---: | */
function isTableSepLine(line: string): boolean {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells = splitTableCells(inner)
  return cells.length > 0 && cells.every((c) => TABLE_SEP_CELL_RE.test(c.replace(/\s+/g, '')))
}

function parseTableLines(lines: string[]): Block | null {
  if (lines.length < 2) return null
  const sepIdx = lines.findIndex(isTableSepLine)
  // Разделитель всегда стоит сразу под строкой заголовка (index 1)
  const header = sepIdx === 1 ? splitTableCells(lines[0].replace(/^\s*\|/, '').replace(/\|\s*$/, '')) : undefined
  // Строка заголовка и разделитель не входят в тело таблицы
  const bodyLines = lines.filter((_, i) => i !== sepIdx && !(header && i === 0))
  const rows = bodyLines.map((l) => splitTableCells(l.replace(/^\s*\|/, '').replace(/\|\s*$/, '')))
  const width = Math.max(header?.length ?? 0, ...rows.map((r) => r.length))
  if (width < 2 && rows.length < 2) return null
  const pad = (cells: string[]) => {
    while (cells.length < width) cells.push('')
    return cells.map((c) => spansOf(c))
  }
  return {
    type: 'table',
    ...(header ? { header: pad(header) } : {}),
    rows: rows.map(pad),
  }
}

const BULLET_RE = /^\s{0,3}[-•·*+\u2013]\s+(.+)$/
const ORDERED_RE = /^\s{0,3}(\d{1,3})[.)]\s+(.+)$/
const HEADING_RE = /^\s{0,3}(#{1,3})\s+(.{1,120}?)\s*#*\s*$/
const HR_RE = /^\s{0,3}([-\*_])\s*(?:\1\s*){2,}$/
const TODO_RE = /^\s{0,3}\[( |x|X)\]\s+(.*)$/
const QUOTE_RE = /^(>+) ?(.*)$/
const TABLE_ROW_RE = /^\s{0,3}\|.*\|\s*$/
const FENCE_RE = /^\s*```(\S*)\s*$/

/**
 * Разбирает markdown-lite поста на блоки: абзацы, заголовки (#, ##, ###),
 * цитаты (с глубиной вложенности >, >>, >>>), блоки кода (с языком),
 * списки (буллеты и нумерованные), чек-листы ([ ]/[x]), разделители (---)
 * и таблицы (| a | b |). Пустая строка не рвёт цитату, если дальше идёт
 * цитата той же глубины — абзацы внутри цитаты склеиваются.
 */
export function blocksOf(text: string): Block[] {
  const blocks: Block[] = []
  const lines = reorderMarkersAroundLinks(
    decodeHrefAmpersands(
      normalizeLegacyEntities(
        normalizeLegacyEmojiMarkers(normalizeDecorations(normalizeLegacyHtml(text))),
      ),
    ),
  ).split('\n')

  let para: string[] = []
  let inCode = false
  let codeLang: string | undefined
  let codeLines: string[] = []
  let quoteDepth = 0
  let quoteLines: string[] = []
  let quotePendingBlank = false
  let listOrdered = false
  let listStart = 1
  let listItems: string[] | null = null
  let todoItems: { done: boolean; text: string }[] | null = null
  let tableLines: string[] | null = null

  const flushPara = () => {
    if (para.length === 0) return
    const joined = para.join('\n')
    if (joined.trim().length > 0) blocks.push({ type: 'p', spans: spansOf(joined) })
    para = []
  }
  const flushQuote = () => {
    if (quoteDepth === 0) return
    const content = quoteLines.join('\n')
    if (content.trim().length > 0) blocks.push({ type: 'quote', depth: quoteDepth, spans: spansOf(content) })
    quoteDepth = 0
    quoteLines = []
    quotePendingBlank = false
  }
  const flushList = () => {
    if (listItems && listItems.length > 0) {
      blocks.push({ type: 'list', ordered: listOrdered, start: listStart, items: listItems.map((it) => spansOf(it)) })
    }
    listItems = null
  }
  const flushTodo = () => {
    if (todoItems && todoItems.length > 0) {
      blocks.push({ type: 'todo', items: todoItems.map((it) => ({ done: it.done, spans: spansOf(it.text) })) })
    }
    todoItems = null
  }
  const flushTable = () => {
    if (!tableLines) return
    const block = parseTableLines(tableLines)
    if (block) blocks.push(block)
    else para.push(...tableLines) // не похоже на таблицу — вернём в абзац
    tableLines = null
  }
  const flushAll = () => {
    flushPara()
    flushQuote()
    flushList()
    flushTodo()
    flushTable()
  }

  for (const line of lines) {
    if (inCode) {
      if (FENCE_RE.test(line)) {
        blocks.push({ type: 'code', v: codeLines.join('\n'), ...(codeLang ? { lang: codeLang } : {}) })
        codeLines = []
        inCode = false
        codeLang = undefined
      } else {
        codeLines.push(line)
      }
      continue
    }

    const fence = line.match(FENCE_RE)
    if (fence) {
      flushAll()
      inCode = true
      codeLang = fence[1] || undefined
      continue
    }

    // Таблица: жадно собираем подряд идущие |…| строки
    if (TABLE_ROW_RE.test(line)) {
      flushPara()
      flushQuote()
      flushList()
      flushTodo()
      ;(tableLines ??= []).push(line.trim())
      continue
    }
    if (tableLines) flushTable()

    if (line.trim().length === 0) {
      flushPara()
      flushList()
      flushTodo()
      if (tableLines) flushTable()
      if (quoteDepth > 0) quotePendingBlank = true
      continue
    }

    const qm = line.match(QUOTE_RE)
    if (qm) {
      const depth = Math.min(qm[1].length, 4)
      if (quoteDepth === depth) {
        if (quotePendingBlank) quoteLines.push('')
        quoteLines.push(qm[2] ?? '')
        quotePendingBlank = false
        continue
      }
      flushQuote()
      flushPara()
      flushList()
      flushTodo()
      quoteDepth = depth
      quoteLines = [qm[2] ?? '']
      quotePendingBlank = false
      continue
    }

    if (HR_RE.test(line)) {
      flushAll()
      blocks.push({ type: 'hr' })
      continue
    }

    const hm = line.match(HEADING_RE)
    if (hm) {
      flushAll()
      blocks.push({ type: 'heading', level: hm[1].length as 1 | 2 | 3, spans: spansOf(hm[2]) })
      continue
    }

    const tm = line.match(TODO_RE)
    if (tm) {
      flushPara()
      flushQuote()
      flushList()
      ;(todoItems ??= []).push({ done: tm[1].toLowerCase() === 'x', text: tm[2] })
      continue
    }

    const om = line.match(ORDERED_RE)
    const bm = om ? null : line.match(BULLET_RE)
    if (om || bm) {
      flushPara()
      flushQuote()
      flushTodo()
      if (om) {
        if (listItems && listOrdered) {
          listItems.push(om[2])
        } else {
          flushList()
          listOrdered = true
          listStart = parseInt(om[1], 10)
          listItems = [om[2]]
        }
      } else if (bm) {
        if (listItems && !listOrdered) {
          listItems.push(bm[1])
        } else {
          flushList()
          listOrdered = false
          listStart = 1
          listItems = [bm[1]]
        }
      }
      continue
    }

    // Обычный текст
    flushQuote()
    flushList()
    flushTodo()
    para.push(line)
  }
  if (inCode && codeLines.length > 0) {
    blocks.push({ type: 'code', v: codeLines.join('\n'), ...(codeLang ? { lang: codeLang } : {}) })
  }
  flushAll()
  return blocks
}
