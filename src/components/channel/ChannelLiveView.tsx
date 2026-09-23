'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  Check,
  Copy,
  Eye,
  ExternalLink,
  Heart,
  Loader2,
  MessageSquare,
  Paperclip,
  Pencil,
  Pin,
  Send,
  Settings2,
  Trash2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { formatCount, pluralRu } from '@/lib/format'
import { haptic } from '@/lib/tg'
import { uploadImage } from '@/lib/upload'
import { RichText } from '@/components/feed/RichText'
import { LazyImage } from '@/components/feed/LazyImage'
import { Avatar } from '@/components/tg/Avatar'
import { BottomSheet } from '@/components/tg/BottomSheet'
import { BackfillButton } from '@/components/channel/BackfillButton'

/**
 * «Живой канал» (v5.65) — нативный вид чата своего канала, как в Telegram:
 *
 *  - баблы сообщений с аватаркой канала, просмотрами, реакциями и временем —
 *    но вся стилизация (цвета/шрифты/отступы) на токенах миниаппа, никакого
 *    дефолтного дизайна Telegram;
 *  - клик/долгое нажатие на пост → контекстное меню: закрепить, править,
 *    копировать ссылку, открыть в Telegram, БЕЗВОЗВРАТНО удалить;
 *  - строка ввода внизу: скрепка (медиа) + текст → публикация через бота;
 *  - «Настройки» в шапке → классическое меню канала: аватар, название,
 *    описание (ручное редактирование метаданных, без ИИ).
 *
 * Производительность: transform-only анимации оверлея, content-visibility
 * у баблов, ленивые медиа с фикс. пропорциями (без layout-сдвигов = без
 * микродёрганий скролла), спиннеры вместо тяжёлых шиммеров на мутациях.
 */

export type LiveChannelInfo = {
  id: string
  username: string
  title: string
  description: string | null
  avatarUrl: string | null
  subscribers: number
}

export type LivePost = {
  id: string
  text: string
  mediaUrl: string | null
  mediaType: string
  gallery: Array<{ url: string }>
  link: string | null
  messageId: number | null
  views: number
  reactions: number
  likes: number
  publishedAt: string
}

type LiveResponse = { channel: LiveChannelInfo; posts: LivePost[] }

/** Время под баблом — как в Telegram: ЧЧ:ММ */
function bubbleTime(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Заголовок-разделитель дня («Сегодня», «Вчера», «12 марта») */
function dayLabel(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86_400_000)
  if (diff === 0) return 'Сегодня'
  if (diff === 1) return 'Вчера'
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
}

/* ================================================================== */

