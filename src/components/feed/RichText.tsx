'use client'

import { useState } from 'react'
import { Check, ChevronDown, Copy } from 'lucide-react'
import { haptic } from '@/lib/tg'
import { useApp } from '@/lib/store'
import { api } from '@/lib/api'
import { blocksOf, type Block, type Span } from '@/lib/markdown'
import { tokenizeCodeLine } from '@/lib/code-highlight'
import { TgEmoji } from '@/components/feed/TelegramEmoji'
import { cn } from '@/lib/utils'

/**
 * Рендерер markdown-lite постов: **жирный**, __курсив__, ~~зачёркнутый~~,
 * ^^подчёркнутый^^, `код`, ```блоки``` (с языком, подсветкой и копированием),
 * ||спойлеры|| (раскрываются тапом — как в Telegram), кликабельные ссылки
 * и @упоминания, #хэштеги (поиск по теме).
 *
 * Блоки: абзацы, заголовки #/##/###, цитаты > (вложенные >> и сворачиваемые
 * как expandable-цитаты Telegram), списки - / 1., чек-листы [ ]/[x],
 * разделители --- и таблицы | a | b |.
 */

const HASHTAG_RE = /#[\wа-яё]{2,30}/gu

function HashtagText({ text, nested }: { text: string; nested?: boolean }) {
  const openSearchWith = useApp((s) => s.openSearchWith)
  const parts: Array<string | { tag: string }> = []
  let last = 0
  for (const m of text.matchAll(HASHTAG_RE)) {
    const i = m.index ?? 0
    if (i > last) parts.push(text.slice(last, i))
    parts.push({ tag: m[0] })
    last = i + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))

  // Вложенные спаны (внутри ссылки/спойлера) не могут быть <button> —
  // HTML запрещает button в button; span с role="button" внутри другой кнопки,
  // клик не перехватываем — важнее поведение внешней ссылки
  const Tag = nested ? 'span' : 'button'
  return (
    <>
      {parts.map((part, i) =>
        typeof part === 'string' ? (
          part
        ) : (
          <Tag
            key={i}
            {...(nested ? { role: 'button' } : { type: 'button' as const })}
            aria-label={`Найти по теме ${part.tag}`}
            onClick={(e) => {
              e.stopPropagation()
              if (nested) return
              haptic('light')
              api('/api/hashtags/click', {
                method: 'POST',
                body: JSON.stringify({ tag: part.tag.slice(1) }),
              }).catch(() => {})
              openSearchWith(part.tag.slice(1))
            }}
            className="text-tg-link active:opacity-60"
          >
            {part.tag}
          </Tag>
        ),
      )}
    </>
  )
}

/** Спойлер: скрыт размытием с бегущим бликом, тап раскрывает (как в Telegram).
 *  nested — внутри другой кнопки: рендерим span вместо button (button в button запрещён) */
function Spoiler({
  v,
  kids,
  nested,
}: {
  v: string
  kids?: React.ReactNode
  nested?: boolean
}) {
  const [open, setOpen] = useState(false)
  const Tag = nested ? 'span' : 'button'
  return (
    <Tag
      {...(nested ? { role: 'button' } : { type: 'button' as const })}
      onClick={(e) => {
        e.stopPropagation()
        if (!open) {
          haptic('light')
          setOpen(true)
        }
      }}
      aria-label={open ? undefined : 'Спойлер — нажмите, чтобы показать'}
      aria-expanded={open}
      className={cn(
        'relative inline transition',
        open ? 'rounded bg-tg-surface/60 px-0.5' : 'rounded bg-tg-sep px-1 text-transparent',
      )}
      style={open ? undefined : { textShadow: '0 0 6px rgba(0,0,0,0.35)', filter: 'blur(5px)' }}
    >
      {kids ?? v}
      {/* Бегущий блик по закрытому спойлеру — намёк, что здесь что-то скрыто */}
      {!open && (
        <span aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded">
          <span className="absolute inset-0 animate-[tg-shimmer_2.8s_linear_infinite] bg-gradient-to-r from-transparent via-white/25 to-transparent bg-[length:200%_100%]" />
        </span>
      )}
    </Tag>
  )
}

