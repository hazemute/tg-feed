'use client'

import { useState } from 'react'
import { haptic } from '@/lib/tg'
import { useApp } from '@/lib/store'
import { api } from '@/lib/api'
import { blocksOf, type Block, type Span } from '@/lib/markdown'
import { cn } from '@/lib/utils'

/**
 * Рендерер markdown-lite постов: **жирный**, __курсив__, ~~зачёркнутый~~,
 * `код`, ```блоки```, ||спойлеры|| (раскрываются тапом — как в Telegram),
 * кликабельные ссылки и @упоминания, цитаты с боковой чертой.
 * Хэштеги внутри обычного текста остаются кликабельными (поиск по теме).
 */

const HASHTAG_RE = /#[\wа-яё]{2,30}/gu

function HashtagText({ text }: { text: string }) {
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

  return (
    <>
      {parts.map((part, i) =>
        typeof part === 'string' ? (
          part
        ) : (
          <button
            key={i}
            type="button"
            aria-label={`Найти по теме ${part.tag}`}
            onClick={(e) => {
              e.stopPropagation()
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
          </button>
        ),
      )}
    </>
  )
}

/** Спойлер: скрыт размытием, тап раскрывает (как в Telegram) */
function Spoiler({ v }: { v: string }) {
  const [open, setOpen] = useState(false)
  return (
    <button
      type="button"
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
        'inline transition',
        open ? 'bg-tg-surface/60 rounded px-0.5' : 'rounded bg-tg-sep px-1 text-transparent',
      )}
      style={open ? undefined : { textShadow: '0 0 6px rgba(0,0,0,0.35)', filter: 'blur(5px)' }}
    >
      {v}
    </button>
  )
}

function SpanView({ span }: { span: Span }) {
  switch (span.t) {
    case 'plain':
      return <HashtagText text={span.v} />
    case 'bold':
      return <b className="font-bold">{span.v}</b>
    case 'italic':
      return <i>{span.v}</i>
    case 'strike':
      return <s className="opacity-70">{span.v}</s>
    case 'code':
      return (
        <code className="rounded bg-tg-sep/70 px-1 py-0.5 font-mono text-[0.92em] text-tg-text">
          {span.v}
        </code>
      )
    case 'spoiler':
      return <Spoiler v={span.v} />
    case 'link':
      return (
        <button
          type="button"
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
          {span.v}
        </button>
      )
  }
}

function BlockView({ block }: { block: Block }) {
  if (block.type === 'code') {
    return (
      <pre className="mt-2.5 overflow-x-auto rounded-xl bg-tg-sep/50 p-3 font-mono text-[13px] leading-relaxed text-tg-text">
        {block.v}
      </pre>
    )
  }
  return (
    <blockquote className="mt-2.5 border-l-[3px] border-tg-link/60 pl-3 text-tg-text2">
      {block.spans.map((s, i) => (
        <SpanView key={i} span={s} />
      ))}
    </blockquote>
  )
}

/**
 * Полный рендер поста (маркдаун + хэштеги). Контейнер — <div> с измеримой
 * высотой: clamp «...еще» в PostCard меряет scrollHeight этого div.
 * Абзацы — блочные div; переносы строк внутри абзаца сохраняет pre-line.
 */
export function RichText({ text, className }: { text: string; className?: string }) {
  const blocks = blocksOf(text)
  return (
    <div className={cn('text-post whitespace-pre-line break-words text-tg-text', className)}>
      {blocks.map((b, i) =>
        b.type === 'p' ? (
          <div key={i} className={i > 0 ? 'mt-2.5' : undefined}>
            {b.spans.map((s, j) => (
              <SpanView key={j} span={s} />
            ))}
          </div>
        ) : (
          <BlockView key={i} block={b} />
        ),
      )}
    </div>
  )
}