export function ChannelLiveView({
  channelId,
  onClose,
}: {
  channelId: string
  onClose: () => void
}) {
  const [info, setInfo] = useState<LiveChannelInfo | null>(null)
  const [posts, setPosts] = useState<LivePost[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const [draft, setDraft] = useState('')
  const [attached, setAttached] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [sending, setSending] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const [menuPost, setMenuPost] = useState<LivePost | null>(null) // контекст-меню поста
  const [confirmDelete, setConfirmDelete] = useState<LivePost | null>(null)
  const [editSheet, setEditSheet] = useState<LivePost | null>(null)
  const [editText, setEditText] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [busyPost, setBusyPost] = useState<string | null>(null) // pin/delete в полёте

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [metaSheet, setMetaSheet] = useState<'title' | 'description' | null>(null)
  const [metaValue, setMetaValue] = useState('')
  const [metaSaving, setMetaSaving] = useState(false)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /* Стабилизация скролла (task 2-b): юзер у нижнего края → новые посты
   * мягко дотягиваем; читает историю — позицию НЕ трогаем, вместо этого
   * показываем пилюлю «N новых» (тап → плавно вниз). Раньше любой тик
   * polling'а принудительно прыгал в конец и сбивал чтение. */
  const atBottomRef = useRef(true)
  const lastCountRef = useRef(0)
  const followedRef = useRef(false)
  const [newCount, setNewCount] = useState(0)

  /* Портал монтируем ПОСЛЕ первого коммита: createPortal во время
   * mount-прохода внутри AnimatePresence роняет React 19 (dev) с ошибкой
   * «Target container is not a DOM element» — это чисто технический guard,
   * на поведение оверлея не влияет (анимации входа/выхода сохраняются). */
  const [portalReady, setPortalReady] = useState(false)
  useEffect(() => {
    setPortalReady(true)
  }, [])

  /* ----------------------------- данные ----------------------------- */

  /* task 2-b: гонки polling'а. Каждый сетевой ответ получает монотонный
   * номер «поколения» и применяется, только если он СВЕЖЕЕ последнего
   * применённого: медленный ответ, стартовавший ДО мутации (send/delete/
   * edit), больше не может затереть свежее состояние — раньше это выглядело
   * как «только что отправленный пост исчез», «удалённый пост воскрес» и
   * «список дёргается каждые 15 секунд». */
  const seqRef = useRef(0)
  const pollBusyRef = useRef(false)
  const loadingRef = useRef(true)
  /** Посты, удалённые в этой сессии: ответ polling'а (снапшот ДО удаления,
   * уже летящий по сети) не должен их «воскрешать» до следующего тика */
  const removedIdsRef = useRef<Set<string>>(new Set())

  /** Слияние входящего списка с текущим по id: без дублей и без потерь.
   *  Ответ сервера — последние 60 постов (take:60); локальные посты старее
   *  этого окна сохраняем (сервер их не прислал, а не «удалил»), внутри
   *  окна доверяем ответу (правки/просмотры/удаления с другого устройства). */
  const mergePosts = useCallback((incoming: LivePost[]) => {
    setPosts((prev) => {
      if (incoming.length === 0) return prev.length === 0 ? prev : []
      const oldest = incoming.reduce((min, p) => Math.min(min, +new Date(p.publishedAt)), Infinity)
      const byId = new Map(incoming.map((p) => [p.id, p] as const))
      for (const p of prev) {
        if (removedIdsRef.current.has(p.id)) continue
        if (byId.has(p.id)) continue
        if (+new Date(p.publishedAt) < oldest) byId.set(p.id, p)
      }
      const merged = [...byId.values()]
      // страховка от бесконтрольного роста за долгую сессию
      return merged.length > 300 ? merged.slice(-300) : merged
    })
  }, [])

  const load = useCallback(async () => {
    const seq = ++seqRef.current
    try {
      const r = await api<LiveResponse>(`/api/channel/live?channelId=${encodeURIComponent(channelId)}`)
      if (seq !== seqRef.current) return // устарел: уже применён более свежий ответ
      setInfo(r.channel)
      mergePosts(r.posts)
      setFailed(false)
    } catch {
      if (seq !== seqRef.current) return
      setFailed(true)
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [channelId, mergePosts])

  useEffect(() => {
    loadingRef.current = true
    void load()
    return () => {
      seqRef.current++ // ответ после закрытия чата/смены канала не применяется
    }
  }, [load])

  /* v5.96: тихий полл 15с, пока чат открыт и вкладка видима. После импорта
     истории (или публикации поста прямо в Telegram) баблы появляются сами.
     task 2-b: интервал живёт ВЕСЬ монтированный период (deps только
     channelId) — раньше он пересоздавался на каждую смену loading/failed,
     сбивая ритм; параллельные тики исключены флагом pollBusy; удачный тик
     снимает failed — после транзиентного сбоя экран чинится сам. */
  useEffect(() => {
    const iv = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      if (pollBusyRef.current || loadingRef.current) return
      pollBusyRef.current = true
      const seq = ++seqRef.current
      void api<LiveResponse>(`/api/channel/live?channelId=${encodeURIComponent(channelId)}`)
        .then((r) => {
          if (seq !== seqRef.current) return
          setInfo(r.channel)
          mergePosts(r.posts)
          setFailed(false)
        })
        .catch(() => {}) // фоновый тик — сбои ждём следующего
        .finally(() => {
          pollBusyRef.current = false
          if (seq === seqRef.current) setLoading(false)
        })
    }, 15_000)
    return () => {
      clearInterval(iv)
      seqRef.current++ // летящий ответ после unmount не применяется
    }
  }, [channelId, mergePosts])

  // зеркало state для коллбеков/эффектов, чтобы не пересоздавать интервал
  loadingRef.current = loading

  /** Юзер у нижнего края (±120px)? Тап по пилюле/ручная прокрутка вниз
   *  сбрасывают счётчик непрочитанных новых */
  const onChatScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    atBottomRef.current = nearBottom
    if (nearBottom) setNewCount(0)
  }, [])

  const scrollToNew = useCallback(() => {
    setNewCount(0)
    atBottomRef.current = true
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [])

  /* --------------------------- мутации ----------------------------- */

  const send = useCallback(async () => {
    const text = draft.trim()
    if ((!text && !attached) || sending) return
    setSending(true)
    try {
      const r = await api<{ ok: true; post: LivePost | null }>('/api/channel/live', {
        method: 'POST',
        body: JSON.stringify({ action: 'send', channelId, text: text || '📎', imageUrl: attached ?? undefined }),
      })
      seqRef.current++ // снапшоты летящих фоновых тиков старее публикации
      if (r.post) mergePosts([r.post as LivePost]) // слияние по id — без дублей
      setDraft('')
      setAttached(null)
      haptic('success')
      toast.success('Опубликовано в канале')
      atBottomRef.current = true
      requestAnimationFrame(() => {
        const el = scrollRef.current
        if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      })
      void load() // сверить с сервером (счётчики/порядок) без ожидания тика
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось опубликовать')
    } finally {
      setSending(false)
    }
  }, [attached, channelId, draft, sending])

  const doDelete = useCallback(async (p: LivePost) => {
    setBusyPost(p.id)
    try {
      await api('/api/channel/live', {
        method: 'POST',
        body: JSON.stringify({ action: 'delete', channelId, postId: p.id }),
      })
      seqRef.current++ // летящий снапшот polling'а, сделанный до удаления, устарел
      removedIdsRef.current.add(p.id) // и ближайший тик его не «воскресит»
      setPosts((prev) => prev.filter((x) => x.id !== p.id))
      haptic('warning')
      toast.success('Пост удалён из канала и ленты')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось удалить')
    } finally {
      setBusyPost(null)
      setConfirmDelete(null)
      setMenuPost(null)
    }
  }, [channelId])

  const doPin = useCallback(async (p: LivePost) => {
    setBusyPost(p.id)
    try {
      await api('/api/channel/live', {
        method: 'POST',
        body: JSON.stringify({ action: 'pin', channelId, postId: p.id }),
      })
      haptic('success')
      toast.success('Пост закреплён в канале')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось закрепить')
    } finally {
      setBusyPost(null)
      setMenuPost(null)
    }
  }, [channelId])

  const doEditSave = useCallback(async () => {
    if (!editSheet || editSaving) return
    const text = editText.trim()
    if (!text) return
    setEditSaving(true)
    try {
      await api('/api/channel/live', {
        method: 'POST',
        body: JSON.stringify({ action: 'edit', channelId, postId: editSheet.id, text }),
      })
      seqRef.current++ // устаревший снапшот с прежним текстом не перетрёт правку
      setPosts((prev) => prev.map((x) => (x.id === editSheet.id ? { ...x, text } : x)))
      toast.success('Пост отредактирован')
      setEditSheet(null)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось отредактировать')
    } finally {
      setEditSaving(false)
    }
  }, [channelId, editSaving, editSheet, editText])

  const saveMeta = useCallback(
    async (patch: { title?: string; description?: string; avatarUrl?: string }) => {
      setMetaSaving(true)
      try {
        const r = await api<{ ok: true; results: Record<string, boolean> }>('/api/channel/live', {
          method: 'POST',
          body: JSON.stringify({ action: 'meta', channelId, ...patch }),
        })
        const failed = Object.entries(r.results ?? {})
          .filter(([, v]) => !v)
          .map(([k]) => k)
        if (failed.length > 0) {
          toast.error('Telegram отклонил: боту нужно право change_channel_info')
        } else {
          if (patch.title !== undefined) setInfo((p) => (p ? { ...p, title: patch.title! } : p))
          if (patch.description !== undefined) setInfo((p) => (p ? { ...p, description: patch.description! } : p))
          haptic('success')
          toast.success('Изменения сохранены в Telegram')
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Не удалось сохранить')
      } finally {
        setMetaSaving(false)
      }
    },
    [channelId],
  )

  const pickAvatar = useCallback(async (file: File) => {
    try {
      setUploading(true)
      const url = await uploadImage(file)
      await saveMeta({ avatarUrl: url })
    } catch {
      toast.error('Не удалось загрузить картинку')
    } finally {
      setUploading(false)
    }
  }, [saveMeta])

  const pickMedia = useCallback(async (file: File) => {
    try {
      setUploading(true)
      const url = await uploadImage(file)
      setAttached(url)
      haptic('light')
    } catch {
      toast.error('Не удалось загрузить картинку')
    } finally {
      setUploading(false)
    }
  }, [])

  /* ------------------------- служебные мелочи ----------------------- */

  const copyLink = useCallback((p: LivePost) => {
    const link = p.link ?? (info && p.messageId ? `https://t.me/${info.username}/${p.messageId}` : null)
    if (link) {
      void navigator.clipboard.writeText(link)
      toast.success('Ссылка скопирована')
    } else {
      toast.error('У поста нет ссылки в Telegram')
    }
    setMenuPost(null)
  }, [info])

  /** Клик И долгое нажатие ведут в одно контекстное меню (как в ТГ — но без гонки) */
  const openMenu = useCallback((p: LivePost) => {
    haptic('light')
    setMenuPost(p)
  }, [])

  const onPressStart = useCallback((p: LivePost) => {
    pressTimer.current = setTimeout(() => openMenu(p), 480)
  }, [openMenu])
  const onPressEnd = useCallback(() => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
  }, [])

  /* ---------------------- сгруппированные баблы --------------------- */

  const rendered = useMemo(() => {
    // Сортируем хронологически (старые сверху, новые внизу — как в Telegram)
    const sorted = [...posts].sort((a, b) => +new Date(a.publishedAt) - +new Date(b.publishedAt))
    return sorted
  }, [posts])

  /** Открытие чата = как в Telegram: сразу у последних сообщений. Дальше —
   *  только мягкое дотягивание, если юзер и так внизу; принудительный
   *  прыжок на каждый тик polling'а сбивал чтение истории (task 2-b). */
  useEffect(() => {
    if (loading || rendered.length === 0) return
    const el = scrollRef.current
    if (!el) return
    if (!followedRef.current) {
      followedRef.current = true
      el.scrollTop = el.scrollHeight
      atBottomRef.current = true
      lastCountRef.current = rendered.length
      return
    }
    const added = rendered.length - lastCountRef.current
    lastCountRef.current = rendered.length
    if (added <= 0) return // правка/удаление — позицию не трогаем
    if (atBottomRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    } else {
      // юзер читает историю: тихо считаем новые, скролл не трогаем
      setNewCount((c) => Math.min(99, c + added))
    }
  }, [loading, rendered])

  if (!portalReady) return null

  return createPortal(
    <motion.div
      className="live-view-layer fixed inset-0 z-[70] flex flex-col bg-tg-bg"
      initial={{ opacity: 0, x: '100%' }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: '100%' }}
      transition={{ type: 'tween', duration: 0.22, ease: 'easeOut' }}
      role="dialog"
      aria-label="Живой канал"
    >
      {/* ---------------------- Шапка (как в ТГ) ---------------------- */}
      <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-tg-sep bg-tg-surface px-2">
        <button
          type="button"
          onClick={onClose}
          aria-label="Назад"
          className="flex h-10 w-10 items-center justify-center rounded-full text-tg-link transition-transform active:scale-90"
        >
          <ArrowLeft size={24} />
        </button>
        {info ? (
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg py-1 text-left"
            aria-label="Настройки канала"
          >
            <Avatar name={info.title} src={info.avatarUrl} size={36} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-semibold leading-tight text-tg-text">{info.title}</span>
              <span className="block text-[12.5px] leading-tight text-tg-hint">
                {formatCount(info.subscribers)} подписчиков
              </span>
            </span>
          </button>
        ) : (
          <div className="h-9 flex-1" />
        )}
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          aria-label="Настройки канала"
          className="flex h-10 w-10 items-center justify-center rounded-full text-tg-link transition-transform active:scale-90"
        >
          <Settings2 size={22} />
        </button>
      </header>

      {/* -------------------- Лента баблов (чат) ---------------------- */}
      <div
        ref={scrollRef}
        onScroll={onChatScroll}
        className="chat-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 py-3"
      >
        <div className="mx-auto min-h-full w-full max-w-[760px]">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="animate-spin text-tg-hint" size={26} />
          </div>
        ) : failed ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <span className="flex size-14 items-center justify-center rounded-full bg-tg-star/10 text-tg-star" aria-hidden>
              <AlertTriangle size={26} strokeWidth={1.8} />
            </span>
            <p className="text-sm text-tg-hint">Не удалось загрузить канал</p>
            <button
              type="button"
              onClick={() => void load()}
              className="press rounded-full bg-tg-link px-4 py-1.5 text-[13px] font-medium text-white"
            >
              Повторить
            </button>
          </div>
        ) : rendered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2.5 px-8 text-center">
            <span className="flex size-14 items-center justify-center rounded-full bg-tg-link/10 text-tg-link" aria-hidden>
              <MessageSquare size={26} strokeWidth={1.8} />
            </span>
            <p className="text-[15px] font-medium text-tg-text">Канал пуст</p>
            <p className="text-[13px] leading-snug text-tg-hint">
              Опубликуйте первый пост через строку ниже — он появится и в Telegram
            </p>
            {/* v5.96: у канала почти всегда есть история в Telegram — её можно
                завезти одной кнопкой (бэкфил из t.me/s), а не постить заново */}
            {info?.username && (
              <>
                <BackfillButton channelId={channelId} className="mt-2" onProgress={() => void load()} />
                <p className="text-[11.5px] leading-snug text-tg-hint/80">
                  Импорт истории — один раз, дальше посты прилетают сами
                </p>
              </>
            )}
          </div>
        ) : (
          <>
            {rendered.map((p, i) => {
              const prev = i > 0 ? rendered[i - 1] : null
              const next = i < rendered.length - 1 ? rendered[i + 1] : null
              const newDay = !prev || dayLabel(prev.publishedAt) !== dayLabel(p.publishedAt)
              // Аватарка — у последнего бабла серии (группировка как в ТГ)
              const showAvatar = !next || next.publishedAt.slice(0, 10) !== p.publishedAt.slice(0, 10) || bubbleGapMs(p, next) > 5 * 60_000
              return (
                <div key={p.id}>
                  {newDay && <DayChip label={dayLabel(p.publishedAt)} />}
                  <Bubble
                    post={p}
                    showAvatar={showAvatar}
                    title={info?.title ?? ''}
                    avatarSrc={info?.avatarUrl ?? null}
                    busy={busyPost === p.id}
                    onTap={() => openMenu(p)}
                    onPressStart={() => onPressStart(p)}
                    onPressEnd={onPressEnd}
                  />
                </div>
              )
            })}
          </>
        )}
        </div>
      </div>

      {/* ---------------- Строка ввода (в самом низу) ------------------ */}
      <div className="relative shrink-0 border-t border-tg-sep bg-tg-surface pb-[max(env(safe-area-inset-bottom),8px)] pt-2">
        {/* Пилюля «N новых» (task 2-b): юзер читает историю — новые посты
            ждут тапа, вместо принудительного прыжка скролла вниз */}
        <AnimatePresence>
          {newCount > 0 && (
            <motion.button
              type="button"
              onClick={scrollToNew}
              initial={{ opacity: 0, y: 10, scale: 0.92 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.92 }}
              transition={{ type: 'tween', duration: 0.16, ease: 'easeOut' }}
              role="status"
              aria-label="Прокрутить к новым постам"
              className="absolute -top-11 left-1/2 z-[2] flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-tg-link px-3.5 py-2 text-[13px] font-semibold text-white shadow-lg shadow-tg-link/40 transition-transform active:scale-95"
            >
              <ArrowDown size={15} />
              {newCount} {pluralRu(newCount, 'новый пост', 'новых поста', 'новых постов')}
            </motion.button>
          )}
        </AnimatePresence>
        <div className="mx-auto w-full max-w-[760px]">
        {attached && (
          <div className="mx-3 mb-2 flex items-center gap-2 rounded-xl bg-tg-surface2 p-1.5">
            <img src={attached} alt="Вложение" className="h-10 w-10 rounded-lg object-cover" />
            <span className="min-w-0 flex-1 truncate text-[13px] text-tg-text">Фото прикреплено</span>
            <button
              type="button"
              onClick={() => setAttached(null)}
              aria-label="Убрать вложение"
              className="flex h-8 w-8 items-center justify-center rounded-full text-tg-hint"
            >
              <X size={18} />
            </button>
          </div>
        )}
        <div className="flex items-end gap-1.5 px-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void pickMedia(f)
              e.target.value = ''
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading || sending}
            aria-label="Прикрепить медиа"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-tg-hint transition-transform active:scale-90 disabled:opacity-50"
          >
            {uploading ? <Loader2 size={22} className="animate-spin" /> : <Paperclip size={22} />}
          </button>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder="Отправить сообщение…"
            rows={1}
            className="max-h-24 min-h-10 flex-1 resize-none rounded-[18px] bg-tg-surface2 px-3.5 py-2.5 text-[15px] leading-tight text-tg-text outline-none placeholder:text-tg-hint"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={sending || (!draft.trim() && !attached)}
            aria-label="Отправить"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-tg-link text-white shadow-md shadow-tg-link/40 transition-transform active:scale-90 disabled:opacity-40 disabled:shadow-none"
          >
            {sending ? <Loader2 size={19} className="animate-spin" /> : <Send size={18} />}
          </button>
        </div>
        </div>
      </div>

      {/* ---------------- Контекстное меню поста ----------------------- */}
      <AnimatePresence>
        {menuPost && (
          <motion.div
            className="fixed inset-0 z-[80] flex items-end justify-center bg-black/40 sm:items-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
            onClick={() => setMenuPost(null)}
            role="presentation"
          >
            <motion.div
              className="mb-4 w-[min(92vw,320px)] overflow-hidden rounded-2xl border border-tg-sep/50 bg-tg-surface shadow-2xl sm:mb-0"
              initial={{ y: 40, opacity: 0, scale: 0.97 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: 30, opacity: 0 }}
              transition={{ type: 'tween', duration: 0.18, ease: 'easeOut' }}
              onClick={(e) => e.stopPropagation()}
              role="menu"
              aria-label="Действия с постом"
            >
              <div className="max-h-44 overflow-hidden px-3.5 py-2.5">
                <div className="chat-bubble-clamp text-[13px] leading-snug text-tg-hint">
                  {/* task 2-b: без slice(0,160) — срез по сырому markdown рвал
                      токен (**бо, ||спо, [ссыл) и RichText рисовал мусор;
                      высоту ограничивает CSS-clamp (chat-bubble-clamp) */}
                  <RichText text={menuPost.text.trim() || '📎 Медиа-пост'} />
                </div>
              </div>
              <div className="border-t border-tg-sep" />
              <MenuRow
                icon={<Pin size={19} />}
                label="Закрепить в канале"
                onClick={() => void doPin(menuPost)}
                busy={busyPost === menuPost.id}
              />
              <MenuRow
                icon={<Pencil size={19} />}
                label="Редактировать"
                onClick={() => {
                  setEditText(menuPost.text)
                  setEditSheet(menuPost)
                  setMenuPost(null)
                }}
              />
              <MenuRow icon={<Copy size={19} />} label="Копировать ссылку" onClick={() => copyLink(menuPost)} />
              {menuPost.link && (
                <MenuRow
                  icon={<ExternalLink size={19} />}
                  label="Открыть в Telegram"
                  onClick={() => {
                    window.open(menuPost.link!, '_blank', 'noopener')
                    setMenuPost(null)
                  }}
                />
              )}
              <MenuRow
                icon={<Trash2 size={19} />}
                label="Удалить пост"
                danger
                onClick={() => {
                  setConfirmDelete(menuPost)
                  setMenuPost(null)
                }}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ------------------- Подтверждение удаления -------------------- */}
      <AnimatePresence>
        {confirmDelete && (
          <motion.div
            className="fixed inset-0 z-[85] flex items-center justify-center bg-black/45 px-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
            role="presentation"
          >
            <motion.div
              className="w-full max-w-[340px] rounded-2xl bg-tg-surface p-5 shadow-2xl"
              initial={{ scale: 0.94, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.96, opacity: 0 }}
              transition={{ type: 'tween', duration: 0.16 }}
              role="alertdialog"
              aria-label="Удаление поста"
            >
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-500/12">
                  <AlertTriangle className="text-red-500" size={20} />
                </div>
                <div className="min-w-0">
                  <p className="text-[15px] font-semibold text-tg-text">Удалить этот пост?</p>
                  <p className="mt-1 text-[13px] leading-snug text-tg-hint">
                    Пост будет безвозвратно удалён и из Telegram, и из ленты Tg Swipe вместе с реакциями и комментариями.
                  </p>
                </div>
              </div>
              <div className="mt-5 flex gap-2.5">
                <button
                  type="button"
                  onClick={() => setConfirmDelete(null)}
                  className="press h-11 flex-1 rounded-xl bg-tg-surface2 text-[14px] font-medium text-tg-text"
                >
                  Отмена
                </button>
                <button
                  type="button"
                  disabled={busyPost === confirmDelete.id}
                  onClick={() => void doDelete(confirmDelete)}
                  className="press flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-red-500 text-[14px] font-semibold text-white disabled:opacity-60"
                >
                  {busyPost === confirmDelete.id ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={15} />}
                  Удалить
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ------------------------ Правка поста ------------------------- */}
      <BottomSheet
        open={editSheet !== null}
        onClose={() => setEditSheet(null)}
        title="Редактирование поста"
        subtitle="Текст изменится и в Telegram, и в ленте"
        zClass="z-[86]"
      >
        <div className="space-y-3 px-1 pb-2">
          <textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            rows={6}
            className="w-full resize-none rounded-xl bg-tg-surface2 p-3 text-[15px] leading-snug text-tg-text outline-none"
            placeholder="Текст поста"
          />
          <div className="flex gap-2.5">
            <button
              type="button"
              onClick={() => setEditSheet(null)}
              className="press h-11 flex-1 rounded-xl bg-tg-surface2 text-[14px] font-medium text-tg-text"
            >
              Отмена
            </button>
            <button
              type="button"
              disabled={editSaving || !editText.trim()}
              onClick={() => void doEditSave()}
              className="press flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-tg-link text-[14px] font-semibold text-white disabled:opacity-50"
            >
              {editSaving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
              Сохранить
            </button>
          </div>
        </div>
      </BottomSheet>

      {/* ------------- Классическое меню-настройка канала -------------- */}
      <AnimatePresence>
        {settingsOpen && info && (
          <motion.div
            className="fixed inset-0 z-[75] flex flex-col bg-tg-bg"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'tween', duration: 0.2, ease: 'easeOut' }}
            role="dialog"
            aria-label="Настройки канала"
          >
            <header className="flex h-14 shrink-0 items-center gap-2 border-b border-tg-sep bg-tg-surface px-2">
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                aria-label="Назад к чату"
                className="flex h-10 w-10 items-center justify-center rounded-full text-tg-link"
              >
                <ArrowLeft size={24} />
              </button>
              <p className="flex-1 text-[16px] font-semibold text-tg-text">Управление каналом</p>
            </header>

            <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto py-3">
              {/* Аватар */}
              <div className="flex flex-col items-center gap-2.5 pb-4">
                <div className="relative">
                  <Avatar name={info.title} src={info.avatarUrl} size={88} />
                  <label className="absolute -bottom-0.5 -right-0.5 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-tg-link text-white shadow-md">
                    {uploading ? <Loader2 size={15} className="animate-spin" /> : <Pencil size={14} />}
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        if (f) void pickAvatar(f)
                        e.target.value = ''
                      }}
                    />
                  </label>
                </div>
                <p className="text-[13px] text-tg-hint">Нажмите на карандаш, чтобы сменить фото канала</p>
              </div>

              {/* Метаданные */}
              <div className="mx-3 overflow-hidden rounded-2xl bg-tg-surface">
                <MetaRow
                  icon={<MessageSquare size={19} />}
                  label="Название"
                  value={info.title}
                  onClick={() => {
                    setMetaValue(info.title)
                    setMetaSheet('title')
                  }}
                />
                <div className="mx-3.5 h-px bg-tg-sep" />
                <MetaRow
                  icon={<Pencil size={19} />}
                  label="Описание"
                  value={info.description?.trim() || 'Добавить описание…'}
                  placeholderStyle={!info.description?.trim()}
                  onClick={() => {
                    setMetaValue(info.description ?? '')
                    setMetaSheet('description')
                  }}
                />
                <div className="mx-3.5 h-px bg-tg-sep" />
                <MetaRow
                  icon={<Copy size={19} />}
                  label="Ссылка"
                  value={`t.me/${info.username}`}
                  onClick={() => {
                    void navigator.clipboard.writeText(`https://t.me/${info.username}`)
                    toast.success('Ссылка скопирована')
                  }}
                />
                <div className="mx-3.5 h-px bg-tg-sep" />
                <MetaRow
                  icon={<ExternalLink size={19} />}
                  label="Открыть в Telegram"
                  value=""
                  onClick={() => window.open(`https://t.me/${info.username}`, '_blank', 'noopener')}
                />
              </div>

              <p className="mx-4 mt-3 text-center text-[12px] leading-snug text-tg-hint">
                Изменения применяются в самом Telegram через бота. Боту требуется право «изменение информации о канале».
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* -------------- Ввод названия / описания канала ---------------- */}
      <BottomSheet
        open={metaSheet !== null}
        onClose={() => setMetaSheet(null)}
        title={metaSheet === 'title' ? 'Название канала' : 'Описание канала'}
        subtitle={metaSheet === 'title' ? 'До 128 символов' : 'До 255 символов — видно в шапке Telegram'}
        zClass="z-[78]"
      >
        <div className="space-y-3 px-1 pb-2">
          <textarea
            value={metaValue}
            onChange={(e) => setMetaValue(metaSheet === 'title' ? e.target.value.slice(0, 128) : e.target.value.slice(0, 255))}
            rows={metaSheet === 'title' ? 2 : 4}
            className="w-full resize-none rounded-xl bg-tg-surface2 p-3 text-[15px] leading-snug text-tg-text outline-none"
            placeholder={metaSheet === 'title' ? 'Название' : 'О чём канал'}
          />
          <div className="flex gap-2.5">
            <button
              type="button"
              onClick={() => setMetaSheet(null)}
              className="press h-11 flex-1 rounded-xl bg-tg-surface2 text-[14px] font-medium text-tg-text"
            >
              Отмена
            </button>
            <button
              type="button"
              disabled={metaSaving || !metaValue.trim()}
              onClick={() => {
                if (metaSheet === 'title') void saveMeta({ title: metaValue.trim() })
                else void saveMeta({ description: metaValue.trim() })
                setMetaSheet(null)
              }}
              className="press flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-tg-link text-[14px] font-semibold text-white disabled:opacity-50"
            >
              {metaSaving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
              Сохранить
            </button>
          </div>
        </div>
      </BottomSheet>
    </motion.div>,
    document.body,
  )
}

