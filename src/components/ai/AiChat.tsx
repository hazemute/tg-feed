'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, CalendarClock, Check, Copy, History, Loader2, Rocket, Send, Sparkles, SquarePen, Trash2 } from 'lucide-react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api, getSessionToken } from '@/lib/api'
import { useApp } from '@/lib/store'
import { haptic, useBackButton } from '@/lib/tg'
import { stripMarkdown } from '@/lib/markdown'
import { timeAgo, timeAgoRu, pluralRu } from '@/lib/format'
import type { MediaItemDTO, PostDTO } from '@/lib/types'
import { RichText } from '@/components/feed/RichText'
import { MediaLightbox } from '@/components/feed/MediaLightbox'
import { Avatar } from '@/components/tg/Avatar'
import { VerifiedBadge } from '@/components/tg/VerifiedBadge'
import { ChatInput } from '@/components/ai/ChatInput'

/**
 * ОТДЕЛЬНЫЙ ИИ-ЧАТ (v5.21): полноэкранная поверхность для ассистента канала
 * и ИИ-поиска — как чат в Telegram.
 *
 *  • пузыри: свои справа (tg-link), бот слева с КРАСИВЫМ MARKDOWN (RichText);
 *  • статусы «думаю»: мигающие точки + человекочитаемый этап инструмента
 *    («Смотрю тренды ленты…», «Рисую картинку…») — приходят по SSE;
 *  • картинки бота рендерятся под сообщением (инструмент generate_image);
 *  • ИНЛАЙН-КНОПКИ в цветах Telegram: filled-синие primary / серые secondary
 *    («Опубликовать в канал», «Нарисовать картинку»);
 *  • источники поиска — карточки постов (тап — экран канала);
 *  • ввод — ChatInput: слитая капсула, микрофон ⇄ отправка, голосовой ввод;
 *  • история живёт в localStorage отдельно для каждого чата.
 */

export type AiChatKind = 'assistant' | 'search'

type AiMsg = {
  id: string
  role: 'user' | 'assistant'
  text: string
  at: string
  imageUrl?: string
  imagePending?: boolean
  draftText?: string
  draftTopic?: string
  publishedLink?: string
  inviteLink?: string // v5.64: созданная пригласительная ссылка
  scheduledAt?: string // v5.64: время отложенной публикации (ISO)
  sources?: PostDTO[]
  steps?: Array<{ label: string; ok: boolean }>
  failed?: boolean
}

const MAX_HISTORY = 24
const uid = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

function storeKey(kind: AiChatKind, channelId?: string): string {
  return `snap_ai_chat_${kind}${channelId ? `_${channelId}` : ''}`
}

function loadHistory(kind: AiChatKind, channelId?: string): AiMsg[] {
  try {
    const raw = localStorage.getItem(storeKey(kind, channelId))
    if (!raw) return []
    const arr = JSON.parse(raw) as AiMsg[]
    return Array.isArray(arr) ? arr.slice(-MAX_HISTORY) : []
  } catch {
    return []
  }
}

function saveHistory(kind: AiChatKind, channelId: string | undefined, msgs: AiMsg[]): void {
  try {
    localStorage.setItem(storeKey(kind, channelId), JSON.stringify(msgs.slice(-MAX_HISTORY)))
  } catch {
    /* приватный режим — история просто не сохранится */
  }
}

const SUGGESTIONS: Record<AiChatKind, string[]> = {
  assistant: [
    'Оцени мой канал и дай план роста',
    'Напиши пост на актуальную тему',
    'Что сейчас в тренде ленты?',
    'Нарисуй обложку к посту',
    'Опубликуй пост завтра в 18:00',
    'Создай пригласительную ссылку',
    'Запомни: ниша моего канала — ',
    'Какие у меня задания? Что выполнено?',
    'Покажи последние операции кошелька',
    'Найди в интернете новости по моей теме',
  ],
  search: [
    'Что нового в ленте за сутки?',
    'Найди посты про нейросети',
    'О чём сейчас пишут каналы?',
    'Активные розыгрыши — призы и дедлайны',
    'Как заработать свайпы на заданиях?',
    'Найди в интернете свежие новости про…',
  ],
}

/**
 * v5.40: нормализация ChatGPT-маркдауна под наш RichText.
 * Модели пишут курсив одиночными *звёздочками* и _подчёркиваниями —
 * markdown-lite их не знает. Конвертируем в __парные__ только внутри строки
 * (буллеты «* пункт» и жирный ** не трогаем), одиночный _ — только слово-обёртка.
 */
