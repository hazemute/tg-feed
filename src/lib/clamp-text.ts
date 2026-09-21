'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { blocksOf } from '@/lib/markdown'

/**
 * Обрезка длинных текстов постов «по-человечески» (жалоба владельца: текст
 * обрезался посреди слова/строки градиентом с «...еще» поверх).
 *
 * Принцип: превью — это НЕ визуальный клип по высоте, а УКОРОЧЕННЫЙ текст,
 * который заканчивается на ЦЕЛОМ слове (граница слова), с инлайн-кнопкой
 * «еще» сразу за ним — как в нативном Telegram. Ничего не накладывается
 * на текст, ни одно слово не режется.
 *
 * Как находим длину превью: canvas-оценка «сколько символов помещается
 * в N строк» по реальному шрифту контейнера → маркер-безопасный срез
 * по последнему пробелу → контрольный замер отрендеренной высоты → при
 * недолёте/перелёте оценка сжимается/растягивается (2-3 итерации).
 * Markdown не ломаем: незакрытые **bold** / `код` / [ссылки](…)
 * и премиум-эмодзи ![ev:ID] откатывают срез к началу токена.
 */

/**
 * Сколько строк занимает превью текста на мобильных.
 *
 * v5.68 (запрос владельца): 5 строк резали ~80% постов — «виден только
 * заголовок, всегда нужно жать „еще"». Теперь бюджет 14 строк: посты
 * стандартной длины показываются ЦЕЛИКОМ, «еще» достаётся только
 * действительно длинным текстам.
 */
export const TEASER_LINES = 14

/**
 * Срез raw-markdown по границе слова не дальше limit символов,
 * с защитой от разрыва markdown-токенов.
 */
export function cutAtWord(text: string, limit: number): string {
  if (limit >= text.length) return text
  // Ищем последний пробельный символ не дальше limit — срез заканчивается
  // на целом слове (пробел не включается)
  let i = limit
  while (i > 0 && !/\s/.test(text[i] ?? '')) i--
  // Слово-монстр (длинный URL без пробелов) — режем жёстко по limit
  if (i <= Math.floor(limit * 0.4)) i = limit
  let cut = text.slice(0, i).replace(/[ \t]+$/, '')
  cut = balanceMarkers(text, cut)
  cut = dropJunkTail(cut)
  return cut.length > 0 ? cut : text.slice(0, limit)
}

/**
 * Чистка «мусорного хвоста»: если после среза последняя строка превью —
 * вырожденная (одинокий ├/•/—/- или 1-2 символа без букв/цифр), она
 * отрезается целиком. Иначе превью выглядит как «…├ еще» (некрасиво).
 */
function dropJunkTail(cut: string): string {
  for (let guard = 0; guard < 4; guard++) {
    const nl = cut.lastIndexOf('\n')
    const lastLine = (nl === -1 ? cut : cut.slice(nl + 1)).trim()
    if (lastLine.length === 0) {
      // Пустая строка в конце — просто убираем переводы строк
      cut = cut.replace(/\n+$/, '')
      continue
    }
    const hasWordChar = /[a-zA-Zа-яА-ЯёЁ0-9]/.test(lastLine)
    if (lastLine.length <= 2 || !hasWordChar) {
      if (nl === -1) break // весь срез — одна вырожденная строка: оставляем как есть
      cut = cut.slice(0, nl).replace(/[ \t]+$/, '')
      continue
    }
    break
  }
  return cut
}

/**
 * Regex «[» не после «!» (скобки эмодзи ![ev:ID] — не ссылки).
 * Lookbehind строится через new RegExp: на движках без поддержки (?<..)
 * regex-ЛИТЕРАЛ в коде стал бы синтаксической ошибкой всего бандла
 * (старые Safari < 16.4), а конструктор просто бросает ловимую ошибку —
 * тогда фолбэк на «все скобки» (деградация редкого случая).
 */
function linkOpenRe(): RegExp {
  try {
    return new RegExp('(?<!!)\\[', 'g')
  } catch {
    return /\[/g
  }
}

/** Полная ссылка [текст](url) не после «!» (см. linkOpenRe про lookbehind) */
function linkClosedRe(): RegExp {
  try {
    return new RegExp('(?<!!)\\[[^\\]]+\\]\\([^()\\s]*\\)', 'g')
  } catch {
    return /\[[^\]]+\]\([^()\s]*\)/g
  }
}

/**
 * Откат среза к началу незакрытого markdown-токена: если внутри превью
 * остался «висящий» opener (**, __, `, ||, ![ev:, [ссылка…) — срез
 * отодвигается перед ним, чтобы рендер превью не выдал мусорные символы.
 */