/** Инлайн-эмодзи Telegram — общий ленивый плеер (TelegramEmoji.tsx):
 *  видео-стикеры и Lottie инициализируются только в зоне видимости,
 *  вне экрана — пауза */
function EmojiSpan({
  url,
  id,
  animated,
  lottie,
}: {
  url: string
  id?: string
  animated?: boolean
  lottie?: boolean
}) {
  return <TgEmoji url={url} id={id} animated={animated} lottie={lottie} />
}

function SpanView({ span, nested }: { span: Span; nested?: boolean }) {
  // Вложенная разметка внутри стилевых спанов (ссылка внутри жирного и т.п.).
  // nested=true — интерактивные элементы становятся span (button в button запрещён)
  const kids =
    'kids' in span && span.kids && span.kids.length > 0 ? (
      <>{span.kids.map((s, i) => (
        <SpanView key={i} span={s} nested={nested ?? true} />
      ))}</>
    ) : null

  switch (span.t) {
    case 'plain':
      return <HashtagText text={span.v} nested={nested} />
    case 'bold':
      return <b className="font-bold">{kids ?? span.v}</b>
    case 'italic':
      return <i>{kids ?? span.v}</i>
    case 'strike':
      return <s className="opacity-70">{kids ?? span.v}</s>
    case 'underline':
      return <span className="underline underline-offset-2">{kids ?? span.v}</span>
    case 'code':
      // whitespace-pre-wrap: инлайн-код может пересекать перенос строки
      // (судебные акты, цитаты) — разрывы сохраняются внутри <code>
      return (
        <code className="whitespace-pre-wrap rounded bg-tg-sep/70 px-1 py-0.5 font-mono text-[0.92em] text-tg-text">
          {span.v}
        </code>
      )
    case 'spoiler':
      return <Spoiler v={span.v} kids={kids} nested={nested} />
    case 'emoji':
      // Премиум-эмодзи Telegram (статика, видео-стикер или Lottie)
      return <EmojiSpan url={span.url} id={span.id} animated={span.animated} lottie={span.lottie} />
    case 'link':
      if (nested) {
        return (
          <span role="link" className="text-tg-link underline decoration-tg-link/30 underline-offset-2">
            {kids ?? span.v}
          </span>
        )
      }
      return (
        <button
          type="button"
          data-noswipe
          onClick={(e) => {
            e.stopPropagation()
            haptic('light')
            const href = span.href
            const tg = href.match(/^https?:\/\/t\.me\/(.+)$/)
            if (tg) {
              // t.me-ссылки открываем в Telegram-клиенте
              import('@/lib/tg').then(({ openTelegram }) => openTelegram(href))
            } else {
              import('@/lib/tg').then(({ openExternal }) => openExternal(href))
            }
          }}
          className="text-tg-link underline decoration-tg-link/30 underline-offset-2 active:opacity-60"
        >
          {kids ?? span.v}
        </button>
      )
  }
}

// ---------- Блоки ----------

/** Видимая длина контента блока (для решения о сворачивании) */
function spansLength(spans: Span[]): number {
  let n = 0
  const walk = (arr: Span[]) => {
    for (const s of arr) {
      if ('kids' in s && s.kids?.length) walk(s.kids)
      if ('v' in s) n += s.v.length
    }
  }
  walk(spans)
  return n
}

