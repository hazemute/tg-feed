'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { useApp } from '@/lib/store'

/**
 * TelegramEmojiRenderer — переиспользуемый рендерер премиум-эмодзи Telegram.
 *
 * Бэкенд-пайплайн (parse-engine → Supabase):
 *   1) парсер t.me/s ловит кастомные эмодзи (<tg-emoji emoji-id="ID"> и
 *      <i class="tgme_widget_message_inline_emoji">) и складывает в текст поста
 *      маркеры ![e:ID](thumb) / ![e](thumb);
 *   2) Bot API getCustomEmojiStickers подтверждает анимированные — маркеры
 *      переписываются в ![ev:ID](видео-webm) / ![el:ID](Lottie .tgs),
 *      file_id кэшируется в таблице CustomEmoji;
 *   3) /api/emoji/[id] отдаёт 302: видео — на CDN Telegram; Lottie — на наш
 *      /api/media (прямые cdn*.telesco.pe заблокированы у части провайдеров).
 *
 * Этот компонент принимает строку из БД (или готовые атрибуты), парсит маркеры
 * и рендерит эмодзи inline: видео — <video autoplay loop muted>, Lottie —
 * lottie-web (ленивый чанк, gzip распаковывает браузер), статичные — <img>.
 * Размер вписан в строку текста (1.35em), высота строк не ломается.
 *
 * Гейтинг Snap Plus/Pro: анимированные эмодзи (ev/el → <video>/lottie-web)
 * проигрываются только у подписчиков платных тиров; free всегда получает
 * статичную версию — <img> с thumb-URL из маркера (маркеры ev/el хранят тот
 * же thumb, что и e: апгрейд переписывает только префикс). Без thumb —
 * пустышка. Статичный путь не грузит ни lottie-чанк, ни видео.
 */

/** Маркеры эмодзи в тексте из БД: ![ev:ID](url) | ![el:ID](url) | ![e:ID](url) | ![e](url) */
const EMOJI_MARKER_RE = /!\[e(v|l)?(?::(\d+))?\]\(([^)\s]+)\)/g

const EMOJI_CLS =
  'mx-[1px] inline-block h-[1.35em] w-[1.35em] -translate-y-[0.16em] select-none object-contain align-middle'

/**
 * Видимость элемента на экране (IntersectionObserver).
 *  - initedOnce: анимация инициализируется ТОЛЬКО когда элемент попал в кадр
 *    (ленивая загрузка: офф-скрин эмодзи не грузят видео/lottie вообще);
 *  - visible: сейчас в кадре — вне кадра анимация на паузе (CPU/батарея).
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

/* ------------------------------------------------------------------ */
/* Lottie (.tgs): ленивый плеер на lottie-web                          */
/* ------------------------------------------------------------------ */

/** Браузер умеет распаковывать gzip сам? (Safari 16.4+, Chrome 80+) */
const CAN_GZIP = typeof DecompressionStream === 'function'

/** Кэш распакованных JSON анимаций: id → promise (одна загрузка на все инстансы) */
const lottieJsonCache = new Map<string, Promise<object>>()

/** Динамический импорт lottie-web (лёгкая SVG-сборка) — чанк грузится один раз */
let lottiePlayerPromise: Promise<typeof import('lottie-web/build/player/lottie_light')> | null = null
function lottiePlayer() {
  lottiePlayerPromise ??= import('lottie-web/build/player/lottie_light')
  return lottiePlayerPromise
}

/**
 * .tgs = gzip(JSON Lottie). Байты: /api/emoji/[id] → 302 → /api/media →
 * (CDN Vercel) → Telegram CDN. Распаковка — DecompressionStream в браузере.
 */
function fetchLottieJson(id: string): Promise<object> {
  let p = lottieJsonCache.get(id)
  if (!p) {
    p = (async () => {
      const res = await fetch(`/api/emoji/${id}`)
      if (!res.ok) throw new Error(`emoji HTTP ${res.status}`)
      const buf = await res.arrayBuffer()
      const stream = new Blob([buf])
        .stream()
        .pipeThrough(new DecompressionStream('gzip'))
      const txt = await new Response(stream).text()
      return JSON.parse(txt) as object
    })()
    lottieJsonCache.set(id, p)
    p.catch(() => lottieJsonCache.delete(id)) // битая загрузка — не кэшируем
  }
  return p
}