function balanceMarkers(_text: string, cut: string): string {
  let end = cut.length
  for (let guard = 0; guard < 8; guard++) {
    let next = end
    const backTo = (idx: number) => {
      if (idx >= 0 && idx < next) next = idx
    }
    const head = cut.slice(0, end)

    // Парные инлайн-токены: **жирный**, __курсив__, ~~зачёркнутый~~, ^^, ||спойлер||
    for (const tok of ['**', '__', '~~', '^^', '||']) {
      let count = 0
      let pos = head.indexOf(tok)
      let last = -1
      while (pos !== -1) {
        count++
        last = pos
        pos = head.indexOf(tok, pos + tok.length)
      }
      if (count % 2 === 1) backTo(last)
    }

    // Инлайн-код `…` (и нечётные бэктики)
    {
      const ticks = (head.match(/`/g) ?? []).length
      if (ticks % 2 === 1) backTo(head.lastIndexOf('`'))
    }

    // Блоки кода ```…``` (нечётное число фенсов)
    {
      const fences = (head.match(/```/g) ?? []).length
      if (fences % 2 === 1) backTo(head.lastIndexOf('```'))
    }

    // Премиум-эмодзи ![e:ID](url) / ![ev:ID](url) / ![el:ID](url) — не оставляем
    // «висящий» обрывок. Сравниваем ПОЛНЫЕ маркеры (с ](url)) с любыми ![e —
    // раньше учитывались только двухбуквенные ev:/el: (однобуквенная ![e: пропускала
    // обрыв внутри ID), а «![el:ID]» без (url) считался закрытым и утекал текстом.
    {
      const complete = (head.match(/!\[e(?:v|l)?(?::\d+)?\]\([^)\s]*\)/g) ?? []).length
      const any = (head.match(/!\[e/g) ?? []).length
      if (any > complete) backTo(head.lastIndexOf('!['))
    }

    // Ссылки [текст](url) — незакрытая скобка откатывается к «[».
    // Скобки премиум-эмодзи ![ev:ID] ссылками не являются (не после «!»)
    {
      let opens = 0
      let lastBracket = -1
      for (const m of head.matchAll(linkOpenRe())) {
        opens++
        lastBracket = m.index ?? lastBracket
      }
      const closed = (head.match(linkClosedRe()) ?? []).length
      if (opens > closed) backTo(lastBracket)
    }

    if (next === end) break
    end = next
    cut = cut.slice(0, end)
  }
  return cut.slice(0, end).replace(/[ \t]+$/, '')
}

/**
 * Срез для превью ленты: как cutAtWord, но с ДВУМЯ гарантиями (жалобы
 * владельца: «еще» уезжало на отдельную строку; у поста с цитатой/списком
 * в хвосте превью могло остаться ПУСТЫМ):
 *
 * 1. «еще» клеится к тексту — RichText ставит trailing-кнопку в ту же строку
 *    только если последний блок — абзац (p); после цитаты/списка/кода/таблицы
 *    она рендерится отдельной строкой. Поэтому хвостовые НЕ-абзацы отрезаются,
 *    пока последний блок не станет абзацем с видимым текстом.
 * 2. Превью не бывает пустым — если срез выродился (весь превью — цитата
 *    или другой не-абзац), берётся видимый кусок первого абзаца; если и его
 *    нет — сырой срез cutAtWord (что-то видимое всегда отрендерится).
 */
export function teaserCut(text: string, limit: number): string {
  let cut = cutAtWord(text, limit)

  // Отрезаем хвостовые блоки не-абзацы (и пустые абзацы из одних переносов)
  for (let guard = 0; guard < 6; guard++) {
    const blocks = blocksOf(cut)
    if (blocks.length === 0) break
    const last = blocks[blocks.length - 1]
    const visible = last.type === 'p' ? blockVisibleLength(last) : 0
    if (last.type === 'p' && visible > 0) break // годный хвост — абзац с текстом
    const nl = cut.lastIndexOf('\n')
    if (nl <= 0) {
      cut = ''
      break
    }
    cut = cut.slice(0, nl).replace(/[ \t]+$/, '')
  }

  if (cut.length > 0) return cut

  // Фолбэк: видимый кусок ПЕРВОГО абзаца (текст может начинаться цитатой —
  // тогда превью из цитаты дало бы пустоту или «еще» на своей строке)
  const paraEnd = text.search(/\n\n/)
  const firstPara = paraEnd === -1 ? text : text.slice(0, paraEnd)
  const paraCut = cutAtWord(firstPara, limit)
  if (blockVisibleLengthSafe(paraCut) > 0) return paraCut
  // Последний рубеж: сырой срез — что-то видимое отрендерится всегда
  return cutAtWord(text, Math.max(40, limit))
}

/** Видимая длина среза (плоская оценка: маркеры стилей ≈ 0, эмодзи ≈ 2 символа) */
function blockVisibleLengthSafe(cut: string): number {
  const blocks = blocksOf(cut)
  let n = 0
  for (const b of blocks) n += b.type === 'p' ? blockVisibleLength(b) : 0
  return n
}

/** Видимая длина p-блока по спанам (плоская, без рендера) */
function blockVisibleLength(block: Extract<import('@/lib/markdown').Block, { type: 'p' }>): number {
  let n = 0
  const walk = (spans: import('@/lib/markdown').Span[]): void => {
    for (const s of spans) {
      if ('kids' in s && s.kids?.length) walk(s.kids)
      if ('v' in s) n += s.v.length
      if (s.t === 'emoji') n += 2 // эмодзи-картинка занимает место
    }
  }
  walk(block.spans)
  return n
}

/** Оценка «сколько символов raw-текста помещается в lines строк» */
function estimateChars(el: HTMLElement, text: string, lines: number): number {
  const cs = getComputedStyle(el)
  const width = el.clientWidth
  if (width <= 0) return 200
  let sample = text
    .replace(/!\[[a-z]{2}:[^\]]*\]/g, ' ') // эмодзи-маркеры → пробел
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [текст](url) → текст
    .replace(/(\*\*|__|~~|\^\^|\|\||`)/g, '') // стилевые маркеры
    .replace(/^#{1,3} /gm, '')
    .slice(0, 400)
    .trim()
  if (sample.length < 8) sample = 'йцукенгшщзхъфывапролджэячсмитьбю The quick brown fox 0123'
  const canvas = measureCanvas ??= document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return 200
  ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  const avg = ctx.measureText(sample).width / sample.length
  if (!Number.isFinite(avg) || avg <= 0) return 200
  // 0.94 — лёгкий недолёт: контрольный замер подправит
  return Math.max(40, Math.floor((lines * width * 0.94) / avg))
}

let measureCanvas: HTMLCanvasElement | null = null

/** Хук: укороченный до lines строк вариант text (или null — помещается целиком) */
export function useLineTruncate(
  text: string,
  lines: number,
  enabled: boolean,
): { ref: React.RefObject<HTMLDivElement | null>; cut: string | null } {
  const ref = useRef<HTMLDivElement>(null)
  const [cut, setCut] = useState<string | null>(null)
  const estRef = useRef(0)
  const attemptsRef = useRef(0)
  const fullRef = useRef(text) // текст, с которым синхронизировано состояние

  // Поворот экрана / смена ширины окна → пересчёт с нуля
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    let t = 0
    const onResize = () => {
      window.clearTimeout(t)
      t = window.setTimeout(() => {
        estRef.current = 0
        attemptsRef.current = 0
        setCut(null)
      }, 150)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('resize', onResize)
    }
  }, [enabled])

  /*
   * Единый цикл подгонки — useLayoutEffect + синхронный setState.
   * Это каноничный паттерн React «измерь до отрисовки»: замер высоты
   * отрендеренного текста выполняется до paint, setState перерисовывает
   * кадр тоже до paint — мигнуть полным текстом срез не успевает.
   * Правило react-hooks/set-state-in-effect отключено для этого эффекта
   * осознанно (см. eslint-disable ниже) — асинхронный setState здесь дал бы
   * заметный скачок высоты уже ПОСЛЕ отрисовки кадра.
   */
  /* eslint-disable react-hooks/set-state-in-effect */
  useLayoutEffect(() => {
    if (!enabled) {
      // Выключено (ПК/раскрытие) → полный текст
      estRef.current = 0
      attemptsRef.current = 0
      if (cut !== null) setCut(null)
      return
    }

    // Смена текста (перевод, другое сообщение) → сначала показываем полный
    if (fullRef.current !== text) {
      fullRef.current = text
      estRef.current = 0
      attemptsRef.current = 0
      if (cut !== null) {
        setCut(null)
        return
      }
    }

    const el = ref.current
    if (!el) return
    const cs = getComputedStyle(el)
    const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5
    if (!Number.isFinite(lineH) || lineH <= 0) return
    const maxH = Math.round(lineH * lines) + 2
    const h = el.scrollHeight

    if (cut === null) {
      if (h <= maxH) return // целиком помещается — не режем
      if (attemptsRef.current === 0) estRef.current = estimateChars(el, text, lines)
      attemptsRef.current = 1
      // teaserCut: последний блок превью — абзац, «еще» клеится к тексту
      const cand = teaserCut(text, estRef.current)
      if (cand.length < text.length) setCut(cand)
      return
    }

    if (h <= maxH) {
      // Влезает. Если осталось много запаса — один шаг «показать больше»
      if (
        attemptsRef.current < 4 &&
        h < maxH - lineH * 1.1 &&
        estRef.current > 0 &&
        estRef.current < text.length
      ) {
        attemptsRef.current++
        estRef.current = Math.min(text.length - 1, Math.round(estRef.current * 1.18))
        const cand = teaserCut(text, estRef.current)
        if (cand.length > cut.length) setCut(cand)
      }
      return
    }

    // Не влезает — сжимаем оценку
    attemptsRef.current++
    estRef.current =
      attemptsRef.current > 5
        ? Math.round(estRef.current * 0.5)
        : Math.round(estRef.current * 0.78)
    const cand = teaserCut(text, Math.max(40, estRef.current))
    if (cand.length < cut.length) {
      setCut(cand)
    } else {
      // Предохранитель от залипания: гарантированно короче текущего
      setCut(teaserCut(cut, Math.max(40, Math.floor(cut.length * 0.7))))
    }
  }, [text, cut, lines, enabled])
  /* eslint-enable react-hooks/set-state-in-effect */

  return { ref, cut }
}