export function aiNormalize(text: string): string {
  return text
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?![*\w])/g, '$1__$2__')
    .replace(/(^|[\s(>«"'])_([^_\n]+)_(?=[\s).,!?;:»"'<]|$)/g, '$1__$2__')
}

/**
 * v5.73: markdown ПОЛНОСТЬЮ под телефон. markdown-lite RichText не знает
 * заголовки # и таблицы — превращаем их в мобильный вид:
 *  • «### Заголовок» → жирная строка с отбивкой (сканимо на любом экране);
 *  • таблицы → компактные строки «A · B · C» (разделитель-строка |---| выкидывается);
 *  • «---» (hr) → пустая строка (линии в чате — шум).
 * Жирный/курсив/код/списки/ссылки рендерит RichText как есть.
 */
export function aiMobileMarkdown(input: string): string {
  const lines = aiNormalize(input).split('\n')
  const out: string[] = []
  for (const line of lines) {
    const t = line.trim()
    // Таблица: строка из пайпов
    if (t.startsWith('|') && t.endsWith('|')) {
      const cells = t.slice(1, -1).split('|').map((c) => c.trim())
      // Разделитель |---|---| — пропускаем
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue
      out.push(cells.join(' · '))
      continue
    }
    // Горизонтальная линия — в чате не нужна
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      out.push('')
      continue
    }
    // Заголовки #..###### → жирная строка
    const h = t.match(/^(#{1,6})\s+(.+)$/)
    if (h) {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('')
      out.push(`**${h[2].trim()}**`)
      out.push('')
      continue
    }
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/* ============================ Typing-индикатор ============================ */

function ThinkingBubble({ label }: { label: string | null }) {
  // v5.73: статус — ПЛОСКИЙ, по центру, без бабла (как системные строки в Telegram)
  return (
    <div className="flex items-center justify-center gap-2 py-1" aria-live="polite">
      <span className="flex gap-1" aria-hidden>
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="h-1 w-1 rounded-full bg-tg-hint"
            animate={{ opacity: [0.3, 1, 0.3] }}
            transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.18 }}
          />
        ))}
      </span>
      <span className="text-[12px] font-medium text-tg-hint">{label ?? 'Думаю…'}</span>
    </div>
  )
}

/* ============================ Инлайн-кнопки (цвета Telegram) ============================ */

/** Маленькая стрелка для строк-примеров (строгий маркер) */
function ArrowUpRightIcon() {
  return (
    <svg
      className="h-3.5 w-3.5 shrink-0 text-tg-hint"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </svg>
  )
}

function InlineButtons({
  msg,
  onPublish,
  onAskImage,
  publishing,
}: {
  msg: AiMsg
  onPublish: (m: AiMsg) => void
  onAskImage: (m: AiMsg) => void
  publishing: boolean
}) {
  const buttons: Array<{ label: string; onClick: () => void; kind: 'primary' | 'secondary'; icon: React.ReactNode; disabled?: boolean }> = []
  if (msg.draftText && !msg.publishedLink) {
    buttons.push({
      label: publishing ? 'Публикую…' : 'Опубликовать в канал',
      onClick: () => onPublish(msg),
      kind: 'primary',
      icon: publishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />,
      disabled: publishing,
    })
  }
  if (msg.draftText && !msg.imageUrl) {
    buttons.push({
      label: 'Нарисовать картинку',
      onClick: () => onAskImage(msg),
      kind: 'secondary',
      icon: <Sparkles className="h-4 w-4" />,
    })
  }
  if (msg.publishedLink) {
    return (
      <a
        href={msg.publishedLink}
        target="_blank"
        rel="noreferrer"
        className="press mt-2 inline-flex h-10 items-center gap-1.5 rounded-xl bg-tg-link px-4 text-[13.5px] font-semibold text-white"
      >
        <Rocket className="h-4 w-4" />
        Открыть пост в Telegram
      </a>
    )
  }
  if (buttons.length === 0) return null
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {buttons.map((b) => (
        <button
          key={b.label}
          type="button"
          data-noswipe
          onClick={b.onClick}
          disabled={b.disabled}
          className={cn(
            'flex h-10 items-center gap-1.5 rounded-xl px-3.5 text-[13.5px] font-semibold press',
            b.kind === 'primary'
              ? 'bg-tg-link text-white shadow-sm' // Telegram: filled primary
              : 'bg-tg-surface text-tg-link', // Telegram: secondary tint
            b.disabled && 'opacity-60',
          )}
        >
          {b.icon}
          {b.label}
        </button>
      ))}
    </div>
  )
}

/**
 * v5.70: голые ссылки на сгенерированные картинки из текста ответа убираем —
 * картинка рендерится под сообщением отдельно, а ссылки (особенно pollinations,
 * где при холодном кэше белый экран) в тексте только мешают.
 * Старая история в localStorage тоже проходит через эту чистку при рендере.
 */