/* ============================ частные ============================== */

function bubbleGapMs(a: LivePost, b: LivePost): number {
  return Math.abs(+new Date(b.publishedAt) - +new Date(a.publishedAt))
}

/** Разделитель дней — матовая капсула по центру, как в Telegram:
 * лёгкий блюр + hairline + мягкая тень, чтобы читалась поверх баблов */
function DayChip({ label }: { label: string }) {
  return (
    <div className="sticky top-1 z-[1] flex justify-center py-1.5">
      <span className="rounded-full border border-tg-sep/60 bg-tg-surface2/90 px-3 py-1 text-[11.5px] font-semibold tracking-wide text-tg-hint shadow-sm backdrop-blur-sm">
        {label}
      </span>
    </div>
  )
}

/**
 * Бабл сообщения канала. Стилистика Telegram-чата (бабл слева с хвостиком
 * «имя канала»), но на токенах миниаппа: bg-tg-surface2, скругления,
 * футер «просмотры · реакции · время».
 */
function Bubble({
  post,
  showAvatar,
  title,
  avatarSrc,
  busy,
  onTap,
  onPressStart,
  onPressEnd,
}: {
  post: LivePost
  showAvatar: boolean
  title: string
  avatarSrc: string | null
  busy: boolean
  onTap: () => void
  onPressStart: () => void
  onPressEnd: () => void
}) {
  return (
    <div className={cn('chat-bubble bubble-in flex items-end gap-2', showAvatar ? 'mb-2.5' : 'mb-0.5')}>
      {/* Колонка аватарок: пусто у баблов в середине серии */}
      <div className="w-8 shrink-0 self-end">
        {showAvatar && <Avatar name={title} src={avatarSrc} size={32} />}
      </div>

      <div
        className="relative min-w-0 max-w-[85%] flex-1 select-none rounded-2xl rounded-bl-md bg-tg-surface2 px-3 py-2 shadow-[0_1px_2px_rgba(0,0,0,0.08)] transition-transform active:scale-[0.99] motion-reduce:transition-none"
        onClick={onTap}
        onContextMenu={(e) => {
          e.preventDefault()
          onTap()
        }}
        onTouchStart={onPressStart}
        onTouchEnd={onPressEnd}
        onTouchMove={onPressEnd}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onTap()
        }}
        aria-label="Пост канала — нажмите для действий"
      >
        {busy && (
          <div className="absolute inset-0 z-[1] flex items-center justify-center rounded-2xl bg-tg-surface2/70">
            <Loader2 size={18} className="animate-spin text-tg-hint" />
          </div>
        )}

        {/* Медиа: фикс. пропорции (без layout-сдвига = ровный скролл), как в ТГ */}
        {post.mediaUrl && (
          <div className="mb-1.5 overflow-hidden rounded-xl">
            <LazyImage src={post.mediaUrl} alt="Вложение поста" className="aspect-[4/3] w-full" imgWidth={720} />
          </div>
        )}
        {post.gallery.length > 0 && (
          <div className="mb-1.5 grid grid-cols-2 gap-1 overflow-hidden rounded-xl">
            {post.gallery.slice(0, 4).map((g, gi) => (
              <LazyImage key={gi} src={g.url} alt="Фото" className="aspect-square w-full" imgWidth={480} />
            ))}
          </div>
        )}

        {post.text.trim() && post.text.trim() !== '📎' && (
          <div className="text-[15px] leading-[1.35] text-tg-text [&_a]:text-tg-link">
            <RichText text={post.text} />
          </div>
        )}

        {/* Футер бабла: просмотры · реакции · время */}
        <div className="mt-0.5 flex items-center justify-end gap-2 text-[11.5px] leading-none text-tg-hint">
          <span className="flex items-center gap-1">
            <Eye size={13} />
            {formatCount(post.views)}
          </span>
          {post.reactions > 0 && (
            <span className="flex items-center gap-1">
              <Heart size={12} />
              {formatCount(post.reactions)}
            </span>
          )}
          <span>{bubbleTime(post.publishedAt)}</span>
        </div>
      </div>
    </div>
  )
}

/** Строка контекстного меню */
function MenuRow({
  icon,
  label,
  onClick,
  danger,
  busy,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  danger?: boolean
  busy?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={cn(
        'flex w-full items-center gap-3 px-3.5 py-3 text-left text-[14.5px] transition-colors active:bg-tg-surface2 disabled:opacity-50',
        danger ? 'text-red-500' : 'text-tg-text',
      )}
      role="menuitem"
    >
      {busy ? <Loader2 size={19} className="animate-spin" /> : icon}
      {label}
    </button>
  )
}

/** Строка настроек канала (классическое меню) */
function MetaRow({
  icon,
  label,
  value,
  placeholderStyle,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  value: string
  placeholderStyle?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors active:bg-tg-surface2"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-tg-surface2 text-tg-hint">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] text-tg-hint">{label}</span>
        <span className={cn('block truncate text-[14.5px]', placeholderStyle ? 'text-tg-hint' : 'text-tg-text')}>
          {value}
        </span>
      </span>
    </button>
  )
}
