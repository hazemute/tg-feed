'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, ChevronDown, CornerDownRight, Heart, Loader2, MessageCircle, Trash2, X } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { useT } from '@/lib/i18n'
import { haptic } from '@/lib/tg'
import { timeAgo, pluralRu } from '@/lib/format'
import { userAvatarUrl } from '@/lib/tg'
import type { CommentDTO, PostDTO } from '@/lib/types'
import { Avatar } from '@/components/tg/Avatar'
import { BottomSheet } from '@/components/tg/BottomSheet'
import { emitPostUpdated } from '@/components/feed/PostOverlay'
import { UserBadges } from '@/components/badges/UserBadges'
import { ChatInput } from '@/components/ai/ChatInput'

/**
 * Комментарии под постом (глобальный шит) — TikTok-стиль (v5.14):
 *  • сортировка «Новые» (хронология) / «Популярные» (по лайкам);
 *  • лайки комментариев (сердечки справа, оптимистичный тоггл);
 *  • дерево ответов на один уровень (как в TikTok): «Ответить» под комментом,
 *    плашка «Ответ NAME» у ответа на ответ, раскрытие ветки по тапу;
 *  • уведомления автору на ответ/лайк (см. API + NotificationsSheet).
 *
 * Читать может кто угодно — комментарии цепляют гостя; отправка/лайки — только
 * после привязки Telegram (ленивая регистрация: тап открывает шторку входа).
 * Оптимистичные отправка/удаление/лайк; счётчик поста синхронизируется
 * событием tgfeed:post-updated.
 */

const MAX_LEN = 700
const PREVIEW_REPLIES = 2 // сколько ответов показывает сервер сразу

/** Последний выбранный фильтр живёт в рамках сессии (как в TikTok) */
let sessionSort: 'new' | 'top' = 'new'

