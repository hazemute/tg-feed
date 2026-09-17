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
    const url = urlMatch ? absolutizeUrl(decodeEntities(urlMatch[2].trim())) : null
    out.push(url ? `![e](${url})` : inner)
    pos = close + 4
    return true
  }

  /** Премиум-эмодзи современного превью: <tg-emoji emoji-id="ID">…статичный фолбэк…</tg-emoji>
   *  → маркер ![e:ID](thumb) — ID нужен клиенту для анимированной версии
   *  (Bot API getCustomEmojiStickers → webm через /api/emoji/[id]). */
  const tryTgEmoji = (): boolean => {
    if (!m) return false
    if (m[1].toLowerCase() !== 'tg-emoji') return false
    const id = (m[2] ?? '').match(/emoji-id="([^"]+)"/)?.[1] ?? ''
    const close = html.indexOf('</tg-emoji>', pos)
    if (close === -1) return false
    const inner = html.slice(pos, close)
    const bg = inner.match(/background-image:\s*url\((['"]?)([^)'"]+)\1\)/)?.[2]
    const fallback = decodeEntities(inner.replace(/<[^>]+>/g, '')).trim()
    const url = bg ? absolutizeUrl(decodeEntities(bg.trim())) : null
    if (id && url) out.push(`![e:${id}](${url})`)
    else if (url) out.push(`![e](${url})`)
    else out.push(fallback)
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
 * Контент обёртки — только маркеры и не-буквы/цифры/пробелы (эмодзи, пунктуация);
 * настоящие выделения слов (**15%**, **Объективный**, __слово__) не трогаются.
 * Рекурсивно по слоям — за один проход снимается внешний слой, до 5 проходов.
 */
export function normalizeDecorations(text: string): string {
  const re = /(\*\*|__|~~|\|\|)((?:\*\*|__|~~|\|\||[^а-яёА-ЯЁa-zA-Z0-9\s])+?)\1/g
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
    .replace(/^>\s?/gm, '')
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
  | { t: 'emoji'; url: string; id?: string; animated?: boolean }

export type Block =
  | { type: 'p'; spans: Span[] }
  | { type: 'quote'; spans: Span[] }
  | { type: 'code'; v: string }

/**
 * Регэксп спанов markdown-lite: премиум-эмодзи, жирный, курсив, зачёркнутый,
 * underline, инлайн-код, спойлер, ссылка, url, @упоминание.
 *
 * Маркеры **…**, __…__, ~~…~~, ||…||, ^^…^^ могут пересекать перенос строки
 * внутри абзаца — в Telegram жирный/курсив часто накрывает несколько строк
 * (<b>…<br/>…</b>); раньше маркеры парились только внутри одной строки и
 * литералы ** оставались на экране.
 *
 * Группы (target ES2017 — без именованных): 1 emoji, 2 bold, 3 italic,
 * 4 strike, 5 code, 6 spoiler, 7 underline, 8 link, 9 url, 10 mention.
 */
const SPAN_RE =
  /(!\[e(?:v)?(?::\d+)?\]\([^)\s]+\))|(\*\*(?:[^*]+)\*\*)|(__(?:[^_]+)__)|(~~(?:[^~]+)~~)|(`[^`\n]+`)|(\|\|(?:[^|]+)\|\|)|(\^\^(?:[^^]+)\^\^)|(\[[^\]\n]+\]\([^)\s]+\))|(\bhttps?:\/\/[^\s<>()]+[^\s<>().,!?"';:])|(@[a-zA-Z][a-zA-Z0-9_]{3,})/g

const MAX_SPAN_DEPTH = 3

/** plain-спан: срезаем сиротские маркеры (непарные после парсинга) — это мусор разметки */
function plainClean(v: string): Span[] {
  return [{ t: 'plain', v: v.replace(/\*\*|__|~~|\|\||\^\^/g, '') }]
}

/**
 * Чинит неверный порядок маркеров из вложенной разметки t.me/s:
 * `**текст [жирный**](url)` → `**текст [жирный](url)**` — закрывающий маркер,
 * прилипший к тексту ссылки, переезжает за скобку. Без этого ссылка
 * рендерится литералом «](https://…)» (жалоба на кривые ссылки).
 */
const MARKER_BEFORE_LINK_CLOSE = /(\*\*|__|~~|\|\||\^\^)(\]\([^)\s]+\))/g
function reorderMarkersAroundLinks(text: string): string {
  return text.replace(MARKER_BEFORE_LINK_CLOSE, '$2$1')
}

/** Двойное кодирование амперсандов в URL ссылок (t.me/s: &amp;amp;) → чистый & */
function decodeHrefAmpersands(text: string): string {
  return text.replace(/(\]\([^)\s]+)/g, (m) => m.replace(/&amp;/g, '&'))
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
    // 7 underline, 8 link, 9 url, 10 mention (см. комментарий над SPAN_RE)
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
      const label = m[8].slice(1, m[8].indexOf(']'))
      const href = m[8].slice(m[8].indexOf('(') + 1, -1).replace(/&amp;/g, '&')
      spans.push({
        t: 'link',
        v: label || href,
        href,
        kids: depth < MAX_SPAN_DEPTH ? spansOf(label, depth + 1) : undefined,
      })
    } else if (m[1] !== undefined) {
      // ![e](url) / ![e:ID](url) / ![ev:ID](url) — премиум-эмодзи Telegram;
      // animated=true — Bot API подтвердил видео-стикер, рендерим <video> с /api/emoji/ID
      const em = m[1].match(/^!\[e(v)?(?::(\d+))?\]\(([^)\s]+)\)$/)
      if (em) {
        spans.push({
          t: 'emoji',
          url: em[3],
          ...(em[2] ? { id: em[2] } : {}),
          ...(em[1] ? { animated: true } : {}),
        })
      }
    } else if (m[9] !== undefined) {
      spans.push({ t: 'link', v: m[9], href: m[9] })
    } else if (m[10] !== undefined) {
      spans.push({ t: 'link', v: m[10], href: `https://t.me/${m[10].slice(1)}` })
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

/** Разбирает markdown-lite поста на блоки: абзацы, цитаты, блоки кода */
export function blocksOf(text: string): Block[] {
  const blocks: Block[] = []
  const lines = reorderMarkersAroundLinks(
    decodeHrefAmpersands(normalizeDecorations(normalizeLegacyHtml(text))),
  ).split('\n')
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
