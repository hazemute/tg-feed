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
  code: '`',
  'tg-spoiler': '||',
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

  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^>]*)?)>/g
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
    out.push(urlMatch ? `![e](${decodeEntities(urlMatch[2].trim())})` : inner)
    pos = close + 4
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

  while (pos < html.length) {
    tagRe.lastIndex = pos
    m = tagRe.exec(html)
    if (!m) {
      pushText(html.slice(pos))
      break
    }
    pushText(html.slice(pos, m.index))
    if (tryInlineEmoji()) continue
    const [full, rawTag, attrs] = m
    const tag = rawTag.toLowerCase()
    pos = m.index + full.length

    if (tag === 'br') {
      out.push('\n')
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
  for (const mark of ['**', '~~', '||', '__']) {
    const count = result.split(mark).length - 1
    if (count % 2 === 1) result = result.split(mark).join('')
  }

  // Вложенные обёртки вокруг эмодзи/символов (**__🔥__**) → чистый символ:
  // контент без букв/цифр — это декор, стили ему не нужны
  result = result.replace(
    /(\*\*|__){1,2}([^*_\wа-яёА-ЯЁ0-9\s]{1,6})(\*\*|__){1,2}/gu,
    '$2',
  )

  return result.trim()
}

/** Убирает markdown-разметку, оставляя чистый текст (для превью/уведомлений/поиска) */
export function stripMarkdown(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, ' ') // легаси-HTML старых постов
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/__([^_]*)__/g, '$1')
    .replace(/~~([^~]*)~~/g, '$1')
    .replace(/\|\|([^|]*)\|\|/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------- Клиентская часть: markdown-lite → блоки и спаны ----------

export type Span =
  | { t: 'plain'; v: string }
  | { t: 'bold'; v: string }
  | { t: 'italic'; v: string }
  | { t: 'strike'; v: string }
  | { t: 'code'; v: string }
  | { t: 'spoiler'; v: string }
  | { t: 'link'; v: string; href: string }
  | { t: 'emoji'; url: string }

export type Block =
  | { type: 'p'; spans: Span[] }
  | { type: 'quote'; spans: Span[] }
  | { type: 'code'; v: string }

/** Регэксп спанов markdown-lite: жирный, курсив, зачёркнутый, инлайн-код, спойлер, ссылка */
const SPAN_RE =
  /(\*\*([^*\n]+)\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(`[^`\n]+`)|(\|\|[^|\n]+\|\|)|(\[[^\]\n]+\]\([^)\s]+\))|(!\[e\]\([^)\s]+\))|(\bhttps?:\/\/[^\s<>()]+[^\s<>().,!?"';:]|@[a-zA-Z][a-zA-Z0-9_]{3,})/g

/** Разбирает строку (внутри абзаца/цитаты) на стилизованные спаны */
export function spansOf(line: string): Span[] {
  const spans: Span[] = []
  let last = 0
  for (const m of line.matchAll(SPAN_RE)) {
    const i = m.index ?? 0
    if (i > last) spans.push({ t: 'plain', v: line.slice(last, i) })
    if (m[2] !== undefined) spans.push({ t: 'bold', v: m[2] })
    else if (m[3] !== undefined) spans.push({ t: 'italic', v: m[3].slice(2, -2) })
    else if (m[4] !== undefined) spans.push({ t: 'strike', v: m[4].slice(2, -2) })
    else if (m[5] !== undefined) spans.push({ t: 'code', v: m[5].slice(1, -1) })
    else if (m[6] !== undefined) spans.push({ t: 'spoiler', v: m[6].slice(2, -2) })
    else if (m[7] !== undefined) {
      const label = m[7].slice(1, m[7].indexOf(']'))
      const href = m[7].slice(m[7].indexOf('(') + 1, -1)
      spans.push({ t: 'link', v: label || href, href })
    } else if (m[8] !== undefined) {
      // ![e](url) — премиум-эмодзи из Telegram (инлайн-картинка)
      spans.push({ t: 'emoji', url: m[8].slice(5, -1) })
    } else if (m[9] !== undefined) {
      const v = m[9]
      if (v.startsWith('@')) spans.push({ t: 'link', v, href: `https://t.me/${v.slice(1)}` })
      else spans.push({ t: 'link', v, href: v })
    }
    last = i + m[0].length
  }
  if (last < line.length) spans.push({ t: 'plain', v: line.slice(last) })
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

/** Разбирает markdown-lite поста на блоки: абзацы, цитаты, блоки кода */
export function blocksOf(text: string): Block[] {
  const blocks: Block[] = []
  const lines = normalizeLegacyHtml(text).split('\n')
  let para: string[] = []
  let quote: string[] = []

  const flushPara = () => {
    if (para.length === 0) return
    const joined = para.join('\n')
    if (joined.trim().length > 0) blocks.push({ type: 'p', spans: spansOf(joined) })
    para = []
  }
  const flushQuote = () => {
    if (quote.length === 0) return
    blocks.push({ type: 'quote', spans: spansOf(quote.join('\n')) })
    quote = []
  }

  let inCode = false
  let codeLines: string[] = []
  for (const line of lines) {
    const fenced = /^\s*```/.test(line)
    if (fenced) {
      if (inCode) {
        blocks.push({ type: 'code', v: codeLines.join('\n') })
        codeLines = []
        inCode = false
      } else {
        flushPara()
        flushQuote()
        inCode = true
      }
      continue
    }
    if (inCode) {
      codeLines.push(line)
      continue
    }
    if (/^>\s?/.test(line)) {
      flushPara()
      quote.push(line.replace(/^>\s?/, ''))
      continue
    }
    if (line.trim().length === 0) {
      flushPara()
      flushQuote()
      continue
    }
    flushQuote()
    para.push(line)
  }
  if (inCode && codeLines.length > 0) blocks.push({ type: 'code', v: codeLines.join('\n') })
  flushPara()
  flushQuote()
  return blocks
}
