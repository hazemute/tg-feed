import { blocksOf, stripMarkdown, type Block, type Span } from '@/lib/markdown'

/**
 * markdown-lite → Telegram HTML (parse_mode: 'HTML').
 *
 * «Живой канал» хранит и показывает текст как markdown-lite (**жирный**,
 * __курсив__, ||спойлер||, `код`, [текст](url) — рендерит RichText), а
 * Bot API ожидает HTML с parse_mode:'HTML'. Раньше в Telegram уходил СЫРОЙ
 * markdown: юзер видел литеральные «**звёздочки**», ||спойлеры|| и
 * [кривые ссылки](url), а любой символ «<» или «&» в тексте валил всю
 * публикацию («can't parse entities» → тост «Не удалось опубликовать»).
 *
 * Конвертер строит HTML из ТЕХ ЖЕ блоков/спанов, что рендерит RichText
 * (blocksOf/spansOf из lib/markdown — только чтение), с экранированием:
 *   **b** → <b>, __i__ → <i>, ~~s~~ → <s>, ^^u^^ → <u>, `c` → <code>,
 *   ||spoiler|| → <tg-spoiler>, [t](u) → <a>, > цитата → <blockquote>,
 *   ## заголовок → <b>, ```код``` → <pre>, таблицы/списки → текстовые строки.
 * Премиум-эмодзи ![e:ID](url) — миниапп-нотация, в Bot API без entities
 * не переносится: маркер снимается парсером как мусор.
 *
 * БД при этом продолжает хранить исходный markdown-lite (RichText в
 * миниаппе рендерит его как раньше) — конвертация только для Bot API.
 */

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Спаны одной строки → HTML (вложенность ограничена MAX_SPAN_DEPTH парсера) */
function spansToHtml(spans: Span[]): string {
  let out = ''
  for (const s of spans) {
    switch (s.t) {
      case 'plain':
        out += esc(s.v)
        break
      case 'bold':
        out += `<b>${spansToHtml(s.kids && s.kids.length > 0 ? s.kids : [{ t: 'plain', v: s.v }])}</b>`
        break
      case 'italic':
        out += `<i>${spansToHtml(s.kids && s.kids.length > 0 ? s.kids : [{ t: 'plain', v: s.v }])}</i>`
        break
      case 'strike':
        out += `<s>${spansToHtml(s.kids && s.kids.length > 0 ? s.kids : [{ t: 'plain', v: s.v }])}</s>`
        break
      case 'underline':
        out += `<u>${spansToHtml(s.kids && s.kids.length > 0 ? s.kids : [{ t: 'plain', v: s.v }])}</u>`
        break
      case 'spoiler':
        out += `<tg-spoiler>${spansToHtml(s.kids && s.kids.length > 0 ? s.kids : [{ t: 'plain', v: s.v }])}</tg-spoiler>`
        break
      case 'code':
        out += `<code>${esc(s.v)}</code>`
        break
      case 'link': {
        const label = spansToHtml(s.kids && s.kids.length > 0 ? s.kids : [{ t: 'plain', v: s.v }])
        out += `<a href="${esc(s.href)}">${label}</a>`
        break
      }
      case 'emoji':
        // Премиум-эмодзи миниаппа: в Telegram не переносим (нужен entities[],
        // HTML parse_mode их не умеет) — просто пропускаем.
        break
    }
  }
  return out
}

function rowToHtml(cells: Span[][]): string {
  return cells.map((c) => spansToHtml(c).replace(/\n/g, ' ')).join(' · ')
}

function blocksToHtml(blocks: Block[]): string {
  const lines: string[] = []
  for (const b of blocks) {
    switch (b.type) {
      case 'p':
        lines.push(spansToHtml(b.spans))
        break
      case 'heading':
        // Заголовков в Telegram нет — жирная строка
        lines.push(`<b>${spansToHtml(b.spans)}</b>`)
        break
      case 'quote':
        lines.push(`<blockquote>${spansToHtml(b.spans).replace(/\n/g, '<br/>')}</blockquote>`)
        break
      case 'code':
        lines.push(`<pre><code${b.lang ? ` class="language-${esc(b.lang)}"` : ''}>${esc(b.v)}</code></pre>`)
        break
      case 'hr':
        lines.push('———')
        break
      case 'list':
        b.items.forEach((spans, i) => {
          lines.push(`${b.ordered ? `${b.start + i}.` : '•'} ${spansToHtml(spans)}`)
        })
        break
      case 'todo':
        b.items.forEach((it) => lines.push(`${it.done ? '☑' : '☐'} ${spansToHtml(it.spans)}`))
        break
      case 'table': {
        // Таблиц в Telegram не существует — строки с ячейками через «·»
        if (b.header) lines.push(`<b>${rowToHtml(b.header)}</b>`)
        for (const row of b.rows) lines.push(rowToHtml(row))
        break
      }
    }
  }
  return lines.filter((l) => l.length > 0).join('\n')
}

/**
 * markdown-lite → безопасный Telegram HTML. maxLen — безопасный потолок
 * результата (текст ≤4096, caption с фото ≤1024 — вызывающий передаёт свой
 * лимит): если конвертация раздула текст, источник ужимается и пересобирается.
 */
export function markdownToTelegramHtml(text: string, maxLen = 4000): string {
  let src = text.slice(0, 4000)
  let html = blocksToHtml(blocksOf(src))
  while (html.length > maxLen && src.length > 200) {
    src = src.slice(0, Math.floor(src.length * 0.8))
    html = blocksToHtml(blocksOf(src))
  }
  // Аварийный фолбэк: чистый текст без разметки (экранированный)
  if (html.length > 4096) html = esc(stripMarkdown(text)).slice(0, maxLen)
  return html
}