function stripImageLinks(text: string): string {
  return text
    // markdown-ссылки/картинки на pollinations — целиком (ведут на «белую страницу»)
    .replace(/!?\[[^\]\n]*\]\(\s*https?:\/\/image\.pollinations\.ai\/[^\s)]*\s*\)/g, '')
    // голые pollinations-ссылки (с хвостовой пунктуацией не тянем)
    .replace(/https?:\/\/image\.pollinations\.ai\/[^\s)"'<>]+[^\s)"'<>.,!?;:]/g, '')
    // голые пути нашего хранилища /api/upload/<id>
    .replace(/(^|[^\w/\-])\/api\/upload\/[a-zA-Z0-9_-]+/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/* ============================ Картинка ассистента (generate_image) ============================ */

/**
 * v5.70: инлайн-рендер сгенерированной картинки — БЕЗ голых ссылок.
 * Скелет на время загрузки, клик → полноэкранный лайтбокс (MediaLightbox),
 * фолбэк-URL pollinations сам перезагружается, пока CDN досоздаёт файл.
 */
function ChatImage({ url, pending }: { url: string; pending?: boolean }) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [lightbox, setLightbox] = useState(false)

  // Фолбэк-картинка pollinations дозревает на их CDN (10–40с) — автоповторы
  const isPollinations = url.includes('pollinations.ai')
  useEffect(() => {
    if (!failed || !isPollinations || attempt >= 5) return
    const t = setTimeout(() => setAttempt((a) => a + 1), 10_000)
    return () => clearTimeout(t)
  }, [failed, isPollinations, attempt])

  // Повторная попытка — cache-buster меняет src и заставляет <img> перезагрузиться
  // (buster «липкий»: после первой попытки остаётся, чтобы не было лишних ремоунтов)
  const src = attempt > 0 ? `${url}${url.includes('?') ? '&' : '?'}retry=${attempt}` : url

  return (
    <>
      <button
        type="button"
        data-noswipe
        onClick={() => {
          if (failed) {
            // повтор: сбрасываем флаг — эффект сам перезапустит таймер,
            // а клик при живом url немедленно пробует загрузить снова
            setAttempt((a) => a + 1)
            setFailed(false)
            return
          }
          if (!loaded) return
          haptic('light')
          setLightbox(true)
        }}
        aria-label={failed ? 'Повторить загрузку картинки' : 'Открыть картинку во весь экран'}
        className="relative mt-1.5 block aspect-square w-full max-w-[300px] overflow-hidden rounded-2xl border border-tg-sep bg-tg-surface/60"
      >
        {/* img всегда с layout-боксом (display:none ломает lazy-load) —
            до загрузки он прозрачен, поверх лежит скелет */}
        <img
          key={src}
          src={src}
          alt="Сгенерированная иллюстрация"
          loading="lazy"
          decoding="async"
          onLoad={() => {
            setLoaded(true)
            setFailed(false)
          }}
          onError={() => setFailed(true)}
          className={cn(
            'h-full w-full object-cover transition-opacity duration-300',
            loaded ? 'opacity-100' : 'opacity-0',
          )}
        />
        {!loaded && !failed && (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-2">
            <Loader2 className="h-5 w-5 animate-spin text-tg-hint" />
            <span className="text-[11.5px] text-tg-hint">{pending ? 'Картинка досоздаётся…' : 'Загружаю…'}</span>
          </span>
        )}
        {failed && (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-2">
            <AlertCircle className="h-5 w-5 text-tg-hint" />
            <span className="text-[11.5px] text-tg-hint">Не удалось загрузить картинку</span>
            <span className="rounded-lg bg-tg-surface2 px-2.5 py-1 text-[11.5px] font-semibold text-tg-link">Повторить</span>
          </span>
        )}
      </button>
      {lightbox &&
        createPortal(
          <AnimatePresence>
            <MediaLightbox
              items={[{ kind: 'image', url: src } as MediaItemDTO]}
              index={0}
              onClose={() => setLightbox(false)}
            />
          </AnimatePresence>,
          document.body,
        )}
    </>
  )
}

/** Плейсхолдер «рисую…» — пока картинка ещё не имеет URL вовсе */
function ImagePendingPlaceholder() {
  return (
    <div
      className="mt-1.5 flex aspect-square w-full max-w-[300px] flex-col items-center justify-center gap-2 rounded-2xl border border-tg-sep bg-tg-surface/60"
      data-noswipe
      aria-live="polite"
    >
      <Sparkles className="h-5 w-5 animate-pulse text-tg-hint" />
      <span className="text-[11.5px] text-tg-hint">Рисую картинку…</span>
    </div>
  )
}

/* ============================ Карточка источника (поиск) ============================ */

function SourceRow({ post, index, onOpen }: { post: PostDTO; index: number; onOpen: () => void }) {
  return (
    <button
      type="button"
      data-noswipe
      onClick={onOpen}
      aria-label={`Открыть канал ${post.channel.title}`}
      className={cn(
        'flex w-full items-start gap-2.5 px-3.5 py-2.5 text-left transition active:bg-tg-surface2/50',
        index > 0 && 'border-t border-tg-sep/60',
      )}
    >
      <Avatar name={post.channel.title} color={post.channel.avatarColor} src={post.channel.avatarUrl} size={34} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate text-[13.5px] font-semibold text-tg-text">{post.channel.title}</span>
            {post.channel.verified && <VerifiedBadge size={12} />}
          </span>
          <span className="shrink-0 text-[11px] text-tg-hint">{timeAgoRu(post.publishedAt)}</span>
        </span>
        <span className="mt-0.5 line-clamp-2 block text-[12.5px] leading-snug text-tg-hint">
          {post.text ? stripMarkdown(post.text) || 'медиа-пост' : 'медиа-пост'}
        </span>
      </span>
    </button>
  )
}

/* ============================ Список чатов (v5.74) ============================ */

type SessionInfo = { id: string; title: string; updatedAt: string; lastPreview: string | null }

/**
 * Шторка «Чаты» (v5.74): история разговоров иишки — новый чат, переключение,
 * удаление. Память сквозная: даже в новом чате модель знает, о чём говорили
 * в прошлых (глобальный контекст приходит с сервера).
 */
function SessionsDrawer({
  kind,
  channelId,
  currentId,
  open,
  onClose,
  onPick,
}: {
  kind: AiChatKind
  channelId?: string
  currentId: string | null
  open: boolean
  onClose: () => void
  onPick: (id: string) => void
}) {
  const [list, setList] = useState<SessionInfo[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(() => {
    const token = getSessionToken()
    if (!token) {
      setList([])
      return
    }
    const url =
      `/api/ai/sessions?surface=${kind}` +
      (kind === 'assistant' && channelId ? `&channelId=${encodeURIComponent(channelId)}` : '')
    fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { sessions?: SessionInfo[] } | null) => setList(j?.sessions ?? []))
      .catch(() => setList([]))
  }, [kind, channelId])

  useEffect(() => {
    if (open) {
      setList(null)
      load()
    }
  }, [open, load])

  const remove = async (id: string) => {
    if (busyId) return
    setBusyId(id)
    try {
      const token = getSessionToken()
      if (token) {
        await fetch(`/api/ai/sessions?id=${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        })
      }
      setList((l) => (l ? l.filter((x) => x.id !== id) : l))
      haptic('success')
    } catch {
      toast.error('Не удалось удалить чат')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ x: '100%' }}
          animate={{ x: 0 }}
          exit={{ x: '100%' }}
          transition={{ type: 'spring', damping: 32, stiffness: 340 }}
          className="absolute inset-0 z-20 flex flex-col bg-tg-bg"
          role="dialog"
          aria-label="История чатов"
          data-noswipe
        >
          <header className="flex shrink-0 items-center gap-2 border-b border-tg-sep/60 bg-tg-bg px-2 py-2">
            <button
              type="button"
              onClick={onClose}
              aria-label="Назад к чату"
              className="flex h-11 w-11 items-center justify-center rounded-full text-tg-text active:bg-tg-surface"
            >
              <ArrowLeft className="h-5.5 w-5.5" />
            </button>
            <span className="min-w-0 flex-1 pl-1 text-[16px] font-bold text-tg-text">Чаты</span>
            <button
              type="button"
              onClick={() => {
                haptic('light')
                onPick('') // пустая строка = новый чат без сессии
                onClose()
              }}
              className="flex h-9 items-center gap-1.5 rounded-full bg-tg-link px-3.5 text-[13px] font-semibold text-white active:scale-95"
            >
              <SquarePen className="h-4 w-4" aria-hidden />
              Новый
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {list === null ? (
              <div className="flex justify-center py-10">
                <Loader2 className="h-5 w-5 animate-spin text-tg-hint" />
              </div>
            ) : list.length === 0 ? (
              <div className="mx-auto mt-12 max-w-[260px] text-center">
                <p className="text-[14.5px] font-semibold text-tg-text">Пока нет истории</p>
                <p className="mt-1 text-[12.5px] leading-snug text-tg-hint">
                  Каждый разговор сохраняется сюда. Память сквозная — новый чат помнит, о чём говорили в прошлых.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-tg-sep/50">
                {list.map((s) => (
                  <li key={s.id}>
                    <div
                      className={cn(
                        'flex items-center gap-2 px-3 py-2.5 transition active:bg-tg-surface2/60',
                        s.id === currentId && 'bg-tg-link/8',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          haptic('light')
                          onPick(s.id)
                          onClose()
                        }}
                        className="min-w-0 flex-1 text-left"
                        aria-label={`Открыть чат: ${s.title}`}
                      >
                        <span className="block truncate text-[14px] font-semibold text-tg-text">{s.title}</span>
                        <span className="mt-0.5 flex items-baseline gap-1.5 text-[12px] text-tg-hint">
                          <span className="shrink-0">{timeAgo(s.updatedAt, 'ru')}</span>
                          {s.lastPreview && <span className="min-w-0 truncate">· {s.lastPreview}</span>}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(s.id)}
                        disabled={busyId === s.id}
                        aria-label={`Удалить чат: ${s.title}`}
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-tg-hint transition active:bg-tg-surface disabled:opacity-40"
                      >
                        {busyId === s.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/* ============================ Основной компонент ============================ */

export function AiChat({
  kind,
  open,
  onClose,
  channelId,
  channelTitle,
  seedQuery,
  onSeedConsumed,
}: {
  kind: AiChatKind
  open: boolean
  onClose: () => void
  /** Канал ассистента (только kind=assistant) */
  channelId?: string
  channelTitle?: string
  /** Внешний запрос (из SearchTab) — отправляется автоматически один раз */
  seedQuery?: string | null
  onSeedConsumed?: () => void
}) {
  const openAuthGate = useApp((s) => s.openAuthGate)
  const openChannel = useApp((s) => s.openChannel)
  const user = useApp((s) => s.user)
  const lang = useApp((s) => s.lang)
  useBackButton(open, onClose)

  const [messages, setMessages] = useState<AiMsg[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [streamText, setStreamText] = useState<string | null>(null) // v5.40: realtime-печать
  const [publishing, setPublishing] = useState(false)
  const [loaded, setLoaded] = useState(false)
  // v5.74: сессии чатов — текущий чат и шторка «Чаты» (история/новый/удаление)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  // v5.73: ПЛАВНЫЙ стриминг — дельты копятся в буфер, экран обновляется
  // не чаще 1 раза на кадр (requestAnimationFrame): токены сливаются в
  // непрерывную печать без «прыжков» и лишних рендеров на каждый SSE-чанк
  const streamBufRef = useRef('')
  const streamRafRef = useRef(0)
  const flushStream = useCallback(() => {
    if (streamRafRef.current) {
      cancelAnimationFrame(streamRafRef.current)
      streamRafRef.current = 0
    }
    const next = streamBufRef.current
    streamBufRef.current = ''
    if (next) setStreamText((prev) => (prev ?? '') + next)
  }, [])
  const pushStreamChunk = useCallback(
    (chunk: string) => {
      streamBufRef.current += chunk
      if (!streamRafRef.current) {
        streamRafRef.current = requestAnimationFrame(() => {
          streamRafRef.current = 0
          const next = streamBufRef.current
          streamBufRef.current = ''
          if (next) setStreamText((prev) => (prev ?? '') + next)
        })
      }
    },
    [],
  )
  const listRef = useRef<HTMLDivElement>(null)
  const busyRef = useRef(false)
  busyRef.current = busy

  // Загрузка истории при открытии: сначала локально (мгновенно), затем
  // серверная СЕССИЯ чата (v5.74) — без параметра сервер вернёт самую свежую
  // сессию (продолжить последний разговор) + её id.
  useEffect(() => {
    if (!open) return
    let alive = true
    setMessages(loadHistory(kind, channelId))
    setLoaded(true)
    const token = getSessionToken()
    if (!token) return
    const url =
      kind === 'assistant'
        ? `/api/ai/assistant?channelId=${encodeURIComponent(channelId ?? '')}`
        : '/api/ai/search'
    fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          j: {
            messages?: Array<{ role: string; text: string; at: string; meta?: Partial<AiMsg> }>
            sessionId?: string | null
          } | null,
        ) => {
          if (!alive) return
          setSessionId(j?.sessionId ?? null)
          if (!j?.messages?.length) return
          const server: AiMsg[] = j.messages.slice(-MAX_HISTORY).map((m, i) => ({
            id: `srv${i}_${m.at}`,
            role: m.role === 'user' ? 'user' : 'assistant',
            text: m.text,
            at: m.at,
            ...(m.meta ?? {}),
          }))
          setMessages(server)
          saveHistory(kind, channelId, server)
        },
      )
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [open, kind, channelId])

  // Автоскролл вниз при новых сообщениях/статусах
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, status, busy])

  const persist = useCallback(
    (next: AiMsg[]) => {
      setMessages(next)
      saveHistory(kind, channelId, next)
    },
    [kind, channelId],
  )

  /** Отправка сообщения: SSE-поток статусов/ответа */
  const send = useCallback(
    async (text: string) => {
      const clean = text.trim()
      if (!clean || busyRef.current) return
      if (kind === 'assistant' && !channelId) return
      if (!user) {
        openAuthGate('ai')
        return
      }
      haptic('light')
      const userMsg: AiMsg = { id: uid(), role: 'user', text: clean, at: new Date().toISOString() }
      const history = [...messages, userMsg]
      persist(history)
      setBusy(true)
      setStatus(null)
      setStreamText(null)

      // v5.55: копим дельты в локальную переменную — если соединение оборвётся
      // до done/error, частичный ответ сохраняется в историю, а не выбрасывается
      let acc = ''
      let settled = false
      const onEvent = (type: string, data: Record<string, unknown>) => {
        if (type === 'status') {
          setStatus((data.label as string) ?? null)
        } else if (type === 'session') {
          // v5.74: сервер создал/подтвердил сессию — запоминаем чат
          setSessionId((data.sessionId as string) ?? null)
        } else if (type === 'delta') {
          // v5.73: realtime-стриминг через rAF-буфер — печать идеально плавная
          setStatus(null)
          const chunk = (data.text as string) ?? ''
          acc += chunk
          pushStreamChunk(chunk)
        } else if (type === 'paid') {
          // v5.39: тарификация по токенам — сервер вернул фактическую списанную сумму
          const sw = Number(data.swipes ?? 0)
          if (sw > 0) {
            toast(`−${sw.toLocaleString('ru-RU')} ${pluralRu(sw, 'свайп', 'свайпа', 'свайпов')} за запрос к ИИ`, { icon: '⚡' })
            // v5.54: баланс в общем сторе синхронизируется мгновенно (кошелёк не устаревает)
            const cur = useApp.getState().balance
            useApp.getState().patchBalance({ swipes: Math.max(0, (cur?.swipes ?? 0) - sw) })
          }
        } else if (type === 'done') {
          settled = true
          // v5.74: дублируем sessionId из done (на случай пропущенного session-события)
          const sid = (data.sessionId as string | undefined) ?? null
          if (sid) setSessionId(sid)
          const stepsRaw = (data.steps as Array<{ label: string; ok: boolean }> | undefined) ?? []
          const botMsg: AiMsg = {
            id: uid(),
            role: 'assistant',
            text: (data.reply as string) ?? '',
            at: new Date().toISOString(),
            imageUrl: (data.imageUrl as string | undefined) ?? undefined,
            imagePending: Boolean(data.imagePending),
            draftText: (data.draftText as string | undefined) ?? undefined,
            draftTopic: (data.draftTopic as string | undefined) ?? undefined,
            publishedLink: (data.publishedLink as string | undefined) ?? undefined,
            inviteLink: (data.inviteLink as string | undefined) ?? undefined,
            scheduledAt: (data.scheduledAt as string | undefined) ?? undefined,
            sources: (data.sources as PostDTO[] | undefined) ?? undefined,
            steps: stepsRaw.map((s) => ({ label: s.label, ok: s.ok })),
          }
          persist([...history, botMsg])
          flushStream()
          setBusy(false)
          setStatus(null)
          setStreamText(null)
          haptic(botMsg.text ? 'success' : 'error')
        } else if (type === 'error') {
          settled = true
          const errMsg: AiMsg = {
            id: uid(),
            role: 'assistant',
            text: (data.message as string) ?? 'Ошибка — попробуйте ещё раз',
            at: new Date().toISOString(),
            failed: true,
          }
          persist([...history, errMsg])
          flushStream()
          setBusy(false)
          setStatus(null)
          setStreamText(null)
          haptic('error')
        }
      }

      try {
        const token = getSessionToken()
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (token) headers.Authorization = `Bearer ${token}`
        const res = await fetch(kind === 'assistant' ? '/api/ai/assistant' : '/api/ai/search', {
          method: 'POST',
          headers,
          body: JSON.stringify(
            kind === 'assistant'
              ? {
                  action: 'chat',
                  channelId,
                  sessionId,
                  messages: history.slice(-MAX_HISTORY).map((m) => ({ role: m.role, content: m.text })),
                }
              : {
                  action: 'chat',
                  sessionId,
                  messages: history.slice(-MAX_HISTORY).map((m) => ({ role: m.role, content: m.text })),
                },
          ),
          cache: 'no-store',
          signal: AbortSignal.timeout(180_000),
        })
        if (res.status === 401) {
          openAuthGate('ai')
          setBusy(false)
          return
        }
        if (res.status === 402) {
          const j = (await res.json().catch(() => ({}))) as { message?: string }
          toast.error(j.message ?? 'Лимит исчерпан')
          setBusy(false)
          return
        }
        if (!res.ok || !res.body) {
          const j = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
          throw new Error(j.message || j.error || `HTTP ${res.status}`)
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const parts = buf.split('\n\n')
          buf = parts.pop() ?? ''
          for (const part of parts) {
            let type = 'message'
            let payload: Record<string, unknown> = {}
            for (const line of part.split('\n')) {
              if (line.startsWith('event:')) type = line.slice(6).trim()
              else if (line.startsWith('data:')) {
                try {
                  payload = JSON.parse(line.slice(5).trim()) as Record<string, unknown>
                } catch {
                  /* битый json */
                }
              }
            }
            onEvent(type, payload)
          }
        }
        // v5.55: поток кончился без done/error — соединение оборвалось.
        // Раньше частичный ответ молча выбрасывался (обрез чата); теперь
        // сохраняем накопленное с пометкой failed + тост вместо тишины
        if (!settled && acc.trim().length > 0) {
          persist([
            ...history,
            { id: uid(), role: 'assistant', text: acc, at: new Date().toISOString(), failed: true },
          ])
          toast.error('Ответ получен не полностью — соединение оборвалось')
        }
        flushStream()
        setBusy(false)
        setStatus(null)
        setStreamText(null)
      } catch (e) {
        flushStream()
        setBusy(false)
        setStatus(null)
        setStreamText(null)
        const msg = (e as Error).message || 'Нейросеть не ответила'
        if (/войдите/i.test(msg)) openAuthGate('ai')
        else {
          toast.error(msg)
          persist([
            ...history,
            { id: uid(), role: 'assistant', text: msg, at: new Date().toISOString(), failed: true },
          ])
        }
        haptic('error')
      }
    },
    [messages, persist, kind, channelId, sessionId, openAuthGate, user, pushStreamChunk, flushStream],
  )

  // Seed-запрос из SearchTab: автоотправка один раз
  useEffect(() => {
    if (!open || !loaded || !seedQuery) return
    onSeedConsumed?.()
    if (!busyRef.current) void send(seedQuery)
     
  }, [open, loaded, seedQuery])

  /** Публикация черновика (инлайн-кнопка) */
  const doPublish = async (m: AiMsg) => {
    if (!channelId || !m.draftText || publishing) return
    setPublishing(true)
    try {
      const r = await api<{ ok: boolean; link?: string; error?: string }>('/api/ai/assistant', {
        method: 'POST',
        body: JSON.stringify({ action: 'publish', channelId, text: m.draftText, imageUrl: m.imageUrl ?? null }),
      })
      if (r.ok) {
        haptic('success')
        toast.success('Опубликовано в Telegram')
        persist(messages.map((x) => (x.id === m.id ? { ...x, publishedLink: r.link ?? 'ok' } : x)))
      } else {
        toast.error(r.error || 'Не удалось опубликовать')
        haptic('error')
      }
    } catch (e) {
      toast.error((e as Error).message || 'Не удалось опубликовать')
      haptic('error')
    } finally {
      setPublishing(false)
    }
  }

  /** Просьба нарисовать картинку к черновику (инлайн-кнопка) */
  const askImage = (m: AiMsg) => {
    const topic = m.draftTopic || m.draftText?.slice(0, 80) || ''
    void send(`Нарисуй картинку${topic ? ` к посту про ${topic}` : ' к последнему посту'}`)
  }

  /** v5.74: «Новый чат» — чистый экран; старый чат остаётся в истории (сессия живёт) */
  const newChat = () => {
    haptic('light')
    setSessionId(null)
    setStreamText(null)
    setStatus(null)
    persist([])
  }

  /** v5.74: открыть чат из истории — серверные сообщения этой сессии */
  const openSession = (id: string) => {
    if (!id) {
      // пустая строка = «Новый чат» из шторки
      newChat()
      return
    }
    const token = getSessionToken()
    if (!token) return
    const url =
      kind === 'assistant'
        ? `/api/ai/assistant?channelId=${encodeURIComponent(channelId ?? '')}&sessionId=${encodeURIComponent(id)}`
        : `/api/ai/search?sessionId=${encodeURIComponent(id)}`
    fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (j: { messages?: Array<{ role: string; text: string; at: string; meta?: Partial<AiMsg> }> } | null) => {
          setSessionId(id)
          const server: AiMsg[] = (j?.messages ?? []).slice(-MAX_HISTORY).map((m, i) => ({
            id: `srv${i}_${m.at}`,
            role: m.role === 'user' ? 'user' : 'assistant',
            text: m.text,
            at: m.at,
            ...(m.meta ?? {}),
          }))
          setStreamText(null)
          setStatus(null)
          persist(server)
        },
      )
      .catch(() => toast.error('Не удалось открыть чат'))
  }

  /** v5.73→v5.74: корзина в шапке = удалить ТЕКУЩИЙ чат и начать новый */
  const deleteCurrentChat = () => {
    haptic('light')
    const token = getSessionToken()
    if (token && sessionId) {
      const url =
        kind === 'assistant'
          ? `/api/ai/assistant?channelId=${encodeURIComponent(channelId ?? '')}&sessionId=${encodeURIComponent(sessionId)}`
          : `/api/ai/search?sessionId=${encodeURIComponent(sessionId)}`
      void fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
    }
    newChat()
  }

  if (typeof document === 'undefined') return null

  const title =
    kind === 'assistant'
      ? lang === 'en'
        ? 'Snap Assistant'
        : 'Snap Ассистент'
      : 'ИИ-поиск'
  const subtitle =
    kind === 'assistant'
      ? `«${channelTitle ?? ''}» · пишет, рисует, публикует`
      : lang === 'en'
        ? 'Answers from feed posts with sources'
        : 'Отвечает по постам ленты'

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key={`ai-chat-${kind}`}
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%' }}
          transition={{ type: 'spring', damping: 32, stiffness: 330 }}
          className="fixed inset-0 z-[75] mx-auto flex w-full max-w-[680px] flex-col overflow-hidden bg-tg-bg lg:bottom-auto lg:top-[4vh] lg:h-[92vh] lg:rounded-3xl lg:border lg:border-tg-sep lg:shadow-[0_24px_90px_rgba(0,0,0,0.35)]"
          role="dialog"
          aria-modal="true"
          aria-label={title}
          data-noswipe
        >
          {/* Шапка */}
          <header className="flex shrink-0 items-center gap-2.5 border-b border-tg-sep/60 bg-tg-bg px-2 py-2">
            <button
              type="button"
              onClick={onClose}
              aria-label="Назад"
              className="flex h-11 w-11 items-center justify-center rounded-full text-tg-text active:bg-tg-surface"
            >
              <ArrowLeft className="h-5.5 w-5.5" />
            </button>
            <span className="min-w-0 flex-1 pl-1">
              <span className="block truncate text-[16px] font-bold leading-tight text-tg-text">{title}</span>
              <span className="block truncate text-[12.5px] leading-tight text-tg-hint">{subtitle}</span>
            </span>
            {/* v5.74: история чатов — список, новый чат, удаление */}
            <button
              type="button"
              onClick={() => {
                haptic('light')
                setSessionsOpen(true)
              }}
              aria-label="История чатов"
              title="История чатов"
              className="relative flex h-10 w-10 items-center justify-center rounded-full text-tg-hint active:bg-tg-surface"
            >
              <History className="h-4.5 w-4.5" />
            </button>
            {messages.length > 0 && (
              <button
                type="button"
                onClick={deleteCurrentChat}
                aria-label="Удалить текущий чат"
                title="Удалить текущий чат"
                className="flex h-10 w-10 items-center justify-center rounded-full text-tg-hint active:bg-tg-surface"
              >
                <Trash2 className="h-4.5 w-4.5" />
              </button>
            )}
          </header>

          {/* Лента сообщений */}
          <div ref={listRef} className="no-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-3 py-3">
            {loaded && messages.length === 0 && !busy && (
              <div className="flex h-full flex-col justify-center gap-5 px-5 py-6">
                {/* v5.73: welcome без иконки-аватарки — чистая типографика */}
                <div>
                  <p className="text-[17px] font-bold leading-tight text-tg-text">
                    {kind === 'assistant'
                      ? lang === 'en'
                        ? 'Your channel’s AI co-writer'
                        : 'ИИ-контентщик канала'
                      : 'ИИ-поиск'}
                  </p>
                  <p className="mt-1 text-[13px] leading-snug text-tg-hint">
                    {kind === 'assistant'
                      ? 'Знает статистику канала, пишет посты в вашем стиле, рисует обложки и публикует. Помнит вас между разговорами, ищет в интернете. Просто попросите'
                      : 'Отвечает по свежим постам ленты со ссылками на источники, помнит ваши темы и ищет в интернете'}
                  </p>
                </div>
                <div>
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-tg-hint">
                    {kind === 'assistant' ? 'Быстрый старт' : 'Примеры запросов'}
                  </p>
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {SUGGESTIONS[kind].map((s) => (
                      <button
                        key={s}
                        type="button"
                        data-noswipe
                        onClick={() => void send(s)}
                        className="flex min-h-11 items-center gap-2 rounded-xl border border-tg-sep bg-tg-surface/50 px-3.5 py-2.5 text-left text-[13px] font-medium text-tg-text transition active:scale-[0.98] active:bg-tg-surface2"
                      >
                        <ArrowUpRightIcon />
                        <span className="min-w-0 flex-1">{s}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {messages.map((m, mi) => (
              <motion.div
                key={m.id}
                initial={{ opacity: 0, y: 12, scale: 0.985 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{
                  duration: 0.32,
                  ease: [0.32, 0.72, 0, 1],
                  // лёгкий каскад: каждое следующее сообщение вступает на 40мс позже
                  delay: Math.min(0.16, Math.max(0, mi - Math.max(0, messages.length - 3)) * 0.04),
                }}
                className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}
              >
                <motion.div
                  initial={{ opacity: 0, y: 6, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1], delay: 0.05 }}
                  className={cn('max-w-[88%] min-w-0', m.role === 'user' && 'max-w-[80%]')}
                >
                  {/* Этапы инструментов (мелкие чипы над ответом) */}
                  {m.steps && m.steps.length > 0 && m.role === 'assistant' && (
                    <div className="mb-1 space-y-0.5">
                      {m.steps.map((s, i) => (
                        <span
                          key={i}
                          className={cn(
                            'flex items-center gap-1.5 text-[11px] leading-snug',
                            s.ok ? 'text-tg-hint' : 'text-destructive',
                          )}
                        >
                          {s.ok ? <Check className="h-3 w-3 shrink-0 text-tg-green" /> : <AlertCircle className="h-3 w-3 shrink-0" />}
                          {s.label.replace(/…$/, '')}
                        </span>
                      ))}
                    </div>
                  )}
                  {/* v5.40: у ИИ — чистый текст без пузыря и аватарки (как ChatGPT),
                      пузырь остаётся только у пользователя */}
                  <div
                    className={cn(
                      m.role === 'user'
                        ? 'rounded-2xl rounded-br-md px-3.5 py-2.5 shadow-sm bg-tg-link text-white'
                        : m.failed
                          ? 'rounded-2xl px-3.5 py-2.5 text-destructive'
                          : '',
                    )}
                  >
                    {m.role === 'assistant' ? (
                      <RichText
                        text={aiMobileMarkdown(stripImageLinks(m.text))}
                        className="animate-[fade-in_0.35s_ease-out] text-[14.5px] leading-relaxed [&_a]:text-tg-link"
                      />
                    ) : (
                      <span className="whitespace-pre-wrap break-words text-[14.5px] leading-relaxed">{m.text}</span>
                    )}
                  </div>
                  {/* Картинка (generate_image) — v5.70: инлайн <img> + лайтбокс,
                      без голых ссылок; фолбэк-pollinations сам перезагружается */}
                  {m.imageUrl && <ChatImage url={m.imageUrl} pending={m.imagePending} />}
                  {m.imagePending && !m.imageUrl && <ImagePendingPlaceholder />}
                  {/* v5.64: чипы результата — отложенный пост и пригласительная ссылка */}
                  {m.scheduledAt && (
                    <div className="mt-1.5 flex items-center gap-1.5 rounded-xl bg-tg-surface px-3 py-1.5 text-[11.5px] font-medium text-tg-hint" data-noswipe>
                      <CalendarClock className="h-3.5 w-3.5 shrink-0 text-tg-link" />
                      Публикация отложена: {new Date(m.scheduledAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} (UTC)
                    </div>
                  )}
                  {m.inviteLink && (
                    <button
                      type="button"
                      data-noswipe
                      onClick={() => {
                        void navigator.clipboard.writeText(m.inviteLink!).then(() => toast('Ссылка скопирована'))
                      }}
                      className="mt-1.5 flex w-full items-center gap-1.5 rounded-xl bg-tg-surface px-3 py-2 text-left transition active:bg-tg-surface2"
                      aria-label="Скопировать пригласительную ссылку"
                    >
                      <Copy className="h-3.5 w-3.5 shrink-0 text-tg-link" />
                      <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-tg-text2">{m.inviteLink}</span>
                      <span className="shrink-0 text-[10.5px] font-semibold text-tg-link">Скопировать</span>
                    </button>
                  )}
                  {/* Инлайн-кнопки + публикация */}
                  {m.role === 'assistant' && channelId && (
                    <InlineButtons msg={m} onPublish={(x) => void doPublish(x)} onAskImage={askImage} publishing={publishing} />
                  )}
                  {/* Источники (поиск) */}
                  {m.sources && m.sources.length > 0 && (
                    <div className="mt-1.5 overflow-hidden rounded-2xl border border-tg-sep bg-tg-surface">
                      <div className="border-b border-tg-sep/60 px-3.5 pb-1 pt-2 text-[10.5px] font-bold uppercase tracking-wide text-tg-hint">
                        Источники
                      </div>
                      {m.sources.slice(0, 6).map((p, i) => (
                        <SourceRow
                          key={p.id}
                          post={p}
                          index={i}
                          onOpen={() => {
                            onClose()
                            openChannel(p.channel.username)
                          }}
                        />
                      ))}
                    </div>
                  )}
                  <span className={cn('mt-0.5 block text-[10px]', m.role === 'user' ? 'text-right text-white/55' : 'text-tg-hint/70')}>
                    {timeAgo(m.at, lang)}
                  </span>
                </motion.div>
              </motion.div>
            ))}

            {/* v5.40: realtime-стриминг — ответ печатается на глазах. v5.68:
                блок появляется мягко (spring-въезд), текст — с fade, за последним
                символом — пульсирующий каретка-курсор (transform/opacity, 60 FPS) */}
            {streamText !== null && streamText.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 10, scale: 0.985 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
                className="flex justify-start"
              >
                <div className="max-w-[88%] min-w-0">
                  <div className="animate-[fade-in_0.3s_ease-out]">
                    <RichText
                      text={aiMobileMarkdown(streamText)}
                      className="text-[14.5px] leading-relaxed text-tg-text [&_a]:text-tg-link"
                    />
                  </div>
                  <motion.span
                    aria-hidden
                    className="ml-0.5 inline-block h-[14px] w-[2px] translate-y-[2px] rounded-full bg-tg-link"
                    animate={{ opacity: [1, 0.15, 1] }}
                    transition={{ duration: 0.9, repeat: Infinity, ease: 'easeInOut' }}
                  />
                </div>
              </motion.div>
            )}

            {busy && streamText === null && <ThinkingBubble label={status} />}
          </div>

          {/* Ввод: слитая капсула + микрофон/отправка */}
          <div className="shrink-0 border-t border-tg-sep/60 bg-tg-surface/60 px-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur-md">
            <ChatInput
              value={draft}
              onChange={setDraft}
              onSend={(t) => {
                setDraft('')
                void send(t)
              }}
              busy={busy}
              disabled={kind === 'assistant' && !channelId}
              maxLength={2000}
              placeholder={kind === 'assistant' ? 'Опишите пост или задайте вопрос…' : 'Спросите про ленту…'}
              sendLabel="Отправить ИИ"
              micLabel="Голосовой ввод"
            />
          </div>

          {/* v5.74: шторка «Чаты» — история разговоров, новый чат, удаление */}
          <SessionsDrawer
            kind={kind}
            channelId={channelId}
            currentId={sessionId}
            open={sessionsOpen}
            onClose={() => setSessionsOpen(false)}
            onPick={openSession}
          />
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