/** Заголовок #/##/### — крупный жирный текст с отступом сверху */
function HeadingView({ block }: { block: Extract<Block, { type: 'heading' }> }) {
  const cls =
    block.level === 1
      ? 'text-[1.22em] font-bold leading-snug tracking-tight'
      : block.level === 2
        ? 'text-[1.12em] font-bold leading-snug tracking-tight'
        : 'text-[1.03em] font-bold leading-snug'
  return (
    <div className={cn(cls, 'text-tg-text')}>
      {block.spans.map((s, i) => (
        <SpanView key={i} span={s} />
      ))}
    </div>
  )
}

/**
 * Цитата: боковая черта + лёгкая подложка. Глубина >, >>, >>> — усиливаем
 * отступ и черту. Длинные цитаты сворачиваются до ~3 строк с шевроном —
 * как expandable-цитаты в Telegram.
 */
function QuoteView({ block }: { block: Extract<Block, { type: 'quote' }> }) {
  const [open, setOpen] = useState(false)
  const len = spansLength(block.spans)
  const lineBreaks = spansLineBreaks(block.spans)
  const collapsible = len > 260 || lineBreaks > 5
  const depthStyle = Math.min(block.depth - 1, 2)

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-lg border-l-[3px] bg-tg-link/[0.055]',
        depthStyle === 0 && 'border-tg-link/60',
        depthStyle === 1 && 'ml-2 border-tg-link/45',
        depthStyle >= 2 && 'ml-4 border-tg-link/35',
      )}
    >
      <div
        className="whitespace-pre-line break-words pl-3 pr-2.5 py-2 text-tg-text2"
        style={collapsible && !open ? { maxHeight: '5.1em', overflow: 'hidden' } : undefined}
      >
        {block.spans.map((s, i) => (
          <SpanView key={i} span={s} />
        ))}
      </div>
      {collapsible && !open && (
        <>
          {/* Градиент растворяет обрезанный текст; шеврон раскрывает цитату */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-7 bg-gradient-to-t from-tg-bg via-tg-bg/85 to-transparent"
          />
          <button
            type="button"
            data-noswipe
            onClick={(e) => {
              e.stopPropagation()
              haptic('light')
              setOpen(true)
            }}
            aria-label="Показать цитату полностью"
            className="absolute bottom-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-tg-surface shadow-sm ring-1 ring-tg-sep/60 transition active:scale-90"
          >
            <ChevronDown className="h-3.5 w-3.5 text-tg-hint" />
          </button>
        </>
      )}
    </div>
  )
}

function spansLineBreaks(spans: Span[]): number {
  let n = 0
  const walk = (arr: Span[]) => {
    for (const s of arr) {
      if ('kids' in s && s.kids?.length) walk(s.kids)
      if ('v' in s) n += (s.v.match(/\n/g)?.length ?? 0)
    }
  }
  walk(spans)
  return n
}

/** Цвета токенов подсветки (тёплая палитра, читается на светлой подложке) */
const TOK_CLS: Record<string, string> = {
  kw: 'text-[#9a3412]',
  str: 'text-[#047857]',
  num: 'text-[#be185d]',
  com: 'italic text-tg-hint',
  plain: '',
}

/** Кол-во строк, при превышении которого блок кода сворачивается */
const CODE_COLLAPSE_LINES = 14

/**
 * Блок кода: подпись языка, кнопка «копировать», построчная подсветка,
 * длинные блоки сворачиваются (как в Telegram).
 */
