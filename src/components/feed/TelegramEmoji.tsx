'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * TelegramEmojiRenderer — переиспользуемый рендерер премиум-эмодзи Telegram.
 *
 * Бэкенд-пайплайн (parse-engine → Supabase):
 *   1) парсер t.me/s ловит кастомные эмодзи (<tg-emoji emoji-id="ID"> и
 *      <i class="tgme_widget_message_inline_emoji">) и складывает в текст поста
 *      маркеры ![e:ID](thumb) / ![e](thumb);
 *   2) Bot API getCustomEmojiStickers подтверждает анимированные (is_video) —
 *      их маркеры переписываются в ![ev:ID](thumb), file_id видео-стикера
 *      кэшируется в таблице CustomEmoji;
 *   3) /api/emoji/[id] отдаёт 302 на CDN Telegram, резолвя file_id через
 *      двухуровневый кэш (память → Upstash Redis) — браузер кэширует редирект.
 *
 * Этот компонент принимает строку из БД (или готовые атрибуты), парсит маркеры
 * и рендерит эмодзи inline: анимированные — <video autoplay loop muted>,
 * статичные — <img>. Размер вписан в строку текста (1.35em), высота строк
 * не ломается.
 */

/** Маркеры эмодзи в тексте из БД: ![ev:ID](url) | ![e:ID](url) | ![e](url) */
const EMOJI_MARKER_RE = /!\[e(v)?(?::(\d+))?\]\(([^)\s]+)\)/g

const EMOJI_CLS =
  'mx-[1px] inline-block h-[1.35em] w-[1.35em] -translate-y-[0.16em] select-none object-contain align-middle'

/**
 * Видимость элемента на экране (IntersectionObserver).
 *  - initedOnce: анимация инициализируется ТОЛЬКО когда элемент попал в кадр
 *    (ленивая загрузка: офф-скрин эмодзи не грузят видео вообще);
 *  - visible: сейчас в кадре — вне кадра видео ставится на паузу (CPU/батарея).
 */
function useEmojiVisibility() {
  const ref = useRef<HTMLSpanElement | null>(null)
  const [initedOnce, setInitedOnce] = useState(false)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      // нет IO (старый WebView) — показываем сразу, асинхронно (без setState в теле эффекта)
      const id = requestAnimationFrame(() => {
        setInitedOnce(true)
        setVisible(true)
      })
      return () => cancelAnimationFrame(id)
    }
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries.some((e) => e.isIntersecting)
        setVisible(hit)
        if (hit) setInitedOnce(true) // первый показ — ленивая инициализация
      },
      { rootMargin: '220px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return { ref, initedOnce, visible }
}

/** Одно премиум-эмодзи: анимированный видео-стикер или статичная картинка */
export function TgEmoji({
  url,
  id,
  animated,
}: {
  url?: string
  id?: string
  animated?: boolean
}) {
  const [broken, setBroken] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const { ref, initedOnce, visible } = useEmojiVisibility()

  // Пауза вне зоны видимости / автозапуск при появлении (autoplay + loop)
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (visible) void v.play().catch(() => {})
    else v.pause()
  }, [visible])

  const wantVideo = animated && id && !broken

  return (
    <span ref={ref} className="inline-block leading-none">
      {wantVideo && initedOnce ? (
        <video
          ref={videoRef}
          src={`/api/emoji/${id}`}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          aria-label="эмодзи"
          draggable={false}
          className={EMOJI_CLS}
          onError={() => setBroken(true)}
        />
      ) : url && !broken ? (
        <img
          src={url}
          alt="эмодзи"
          loading="lazy"
          decoding="async"
          className={EMOJI_CLS}
          draggable={false}
          onError={(e) => {
            // картинка не загрузилась — прячем, остаётся соседний текст
            e.currentTarget.style.display = 'none'
          }}
        />
      ) : null}
    </span>
  )
}

/**
 * Рендер строки из БД с премиум-эмодзи: маркеры ![e:ID](url) заменяются
 * анимированными/статичными эмодзи, остальной текст выводится как есть.
 * Для полноценного markdown-рендера используйте RichText — он использует
 * тот же TgEmoji внутри спанов.
 */
export function TelegramEmojiRenderer({
  text,
  className,
}: {
  text: string
  className?: string
}) {
  const parts: Array<{ type: 'text'; v: string } | { type: 'emoji'; url: string; id?: string; animated?: boolean }> = []
  let last = 0
  for (const m of text.matchAll(EMOJI_MARKER_RE)) {
    const i = m.index ?? 0
    if (i > last) parts.push({ type: 'text', v: text.slice(last, i) })
    parts.push({ type: 'emoji', url: m[3], ...(m[2] ? { id: m[2] } : {}), ...(m[1] ? { animated: true } : {}) })
    last = i + m[0].length
  }
  if (last < text.length) parts.push({ type: 'text', v: text.slice(last) })

  return (
    <span className={cn('break-words', className)}>
      {parts.map((p, i) =>
        p.type === 'text' ? (
          <span key={i} className="whitespace-pre-wrap">{p.v}</span>
        ) : (
          <TgEmoji key={i} url={p.url} id={p.id} animated={p.animated} />
        ),
      )}
    </span>
  )
}