/** Скелетон из трёх строк на время первой загрузки */
function Skeletons() {
  return (
    <div className="space-y-4 px-1 py-2" aria-hidden>
      {[64, 40, 52].map((w, i) => (
        <div key={i} className="flex gap-2.5">
          <div className="tg-shimmer h-9 w-9 shrink-0 rounded-full" />
          <div className="flex-1 space-y-1.5 pt-0.5">
            <div className="tg-shimmer h-3 w-24 rounded" />
            <div className="tg-shimmer h-3.5 rounded" style={{ width: `${w}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}

/** Иммутабельный патч комментария (и его ответов) по id */
function mapTree(items: CommentDTO[], id: string, patch: (c: CommentDTO) => CommentDTO): CommentDTO[] {
  return items.map((c) => {
    if (c.id === id) return patch(c)
    if (c.replies?.length) {
      const replies = c.replies.map((r) => (r.id === id ? patch(r) : r))
      if (replies !== c.replies) return { ...c, replies }
    }
    return c
  })
}

export function CommentsSheet() {
  const t = useT()
  const lang = useApp((s) => s.lang)
  const post = useApp((s) => s.commentsPost)
  const closeComments = useApp((s) => s.closeComments)
  const patchCommentsPost = useApp((s) => s.patchCommentsPost)
  const focusId = useApp((s) => s.commentsFocusId)
  const clearCommentsFocus = useApp((s) => s.clearCommentsFocus)
  const user = useApp((s) => s.user)
  const openAuthGate = useApp((s) => s.openAuthGate)
  // Порядковый номер запроса списка: смена поста/сортировки запускает новую
  // загрузку, не дожидаясь предыдущей — ответ старой не должен перезаписать
  // список свежей (иначе комментарии чужого поста показывались под текущим)
  const loadSeqRef = useRef(0)

  const [items, setItems] = useState<CommentDTO[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [sort, setSort] = useState<'new' | 'top'>(sessionSort)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  /** Кому отвечаем: null — новый корневой комментарий */
  const [replyTo, setReplyTo] = useState<{ parentCommentId: string; rootId: string; name: string } | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [flashId, setFlashId] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const itemsRef = useRef(items)
  itemsRef.current = items

  const open = !!post

  /* ---------- Загрузка ---------- */

  const load = useCallback(
    async (postId: string, c?: string, s?: 'new' | 'top') => {
      const cur = s ?? sessionSort
      const first = !c
      const seq = ++loadSeqRef.current
      if (first) setLoading(true)
      else setLoadingMore(true)
      try {
        const r = await api<{ items: CommentDTO[]; nextCursor: string | null }>(
          `/api/comments?postId=${encodeURIComponent(postId)}&sort=${cur}${c ? `&cursor=${encodeURIComponent(c)}` : ''}`,
        )
        // Ответ устарел (пост/сортировка сменились, пока летел запрос) — молча discard
        if (seq !== loadSeqRef.current) return
        setItems((prev) => (first ? r.items : [...prev, ...r.items]))
        setCursor(r.nextCursor)
        setError(null)
      } catch {
        if (seq === loadSeqRef.current && first) setError(t('comments.error'))
      } finally {
        // Общие спиннеры сбрасывает только СВЕЖИЙ запрос — иначе поздний ответ
        // старого поста снимал бы скелетон новой загрузки
        if (seq === loadSeqRef.current) {
          setLoading(false)
          setLoadingMore(false)
        }
      }
    },
    [t],
  )

  // Открытие/смена поста — перезагрузка списка
  useEffect(() => {
    if (!post) return
    setItems([])
    setCursor(null)
    setError(null)
    setDraft('')
    setReplyTo(null)
    setExpanded(new Set())
    void load(post.id, undefined, sessionSort)
  }, [post?.id, load])

  /* ---------- Deep-link из уведомлений: скролл к комментарию ----------
   * focusId (тап по уведомлению comment/reply/comment_like) → после загрузки
   * списка находим комментарий; если это ответ, чья ветка ещё не раскрыта —
   * последовательно раскрываем ветки корней и пересматриваем; скроллим к
   * строке, подсвечиваем и снимаем фокус. */
  useEffect(() => {
    if (!post || !focusId || loading || items.length === 0) return
    let cancelled = false
    const findIn = (list: CommentDTO[]): CommentDTO | null => {
      for (const c of list) {
        if (c.id === focusId) return c
        const r = c.replies?.find((x) => x.id === focusId)
        if (r) return r
      }
      return null
    }
    const scrollNow = (id: string) => {
      if (cancelled) return
      const el = document.getElementById(`comment-${id}`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        setFlashId(id)
        window.setTimeout(() => setFlashId((f) => (f === id ? null : f)), 2600)
      }
      clearCommentsFocus()
    }
    const jump = async () => {
      const direct = findIn(itemsRef.current)
      if (direct) {
        // Если целевой комментарий — ответ внутри ветки, раскрываем ветку корня
        // (ответы рендерятся только у раскрытого корня) и даём дорисоваться
        if (direct.parentId) {
          setExpanded((prev) => new Set(prev).add(direct.parentId!))
          await new Promise((r) => window.setTimeout(r, 320))
        }
        window.setTimeout(() => scrollNow(direct.id), 120)
        return
      }
      // Не нашли — комментарий внутри нераскрытой ветки: последовательно
      // раскрываем корни с ответами (лимит 12 — защита от огромных страниц)
      let roots = itemsRef.current.filter((c) => c.repliesCount > 0).slice(0, 12)
      for (const root of roots) {
        if (cancelled) return
        if ((root.replies?.length ?? 0) >= root.repliesCount) continue // уже весь загружен
        await loadReplies(root, true)
        await new Promise((r) => window.setTimeout(r, 60)) // даём setState отработать
        const found = findIn(itemsRef.current)
        if (found) {
          window.setTimeout(() => scrollNow(found.id), 120)
          return
        }
        roots = itemsRef.current.filter((c) => c.repliesCount > 0).slice(0, 12)
      }
      if (!cancelled) clearCommentsFocus() // не нашли (старая страница/удалён) — тихо снимаем
    }
    void jump()
    return () => {
      cancelled = true
    }
     
  }, [post?.id, focusId, loading, items.length])

  const switchSort = (s: 'new' | 'top') => {
    if (!post || s === sessionSort) return
    haptic('light')
    sessionSort = s
    setSort(s)
    setItems([])
    setCursor(null)
    setExpanded(new Set())
    setReplyTo(null)
    void load(post.id, undefined, s)
  }

  /* ---------- Лайк комментария ---------- */

  const doLike = async (c: CommentDTO, rootId?: string) => {
    if (!user) return
    if (user.isGuest) {
      haptic('light')
      openAuthGate('comment')
      return
    }
    if (c.id.startsWith('tmp_')) return
    const willLike = !c.likedByMe
    haptic('light')
    // Оптимистично
    const patch = (prev: CommentDTO): CommentDTO => ({
      ...prev,
      likedByMe: willLike,
      likesCount: Math.max(0, prev.likesCount + (willLike ? 1 : -1)),
    })
    setItems((prev) => mapTree(prev, c.id, patch))
    try {
      const r = await api<{ liked: boolean; likesCount: number }>(`/api/comments/${c.id}/like`, {
        method: 'POST',
        body: '{}',
      })
      setItems((prev) => mapTree(prev, c.id, (p) => ({ ...p, likedByMe: r.liked, likesCount: r.likesCount })))
    } catch {
      // Откат
      setItems((prev) =>
        mapTree(prev, c.id, (p) => ({
          ...p,
          likedByMe: c.likedByMe,
          likesCount: c.likesCount,
        })),
      )
      toast.error(t('comments.error'))
    }
  }

  /* ---------- Раскрытие ветки ---------- */

  const loadReplies = useCallback(
    async (root: CommentDTO, expand: boolean) => {
      if (!post) return
      if (expand) setExpanded((prev) => new Set(prev).add(root.id))
      const already = root.replies ?? []
      if (expand && already.length > 0 && already.length >= root.repliesCount) return // всё загружено
      try {
        const cur = already[already.length - 1]?.id
        const r = await api<{ items: CommentDTO[]; nextCursor: string | null }>(
          `/api/comments?postId=${encodeURIComponent(post.id)}&parentId=${encodeURIComponent(root.id)}${cur ? `&cursor=${encodeURIComponent(cur)}` : ''}`,
        )
        setItems((prev) =>
          mapTree(prev, root.id, (p) => {
            const merged = expand ? [...(p.replies ?? []), ...r.items] : r.items
            const uniq = merged.filter((x, i) => merged.findIndex((y) => y.id === x.id) === i)
            return { ...p, replies: uniq }
          }),
        )
        if (!expand) setExpanded((prev) => new Set(prev).add(root.id))
      } catch {
        toast.error(t('comments.error'))
      }
    },
    [post, t],
  )

  const toggleReplies = (root: CommentDTO) => {
    haptic('light')
    const isOpen = expanded.has(root.id)
    if (isOpen) {
      setExpanded((prev) => {
        const next = new Set(prev)
        next.delete(root.id)
        return next
      })
    } else {
      void loadReplies(root, true)
    }
  }

  /* ---------- Отправка ---------- */

  const focusInput = () => {
    window.setTimeout(() => inputRef.current?.focus(), 60)
  }

  const startReply = (c: CommentDTO) => {
    if (!user) return
    if (user.isGuest) {
      haptic('light')
      openAuthGate('comment')
      return
    }
    haptic('light')
    const rootId = c.parentId ?? c.id
    setReplyTo({ parentCommentId: c.id, rootId, name: c.author.name })
    focusInput()
  }

  const cancelReply = () => {
    setReplyTo(null)
    haptic('light')
  }

  const doSend = async () => {
    if (!post || !user) return
    const text = draft.trim()
    if (!text || sending) return
    if (user.isGuest) {
      // Ленивая регистрация: гость пишет → шторка «привяжи Telegram»
      openAuthGate('comment')
      haptic('light')
      return
    }
    if (text.length > MAX_LEN) {
      toast.error(t('comments.tooLong'))
      return
    }

    const replying = replyTo
    const tmp: CommentDTO = {
      id: `tmp_${Date.now()}`,
      postId: post.id,
      text,
      createdAt: new Date().toISOString(),
      author: {
        id: user.id,
        name: [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || (user.username ? `@${user.username}` : 'Вы'),
        username: user.username,
        avatarUrl: userAvatarUrl(user.id, user.photoUrl),
      },
      own: true,
      parentId: replying ? replying.rootId : null,
      replyToName: replying ? replying.name : null,
      likesCount: 0,
      likedByMe: false,
      repliesCount: 0,
      replies: [],
    }

    if (replying) setExpanded((ex) => new Set(ex).add(replying.rootId))
    setItems((prev) => {
      if (!replying) return [...prev, tmp]
      // Ответ уходит в ветку корня (ветка раскрыта выше — setExpanded ВНЕ
      // setItems: апдейтер состояния должен быть чистым)
      return mapTree(prev, replying.rootId, (p) => ({
        ...p,
        replies: [...(p.replies ?? []), tmp],
      }))
    })
    setDraft('')
    setSending(true)
    haptic('light')
    if (inputRef.current) inputRef.current.style.height = 'auto'

    try {
      const r = await api<{ comment: CommentDTO; commentsCount: number }>('/api/comments', {
        method: 'POST',
        body: JSON.stringify({
          postId: post.id,
          text,
          ...(replying ? { parentId: replying.parentCommentId } : {}),
        }),
      })
      setItems((prev) => {
        if (!replying) return [...prev.slice(0, -1), r.comment]
        return mapTree(prev, replying.rootId, (p) => ({
          ...p,
          repliesCount: p.repliesCount + 1,
          replies: (p.replies ?? []).map((x) => (x.id === tmp.id ? r.comment : x)),
        }))
      })
      patchCommentsPost(post.id, r.commentsCount)
      emitPostUpdated({ postId: post.id, commentsCount: r.commentsCount })
      if (replying) setReplyTo(null)
    } catch (e) {
      setItems((prev) => {
        if (!replying) return prev.filter((c) => c.id !== tmp.id)
        return mapTree(prev, replying.rootId, (p) => ({
          ...p,
          replies: (p.replies ?? []).filter((x) => x.id !== tmp.id),
        }))
      })
      setDraft(text)
      const msg = e instanceof Error && /символов/i.test(e.message) ? e.message : t('comments.error')
      toast.error(msg)
    } finally {
      setSending(false)
    }
  }

  /* ---------- Удаление своего ---------- */

  const doDelete = async (c: CommentDTO) => {
    haptic('light')
    const wasRoot = !c.parentId
    // Оптимистично убираем (у корня — вместе с веткой)
    setItems((prev) =>
      wasRoot
        ? prev.filter((x) => x.id !== c.id)
        : mapTree(prev, c.parentId!, (p) => ({
            ...p,
            repliesCount: Math.max(0, p.repliesCount - 1),
            replies: (p.replies ?? []).filter((x) => x.id !== c.id),
          })),
    )
    if (wasRoot) {
      setExpanded((prev) => {
        const next = new Set(prev)
        next.delete(c.id)
        return next
      })
    }
    try {
      const r = await api<{ ok: boolean; commentsCount: number }>(`/api/comments/${c.id}`, { method: 'DELETE' })
      if (post) {
        patchCommentsPost(post.id, r.commentsCount)
        emitPostUpdated({ postId: post.id, commentsCount: r.commentsCount })
      }
      toast.success(t('comments.deleted'))
    } catch {
      // Откат
      setItems((prev) =>
        wasRoot
          ? [...prev, c].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          : mapTree(prev, c.parentId!, (p) => ({
              ...p,
              repliesCount: p.repliesCount + 1,
              replies: [...(p.replies ?? []), c],
            })),
      )
      toast.error(t('comments.error'))
    }
  }

  /* ---------- Ctrl/Cmd+Enter отправляет ---------- */

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void doSend()
    }
  }

  const count = post?.commentsCount ?? 0
  // Счётчик в подзаголовке: русская плюрализация, английский — простая форма
  const countLabel =
    count > 0
      ? lang === 'en'
        ? `${count} ${t('comments.count')}`
        : `${count} ${pluralRu(count, 'комментарий', 'комментария', 'комментариев')}`
      : null

  const repliesWord = (n: number) =>
    lang === 'ru' ? pluralRu(n, t('comments.repliesOne'), t('comments.repliesFew'), t('comments.repliesMany')) : n === 1 ? 'reply' : 'replies'

  return (
    <BottomSheet
      open={open}
      onClose={closeComments}
      title={t('comments.title')}
      subtitle={countLabel ?? undefined}
      zClass="z-[80]"
      wide
    >
      {post && (
        <div className="flex flex-col">
          {/* Сортировка: Новые / Популярные */}
          <div className="mb-2 flex items-center gap-1.5 px-1" role="tablist" aria-label={t('comments.title')}>
            <SortChip active={sort === 'new'} onClick={() => switchSort('new')} label={t('comments.sortNew')} />
            <SortChip active={sort === 'top'} onClick={() => switchSort('top')} label={t('comments.sortTop')} />
          </div>

          {/* Старые комментарии — кнопка «показать ещё» сверху списка */}
          {cursor && sort === 'new' && !loading && (
            <button
              type="button"
              data-noswipe
              onClick={() => void load(post.id, cursor)}
              disabled={loadingMore}
              className="mx-auto mb-2 flex h-8 items-center gap-1.5 rounded-full bg-tg-surface px-3.5 text-[12.5px] font-semibold text-tg-link active:opacity-70"
            >
              {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <MessageCircle className="h-3.5 w-3.5" aria-hidden />}
              {t('comments.more')}
            </button>
          )}

          <div className="max-h-[min(50dvh,440px)] min-h-[120px] overflow-y-auto overscroll-contain" data-noswipe>
            {loading ? (
              <Skeletons />
            ) : error ? (
              <div className="py-8 text-center">
                <p className="text-[13.5px] text-tg-hint">{error}</p>
                <button
                  type="button"
                  onClick={() => void load(post.id, undefined, sort)}
                  className="mt-2 text-[13.5px] font-semibold text-tg-link active:opacity-70"
                >
                  {t('comments.retry')}
                </button>
              </div>
            ) : items.length === 0 ? (
              <div className="py-10 text-center">
                <MessageCircle className="mx-auto h-8 w-8 text-tg-hint/40" strokeWidth={1.5} aria-hidden />
                <p className="mt-2.5 text-[14px] font-medium text-tg-text">{t('comments.emptyTitle')}</p>
                <p className="mt-1 text-[13px] text-tg-hint">{t('comments.emptyHint')}</p>
              </div>
            ) : (
              <ul className="space-y-3.5 py-1">
                <AnimatePresence initial={false}>
                  {items.map((c) => (
                    <motion.li
                      key={c.id}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: c.id.startsWith('tmp_') ? 0.55 : 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.16 }}
                    >
                      <CommentRow
                        c={c}
                        expanded={expanded.has(c.id)}
                        repliesWord={repliesWord}
                        onLike={doLike}
                        onReply={startReply}
                        onDelete={doDelete}
                        onToggle={toggleReplies}
                        onLoadMoreReplies={(root) => void loadReplies(root, true)}
                        flashId={flashId}
                      />
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            )}
          </div>

          {/* Поле ввода: у гостя — призыв привязать Telegram (конверсия), у автора — отправка */}
          <div className="mt-3 border-t border-tg-sep pt-3">
            {user?.isGuest ? (
              <button
                type="button"
                data-noswipe
                onClick={() => {
                  haptic('light')
                  openAuthGate('comment')
                }}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-2xl bg-tg-link/10 text-[14px] font-semibold text-tg-link active:scale-[0.99]"
              >
                <MessageCircle className="h-4 w-4" aria-hidden />
                {t('comments.login')}
              </button>
            ) : (
              <>
                {/* Плашка «Ответ NAME» над полем (режим ответа) */}
                {replyTo && (
                  <div className="mb-2 flex items-center gap-1.5 pl-1">
                    <CornerDownRight className="h-3.5 w-3.5 text-tg-link" aria-hidden />
                    <span className="text-[12.5px] font-medium text-tg-link">
                      {t('comments.replyTag')} <span className="font-semibold">{replyTo.name}</span>
                    </span>
                    <button
                      type="button"
                      onClick={cancelReply}
                      aria-label={t('comments.cancelReply')}
                      className="ml-1 flex h-5 w-5 items-center justify-center rounded-full text-tg-hint active:bg-tg-surface"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
                {/* v5.21: слитое поле ввода в стиле Telegram (микрофон ⇄ отправка) */}
                {draft.length > MAX_LEN - 100 && (
                  <span
                    className={cn(
                      'mb-1.5 ml-auto block w-fit text-[11px] font-medium tabular-nums',
                      draft.length > MAX_LEN ? 'text-red-500' : 'text-tg-hint',
                    )}
                  >
                    {MAX_LEN - draft.length}
                  </span>
                )}
                <ChatInput
                  value={draft}
                  onChange={setDraft}
                  onSend={() => void doSend()}
                  busy={sending}
                  maxLength={MAX_LEN + 50}
                  placeholder={replyTo ? t('comments.replyPlaceholder') : t('comments.placeholder')}
                  sendLabel={t('comments.send')}
                />
              </>
            )}
          </div>
        </div>
      )}
    </BottomSheet>
  )
}

/* ---------- Чип сортировки ---------- */

function SortChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'h-8 rounded-full px-3.5 text-[13px] font-semibold transition active:scale-95',
        active ? 'bg-tg-link text-white' : 'bg-tg-surface text-tg-hint active:text-tg-text',
      )}
    >
      {label}
    </button>
  )
}

/* ---------- Строка комментария (корень и ответ — один рендер) ---------- */

function CommentRow({
  c,
  expanded,
  repliesWord,
  onLike,
  onReply,
  onDelete,
  onToggle,
  onLoadMoreReplies,
  isReply = false,
  flashId = null,
}: {
  c: CommentDTO
  expanded?: boolean
  repliesWord?: (n: number) => string
  onLike: (c: CommentDTO, rootId?: string) => void
  onReply: (c: CommentDTO) => void
  onDelete: (c: CommentDTO) => void
  onToggle?: (root: CommentDTO) => void
  onLoadMoreReplies?: (root: CommentDTO) => void
  isReply?: boolean
  /** id комментария, подсвечиваемого при переходе из уведомлений (deep-link) */
  flashId?: string | null
}) {
  const t = useT()
  const openUserProfile = useApp((s) => s.openUserProfile)
  const tmp = c.id.startsWith('tmp_')
  const avatarSize = isReply ? 28 : 36
  const flash = flashId === c.id
  // Ширина колонки авы (ава + зазор внешнего gap-2.5): контент коммента сидит
  // на этом отступе, ава вытягивается в него кнопкой автора изнутри
  const authorIndent = avatarSize + 10

  // Тап по автору (ава/имя — одна кнопка): у гостя профиля нет, остальным —
  // открываем публичный профиль (глобальный шит UserProfileSheet)
  const openAuthorProfile = () => {
    const id = c.author.id
    if (id.startsWith('guest_')) {
      toast('У гостя нет профиля — вход по Telegram открывает профиль')
      return
    }
    haptic('light')
    openUserProfile(id)
  }

  return (
    <div
      id={`comment-${c.id}`}
      className={cn(
        'flex gap-2.5 rounded-2xl p-1 -m-1',
        flash && 'bg-tg-link/[0.12] ring-1 ring-tg-link/40 transition-none',
        !flash && 'transition-colors duration-1000',
      )}
    >
      <div className="min-w-0 flex-1" style={{ paddingLeft: authorIndent }}>
        <div className="flex items-center gap-2">
          {/* Ава + имя — ОДНА кнопка: тап открывает публичный профиль автора.
              Ава позиционируется абсолютно там, где стояла колонка авы (top:0
              относительно кнопки = верх строки), поэтому бейджи/время/текст
              не сдвигаются ни на пиксель */}
          <button
            type="button"
            onClick={openAuthorProfile}
            aria-label={`Профиль ${c.author.name}`}
            className="relative flex min-w-0 items-center text-left active:opacity-70"
          >
            <span className="absolute top-0" style={{ left: -authorIndent }} aria-hidden>
              <Avatar name={c.author.name} src={c.author.avatarUrl} size={avatarSize} />
            </span>
            <span className={cn('truncate text-tg-text', isReply ? 'text-[12.5px]' : 'text-[13.5px]', 'font-semibold')}>
              {c.author.name}
            </span>
          </button>
          {/* v5.19: бейджи автора (разработчик/менеджер/спонсор…) — компактные иконки */}
          {c.author.badges && c.author.badges.length > 0 && (
            <UserBadges badges={c.author.badges} max={isReply ? 1 : 2} compact />
          )}
          <time dateTime={c.createdAt} className="shrink-0 text-[11.5px] text-tg-hint">
            {timeAgo(c.createdAt)}
          </time>
          {c.own && !tmp && (
            <button
              type="button"
              onClick={() => onDelete(c)}
              aria-label={t('comments.delete')}
              className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-tg-hint/70 transition hover:bg-red-50 hover:text-red-600 active:scale-90 dark:hover:bg-red-500/10"
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
            </button>
          )}
        </div>
        {/* Плашка «Ответ NAME» у ответа на ответ */}
        {isReply && c.replyToName && (
          <span className="mt-0.5 inline-flex items-center gap-1 text-[12px] font-medium text-tg-link">
            <CornerDownRight className="h-3 w-3" aria-hidden />
            {t('comments.replyTag')} {c.replyToName}
          </span>
        )}
        <p className={cn('mt-0.5 whitespace-pre-wrap break-words leading-snug text-tg-text2', isReply ? 'text-[13.5px]' : 'text-[14.5px]')}>
          {c.text}
        </p>

        {/* Действия: Ответить + раскрытие ветки */}
        <div className="mt-1 flex items-center gap-3.5">
          <button
            type="button"
            onClick={() => onReply(c)}
            className="text-[12.5px] font-semibold text-tg-hint transition active:text-tg-link"
          >
            {t('comments.reply')}
          </button>
          {!isReply && (c.repliesCount > 0 || (c.replies?.length ?? 0) > 0) && (
            <button
              type="button"
              onClick={() => onToggle?.(c)}
              aria-expanded={expanded}
              className="flex items-center gap-1 text-[12.5px] font-semibold text-tg-link active:opacity-70"
            >
              <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')} aria-hidden />
              {expanded ? t('comments.hideReplies') : `${c.repliesCount} ${repliesWord?.(c.repliesCount) ?? ''}`}
            </button>
          )}
        </div>

        {/* Ветка ответов (только у корня, один уровень — как в TikTok) */}
        {!isReply && expanded && (
          <div className="mt-2.5 space-y-3 border-l-2 border-tg-sep/70 pl-3">
            {(c.replies ?? []).map((r) => (
              <CommentRow
                key={r.id}
                c={r}
                isReply
                onLike={onLike}
                onReply={onReply}
                onDelete={onDelete}
                flashId={flashId}
              />
            ))}
            {/* Подгрузка остальных ответов ветки */}
            {(c.replies?.length ?? 0) < c.repliesCount && onLoadMoreReplies && !tmp && (
              <button
                type="button"
                onClick={() => onLoadMoreReplies(c)}
                className="text-[12.5px] font-semibold text-tg-link active:opacity-70"
              >
                {t('comments.moreReplies')} ({c.repliesCount - (c.replies?.length ?? 0)})
              </button>
            )}
          </div>
        )}
      </div>

      {/* Лайк: сердечко + счётчик справа (TikTok-рельса) */}
      <motion.button
        type="button"
        whileTap={{ scale: 0.8 }}
        onClick={() => onLike(c, isReply ? c.parentId ?? undefined : undefined)}
        aria-label={t('comments.like')}
        aria-pressed={c.likedByMe}
        className={cn(
          'flex shrink-0 flex-col items-center gap-0.5 pt-1.5',
          isReply ? 'w-8' : 'w-9',
          tmp && 'pointer-events-none opacity-50',
        )}
      >
        <Heart
          className={cn(
            'h-[18px] w-[18px] transition-colors',
            c.likedByMe ? 'fill-rose-500 text-rose-500' : 'text-tg-hint/70',
          )}
          strokeWidth={1.9}
        />
        {c.likesCount > 0 && (
          <span className={cn('text-[11px] font-semibold tabular-nums', c.likedByMe ? 'text-rose-500' : 'text-tg-hint')}>
            {c.likesCount > 999 ? '1k+' : c.likesCount}
          </span>
        )}
      </motion.button>
    </div>
  )
}