function CodeBlockView({ block }: { block: Extract<Block, { type: 'code' }> }) {
  const [copied, setCopied] = useState(false)
  const [open, setOpen] = useState(false)
  const lines = block.v.split('\n')
  const collapsible = lines.length > CODE_COLLAPSE_LINES

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(block.v)
    } catch {
      // fallback для контекстов без clipboard API
      const ta = document.createElement('textarea')
      ta.value = block.v
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } catch {
        // тишина: не критично
      }
      ta.remove()
    }
    haptic('light')
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="overflow-hidden rounded-xl bg-tg-sep/40 ring-1 ring-tg-sep/50">
      <div className="flex items-center justify-between pb-0.5 pl-3 pr-1.5 pt-1.5">
        <span className="select-none text-[10.5px] font-semibold uppercase tracking-wider text-tg-hint">
          {block.lang ?? ''}
        </span>
        <button
          type="button"
          data-noswipe
          onClick={(e) => {
            e.stopPropagation()
            void copy()
          }}
          aria-label={copied ? 'Скопировано' : 'Копировать код'}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-tg-hint transition active:scale-90 active:bg-tg-sep/60"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-emerald-600" strokeWidth={2.5} />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      <div className="relative">
        <pre
          className="overflow-x-auto px-3 pb-2.5 pt-1 font-mono text-[13px] leading-[1.55] text-tg-text"
          style={collapsible && !open ? { maxHeight: '13.5em', overflow: 'hidden' } : undefined}
        >
          <code>
            {lines.map((ln, i) => (
              <div key={i}>
                {tokenizeCodeLine(ln, block.lang).map((tok, j) => (
                  <span key={j} className={TOK_CLS[tok.t]}>
                    {tok.v}
                  </span>
                ))}
                {ln.length === 0 ? '\u00A0' : null}
              </div>
            ))}
          </code>
        </pre>
        {collapsible && !open && (
          <>
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-tg-sep/40 via-tg-sep/20 to-transparent"
            />
            <button
              type="button"
              data-noswipe
              onClick={(e) => {
                e.stopPropagation()
                haptic('light')
                setOpen(true)
              }}
              aria-label="Показать код полностью"
              className="absolute bottom-2 right-2 flex h-6 w-6 items-center justify-center rounded-full bg-tg-surface shadow-sm ring-1 ring-tg-sep/60 transition active:scale-90"
            >
              <ChevronDown className="h-3.5 w-3.5 text-tg-hint" />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/** Список: буллеты • и нумерованные 1. 2. 3. с висячим отступом */
function ListView({ block }: { block: Extract<Block, { type: 'list' }> }) {
  return (
    <div className="space-y-1.5">
      {block.items.map((spans, i) => (
        <div key={i} className="flex items-start gap-2">
          <span
            aria-hidden
            className={cn(
              'shrink-0 select-none text-tg-hint',
              block.ordered ? 'min-w-[1.35em] text-right tabular-nums' : 'w-[1em] text-center',
            )}
          >
            {block.ordered ? `${block.start + i}.` : '•'}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre-line break-words">
            {spans.map((s, j) => (
              <SpanView key={j} span={s} />
            ))}
          </span>
        </div>
      ))}
    </div>
  )
}

/** Чек-лист [ ]/[x]: интерактивные чекбоксы (визуальный тап — как в TG-ботах) */
function TodoView({ block }: { block: Extract<Block, { type: 'todo' }> }) {
  // Локальное состояние тапов: посты — снимки ленты, серверный флаг не меняем
  const [state, setState] = useState<boolean[]>(() => block.items.map((it) => it.done))
  return (
    <div className="space-y-2">
      {block.items.map((it, i) => (
        <div key={i} className="flex items-start gap-2.5">
          <button
            type="button"
            data-noswipe
            onClick={(e) => {
              e.stopPropagation()
              haptic('light')
              setState((prev) => prev.map((v, j) => (j === i ? !v : v)))
            }}
            role="checkbox"
            aria-checked={state[i]}
            aria-label={state[i] ? 'Отметить как невыполненное' : 'Отметить как выполненное'}
            className={cn(
              'mt-[1px] flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-[6px] border transition active:scale-90',
              state[i] ? 'border-tg-link bg-tg-link text-white' : 'border-tg-sep bg-transparent',
            )}
          >
            {state[i] && <Check className="h-3 w-3" strokeWidth={3.2} aria-hidden />}
          </button>
          <span
            className={cn(
              'min-w-0 flex-1 whitespace-pre-line break-words transition',
              state[i] && 'text-tg-hint line-through opacity-75',
            )}
          >
            {it.spans.map((s, j) => (
              <SpanView key={j} span={s} />
            ))}
          </span>
        </div>
      ))}
    </div>
  )
}

/** Разделитель — тонкая линия с точкой по центру (как декоративные *** в постах) */
function HrView() {
  return (
    <div className="flex items-center gap-2 py-0.5" aria-hidden>
      <div className="h-px flex-1 bg-tg-sep" />
      <div className="h-[3px] w-[3px] rounded-full bg-tg-sep" />
      <div className="h-px flex-1 bg-tg-sep" />
    </div>
  )
}

/** Таблица: рамки, зебра, заголовок, горизонтальный скролл на узких экранах */
function TableView({ block }: { block: Extract<Block, { type: 'table' }> }) {
  return (
    <div className="overflow-x-auto rounded-xl ring-1 ring-tg-sep/60" data-noswipe>
      <table className="w-max min-w-full border-collapse text-[13.5px] leading-snug">
        {block.header && (
          <thead>
            <tr className="bg-tg-sep/40">
              {block.header.map((cell, i) => (
                <th
                  key={i}
                  className="whitespace-pre-line border-l border-tg-sep/50 px-2.5 py-1.5 text-left font-semibold first:border-l-0"
                >
                  {cell.map((s, j) => (
                    <SpanView key={j} span={s} />
                  ))}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r} className={r % 2 === 1 ? 'bg-tg-sep/20' : undefined}>
              {row.map((cell, c) => (
                <td
                  key={c}
                  className="whitespace-pre-line border-l border-t border-tg-sep/40 px-2.5 py-1.5 align-top first:border-l-0"
                >
                  {cell.map((s, j) => (
                    <SpanView key={j} span={s} />
                  ))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function BlockView({ block, first, trailing }: { block: Block; first: boolean; trailing?: React.ReactNode }) {
  const inner = (() => {
    switch (block.type) {
      case 'p':
        return (
          <div className="whitespace-pre-line break-words">
            {block.spans.map((s, j) => (
              <SpanView key={j} span={s} />
            ))}
            {/* Инлайн-кнопка «еще» в конце обрезанного превью — в той же строке,
                что и последнее слово (как в Telegram), без наложения градиента */}
            {trailing}
          </div>
        )
      case 'heading':
        return <HeadingView block={block} />
      case 'quote':
        return <QuoteView block={block} />
      case 'code':
        return <CodeBlockView block={block} />
      case 'hr':
        return <HrView />
      case 'list':
        return <ListView block={block} />
      case 'todo':
        return <TodoView block={block} />
      case 'table':
        return <TableView block={block} />
    }
  })()
  return <div className={first ? undefined : 'mt-2.5'}>{inner}</div>
}

/**
 * Полный рендер поста (маркдаун + хэштеги). Контейнер — <div> с измеримой
 * высотой: clamp «еще» в PostCard меряет высоту этого div.
 *
 * trailing — узел, дописываемый В КОНЕЦ последнего абзаца (кнопка «еще»
 * обрезанного превью стоит сразу за последним словом, на той же строке;
 * если последний блок не абзац — узел встаёт после блоков, отдельной строкой).
 */
export function RichText({
  text,
  className,
  trailing,
}: {
  text: string
  className?: string
  trailing?: React.ReactNode
}) {
  const blocks = blocksOf(text)
  // Последний абзац — единственное место, где trailing встаёт в ту же строку
  let trailingAt = -1
  if (trailing) {
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].type === 'p') {
        trailingAt = i
        break
      }
    }
  }
  return (
    <div className={cn('text-post break-words text-tg-text', className)}>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} first={i === 0} trailing={i === trailingAt ? trailing : undefined} />
      ))}
      {trailing && trailingAt === -1 && <div className="mt-1">{trailing}</div>}
    </div>
  )
}
