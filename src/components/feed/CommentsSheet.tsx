'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Loader2, MessageCircle, Trash2 } from 'lucide-react'
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

/**
 * Комментарии под постом (глобальный шит: открывается из ленты и полного
 * экрана поста). Читать может кто угодно — комментарии цепляют гостя;
 * отправка — только после привязки Telegram (ленивая регистрация: тап по
 * полю ввода у гостя открывает шторку входа).
 *
 * Оптимистичная отправка: свой комментарий появляется мгновенно с плашкой
 * «отправляется», серверный ответ замещает его; ошибка — убираем + тост.
 * Счётчик на карточке/оверлее синхронизируется событием tgfeed:post-updated.
 */

const MAX_LEN = 700

/** Скелетон из трёх строк на время первой загрузки */
function Skeletons() {
  return (
    <div className="space-y-4 px-1 py-2" aria-hidden>
      {[64, 40, 52].map((w, i) => (
        <div key={i} className="flex gap-2.5">
          <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-tg-sep" />
          <div className="flex-1 space-y-1.5 pt-0.5">
            <div className="h-3 w-24 animate-pulse rounded bg-tg-sep" />
            <div className="h-3.5 animate-pulse rounded bg-tg-sep" style={{ width: `${w}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}

export function CommentsSheet() {
  const t = useT()
  const post = useApp((s) => s.commentsPost)
  const closeComments = useApp((s) => s.closeComments)
  const patchCommentsPost = useApp((s) => s.patchCommentsPost)
  const user = useApp((s) => s.user)
  const openAuthGate = useApp((s) => s.openAuthGate)

  const [items, setItems] = useState<CommentDTO[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const open = !!post

  /* ---------- Загрузка ---------- */

  const load = useCallback(async (postId: string, c?: string) => {
    const first = !c
    if (first) setLoading(true)
    else setLoadingMore(true)
    try {
      const r = await api<{ items: CommentDTO[]; nextCursor: string | null }>(
        `/api/comments?postId=${encodeURIComponent(postId)}${c ? `&cursor=${encodeURIComponent(c)}` : ''}`,
      )
      setItems((prev) => (first ? r.items : [...prev, ...r.items]))
      setCursor(r.nextCursor)
      setError(null)
    } catch {
      if (first) setError(t('comments.error'))
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [t])

  // Открытие/смена поста — перезагрузка списка
  useEffect(() => {
    if (!post) return
    setItems([])
    setCursor(null)
    setError(null)
    setDraft('')
    void load(post.id)
  }, [post?.id, load])

  /* ---------- Отправка ---------- */

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
    }
    setItems((prev) => [...prev, tmp])
    setDraft('')
    setSending(true)
    haptic('light')
    // Автогроу textarea вернётся к одной строке за счёт пустого значения
    if (inputRef.current) inputRef.current.style.height = 'auto'

    try {
      const r = await api<{ comment: CommentDTO; commentsCount: number }>('/api/comments', {
        method: 'POST',
        body: JSON.stringify({ postId: post.id, text }),
      })
      setItems((prev) => prev.map((c) => (c.id === tmp.id ? r.comment : c)))
      patchCommentsPost(post.id, r.commentsCount)
      emitPostUpdated({ postId: post.id, commentsCount: r.commentsCount })
    } catch (e) {
      setItems((prev) => prev.filter((c) => c.id !== tmp.id))
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
    setItems((prev) => prev.filter((x) => x.id !== c.id))
    try {
      const r = await api<{ ok: boolean; commentsCount: number }>(`/api/comments/${c.id}`, { method: 'DELETE' })
      if (post) {
        patchCommentsPost(post.id, r.commentsCount)
        emitPostUpdated({ postId: post.id, commentsCount: r.commentsCount })
      }
      toast.success(t('comments.deleted'))
    } catch {
      setItems((prev) => (prev.some((x) => x.id === c.id) ? prev : [...prev, c].sort((a, b) => a.createdAt.localeCompare(b.createdAt))))
      toast.error(t('comments.error'))
    }
  }

  /* ---------- Ctrl/Cmd+Enter и Enter (ПК) отправляют ---------- */

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void doSend()
    }
  }

  const count = post?.commentsCount ?? 0

  return (
    <BottomSheet
      open={open}
      onClose={closeComments}
      title={t('comments.title')}
      subtitle={count > 0 ? `${count} ${pluralRu(count, 'комментарий', 'комментария', 'комментариев')}` : undefined}
      zClass="z-[80]"
      wide
    >
      {post && (
        <div className="flex flex-col">
          {/* Старые комментарии — кнопка «показать ещё» сверху списка */}
          {cursor && !loading && (
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
                  onClick={() => void load(post.id)}
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
                      layout="position"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: c.id.startsWith('tmp_') ? 0.55 : 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.96 }}
                      transition={{ type: 'spring', damping: 30, stiffness: 380 }}
                      className="flex gap-2.5"
                    >
                      <Avatar name={c.author.name} src={c.author.avatarUrl} size={36} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[13.5px] font-semibold text-tg-text">{c.author.name}</span>
                          <time dateTime={c.createdAt} className="shrink-0 text-[11.5px] text-tg-hint">
                            {timeAgo(c.createdAt)}
                          </time>
                          {c.own && !c.id.startsWith('tmp_') && (
                            <button
                              type="button"
                              onClick={() => void doDelete(c)}
                              aria-label={t('comments.delete')}
                              className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-tg-hint/70 transition hover:bg-red-50 hover:text-red-600 active:scale-90 dark:hover:bg-red-500/10"
                            >
                              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
                            </button>
                          )}
                        </div>
                        <p className="mt-0.5 whitespace-pre-wrap break-words text-[14.5px] leading-snug text-tg-text2">
                          {c.text}
                        </p>
                      </div>
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
              <div className="flex items-end gap-2">
                <div className="relative flex-1">
                  <textarea
                    ref={inputRef}
                    value={draft}
                    onChange={(e) => {
                      setDraft(e.target.value)
                      const el = e.target
                      el.style.height = 'auto'
                      el.style.height = `${Math.min(el.scrollHeight, 120)}px`
                    }}
                    onKeyDown={onInputKeyDown}
                    rows={1}
                    maxLength={MAX_LEN + 50}
                    placeholder={t('comments.placeholder')}
                    aria-label={t('comments.placeholder')}
                    className="max-h-[120px] w-full resize-none rounded-2xl bg-tg-surface py-2.5 pl-3.5 pr-12 text-[14.5px] leading-snug text-tg-text placeholder:text-tg-hint focus:outline-none"
                  />
                  {draft.length > MAX_LEN - 100 && (
                    <span
                      className={cn(
                        'absolute bottom-2.5 right-3 text-[11px] tabular-nums',
                        draft.length > MAX_LEN ? 'text-red-500' : 'text-tg-hint',
                      )}
                    >
                      {MAX_LEN - draft.length}
                    </span>
                  )}
                </div>
                <motion.button
                  type="button"
                  data-noswipe
                  whileTap={{ scale: 0.88 }}
                  onClick={() => void doSend()}
                  disabled={!draft.trim() || sending || draft.length > MAX_LEN}
                  aria-label={t('comments.send')}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-tg-link text-white transition disabled:opacity-40"
                >
                  {sending ? <Loader2 className="h-4.5 w-4.5 animate-spin" aria-hidden /> : <ArrowUp className="h-5 w-5" strokeWidth={2.4} />}
                </motion.button>
              </div>
            )}
          </div>
        </div>
      )}
    </BottomSheet>
  )
}
