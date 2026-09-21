/**
 * Мини-подсветка синтаксиса без внешних зависимостей.
 *
 * Посты Telegram редко содержат промышленный код — обычно это сниппеты 10–30
 * строк. Полноценный лексер не нужен: выделяем только самые значимые токены —
 * комментарии, строки, числа, ключевые слова. Работает ПОСТРОЧНО (многострочные
 * строки/комментарии в постах почти не встречаются), поэтому состояние между
 * строками не тянем — подсветка безопасна и предсказуема.
 */

export type CodeToken = { t: 'kw' | 'str' | 'num' | 'com' | 'plain'; v: string }

/** Объединённый набор ключевых слов популярных языков (js/ts/py/go/c/sql/sh) */
const KEYWORDS = new Set(
  (
    'abstract arguments async await break case catch class const constructor continue debugger default delete do ' +
    'else enum export extends false final finally for from function get if implements import in instanceof ' +
    'interface let new null of package private protected public readonly return set static super switch this throw ' +
    'true try type typeof var void while with yield as satisfies keyof infer namespace declare override ' +
    'def elif except lambda pass raise global nonlocal assert del is not and or None True False self ' +
    'print int str float bool list dict set tuple len range enumerate zip map filter open sorted sum min max ' +
    'func go defer chan struct select fallthrough nil error make append ' +
    'unsigned signed typedef printf include define ' +
    'SELECT FROM WHERE INSERT UPDATE DELETE JOIN LEFT RIGHT INNER OUTER GROUP ORDER LIMIT VALUES INTO AND OR NOT NULL AS ON COUNT ' +
    'echo cd ls mkdir rm cp mv cat sudo apt git docker npm bun node yarn pip curl wget chmod export source alias'
  ).split(/\s+/),
)

/** Языки с #-комментариями */
const HASH_LANGS = new Set([
  'py', 'python', 'py3', 'sh', 'bash', 'shell', 'zsh', 'console', 'terminal',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'rb', 'ruby', 'perl', 'r',
  'dockerfile', 'makefile', 'gitignore', 'env',
])

const HTML_LANGS = new Set(['html', 'xml', 'svg', 'vue', 'svelte'])

/** Разбирает строку кода на токены для подсветки */
export function tokenizeCodeLine(line: string, lang?: string): CodeToken[] {
  const toks: CodeToken[] = []
  const l = (lang ?? '').toLowerCase()
  const isHash = HASH_LANGS.has(l)
  const isHtml = HTML_LANGS.has(l)
  let i = 0

  const push = (t: CodeToken['t'], v: string) => {
    if (v) toks.push({ t, v })
  }

  while (i < line.length) {
    const rest = line.slice(i)

    // Комментарии до конца строки
    if (isHtml && rest.startsWith('<!--')) {
      push('com', rest)
      break
    }
    if (isHash && rest.startsWith('#')) {
      push('com', rest)
      break
    }
    if (!isHash && (rest.startsWith('//') || rest.startsWith('/*'))) {
      push('com', rest)
      break
    }

    const ch = line[i]

    // Строки (одинарные/двойные кавычки, бэктики) с экранированием
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      while (j < line.length) {
        if (line[j] === '\\') {
          j += 2
          continue
        }
        if (line[j] === ch) {
          j++
          break
        }
        j++
      }
      push('str', line.slice(i, j))
      i = j
      continue
    }

    // Числа (не после буквы — «x2» не число)
    if (ch >= '0' && ch <= '9' && !/[A-Za-z_$]/.test(line[i - 1] ?? '')) {
      const m = rest.match(/^\d[\d_]*(?:\.\d+)?/)
      if (m) {
        push('num', m[0])
        i += m[0].length
        continue
      }
    }

    // Идентификаторы
    const idm = rest.match(/^[A-Za-z_$][\w$]*/)
    if (idm) {
      const word = idm[0]
      push(KEYWORDS.has(word) ? 'kw' : 'plain', word)
      i += word.length
      continue
    }

    push('plain', ch)
    i++
  }
  return toks
}