/** Одно Lottie-эмодзи: SVG-анимация в inline-контейнере (пауза вне экрана) */
function LottieEmoji({ id, fallbackUrl }: { id: string; fallbackUrl?: string }) {
  const [failed, setFailed] = useState(false)
  const containerRef = useRef<HTMLSpanElement | null>(null)
  const animRef = useRef<import('lottie-web').AnimationItem | null>(null)
  const { ref, initedOnce, visible } = useEmojiVisibility()
  // Свежий visible без подписки в deps эффекта создания (см. ниже)
  const visibleRef = useRef(visible)
  useEffect(() => {
    visibleRef.current = visible
  }, [visible])

  useEffect(() => {
    if (!initedOnce || failed || animRef.current) return
    const el = containerRef.current
    if (!el) return
    let cancelled = false
    ;(async () => {
      try {
        const [json, lottie] = await Promise.all([fetchLottieJson(id), lottiePlayer()])
        if (cancelled || !containerRef.current) return
        /*
         * ДВА ГВОЗДЯ lottie-web:
         *  1) библиотека МУТИРУЕТ animationData → каждому инстансу нужна
         *     своя копия (общий кэш декодированного JSON остаётся нетронутым);
         *  2) `visible` НЕ в deps этого эффекта — иначе каждое изменение
         *     видимости destroy/recreate'ит анимацию (мигание, гонки).
         *     Паузой управляет отдельный эффект ниже через animRef.
         */
        const anim = lottie.default.loadAnimation({
          container: containerRef.current,
          renderer: 'svg',
          loop: true,
          autoplay: true,
          animationData: structuredClone(json),
          rendererSettings: { preserveAspectRatio: 'xMidYMid meet' },
        })
        animRef.current = anim
        if (!visibleRef.current) anim.pause()
      } catch {
        if (!cancelled) setFailed(true) // фолбэк на статичную картинку
      }
    })()
    return () => {
      cancelled = true
      animRef.current?.destroy()
      animRef.current = null
    }
  }, [initedOnce, failed, id])

  // Пауза вне зоны видимости / плей при появлении
  useEffect(() => {
    const anim = animRef.current
    if (!anim) return
    if (visible) anim.play()
    else anim.pause()
  }, [visible])

  if (failed) return <TgEmoji url={fallbackUrl} />
  return (
    // ВАЖНО: бокс всегда держит размер 1.35em (invisible, не hidden) —
    // нулевой контейнер не пересекается с вьюпортом, и IntersectionObserver
    // никогда не инициализировал бы анимацию (ленивый старт умирал навсегда)
    <span ref={ref} className="inline-block leading-none">
      <span
        ref={containerRef}
        aria-label="эмодзи"
        draggable={false}
        className={cn(EMOJI_CLS, !initedOnce && 'invisible')}
      />
    </span>
  )
}

/** Одно премиум-эмодзи: видео-стикер, Lottie-анимация или статичная картинка */
export function TgEmoji({
  url,
  id,
  animated,
  lottie,
}: {
  url?: string
  id?: string
  animated?: boolean
  lottie?: boolean
}) {
  const [broken, setBroken] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const { ref, initedOnce, visible } = useEmojiVisibility()
  /*
   * Гейтинг тиров: анимации (видео/lottie) — только Snap Plus/Pro.
   * Селектор возвращает boolean, поэтому перерисовка случается лишь при
   * фактической смене доступа, а не при любом чихе в сторе.
   */
  const allowAnimated = useApp((s) => s.user?.tier === 'plus' || s.user?.tier === 'pro')

  // Пауза вне зоны видимости / автозапуск при появлении (autoplay + loop)
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (visible) void v.play().catch(() => {})
    else v.pause()
  }, [visible])

  // Без доступа (free) анимационные маркеры проваливаются в статичную ветку
  // ниже: <img src={thumb}>. LottieEmoji при этом не монтируется вовсе —
  // динамический импорт lottie-web не срабатывает, <video> не создаётся.
  const wantVideo = allowAnimated && animated && id && !broken
  const wantLottie = allowAnimated && lottie && id && !broken && CAN_GZIP

  if (wantLottie) return <LottieEmoji id={id} fallbackUrl={url} />

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
  const parts: Array<
    { type: 'text'; v: string } | { type: 'emoji'; url: string; id?: string; animated?: boolean; lottie?: boolean }
  > = []
  let last = 0
  for (const m of text.matchAll(EMOJI_MARKER_RE)) {
    const i = m.index ?? 0
    if (i > last) parts.push({ type: 'text', v: text.slice(last, i) })
    parts.push({
      type: 'emoji',
      url: m[3],
      ...(m[2] ? { id: m[2] } : {}),
      ...(m[1] === 'v' ? { animated: true } : {}),
      ...(m[1] === 'l' ? { lottie: true } : {}),
    })
    last = i + m[0].length
  }
  if (last < text.length) parts.push({ type: 'text', v: text.slice(last) })

  return (
    <span className={cn('break-words', className)}>
      {parts.map((p, i) =>
        p.type === 'text' ? (
          <span key={i} className="whitespace-pre-wrap">{p.v}</span>
        ) : (
          <TgEmoji key={i} url={p.url} id={p.id} animated={p.animated} lottie={p.lottie} />
        ),
      )}
    </span>
  )
}
