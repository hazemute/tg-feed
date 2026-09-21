'use client'

import { useState } from 'react'
import { Camera, Link2, Loader2, Send } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { copyText } from '@/lib/clipboard'
import { useApp } from '@/lib/store'
import { useT } from '@/lib/i18n'
import { haptic, sharePost, sharePostToStory } from '@/lib/tg'
import { stripMarkdown } from '@/lib/markdown'
import { Avatar } from '@/components/tg/Avatar'
import { BottomSheet } from '@/components/tg/BottomSheet'
import type { PostDTO } from '@/lib/types'

/**
 * Глобальный шит «Поделиться» (запрос владельца: «кнопку истории надо в какое
 * то другое место убрать, так как она не часто будет использоваться»).
 *
 * Раньше «В историю» и «Telegram» висели отдельными кнопками в панели действий
 * поста — на узких экранах ряд превращался в бардак из подписей в две строки.
 * Теперь один тап по «Поделиться» открывает аккуратное меню из трёх действий:
 * Telegram-репост, Stories (красивая картинка + виджет подписки) и копирование
 * ссылки. Кнопка историй — внутри меню, поэтому не занимает место в основном
 * ряду, но остаётся доступной в два тапа.
 */
export function ShareSheet() {
  // Пост живёт в сторе отдельно от флага «открыт»: при закрытии он не сбрасывается,
  // поэтому AnimatePresence доигрывает анимацию выхода на полном контенте
  const post = useApp((s) => s.shareSheetPost)
  const open = useApp((s) => s.shareSheetOpen)
  const close = useApp((s) => s.closeShareSheet)
  const t = useT()
  const [busy, setBusy] = useState<'tg' | 'story' | null>(null)

  const onTelegram = () => {
    if (!post) return
    haptic('light')
    setBusy('tg')
    void sharePost(post.link, post.channel.title, post.id)
    setBusy(null)
    close()
  }

  const onStory = () => {
    if (!post) return
    haptic('light')
    setBusy('story')
    void sharePostToStory(post.id, post.channel.title).finally(() => setBusy(null))
    // шит закрываем чуть позже: нативный редактор сторис открывается поверх
    window.setTimeout(() => close(), 450)
  }

  const onCopy = async () => {
    if (!post) return
    haptic('light')
    const link = post.link || 'https://t.me/tgswipe_bot'
    // copyText: Clipboard API + фолбэк execCommand (в Telegram Web iframe
    // clipboard-write часто запрещён политикой — раньше был ложный «не удалось»)
    if (await copyText(link)) toast.success(t('post.linkCopied'))
    else toast.error(t('post.copyFail'))
    close()
  }

  if (!post) return null

  return (
    <BottomSheet
      open={open}
      onClose={close}
      title={t('post.shareSheet')}
      subtitle={t('post.shareSheetSub')}
      zClass="z-[80]"
    >
      {/* Мини-превью поста: контекст — что именно делимся */}
      <div className="mb-3 flex items-center gap-3 rounded-2xl bg-tg-surface/70 p-3">
        <Avatar
          name={post.channel.title}
          color={post.channel.avatarColor}
          src={post.channel.avatarUrl}
          size={40}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14.5px] font-semibold text-tg-text">{post.channel.title}</div>
          {post.text && (
            <div className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-tg-hint">
              {stripMarkdown(post.text)}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        {/* Telegram: нативный репост ссылки */}
        <ShareRow
          onClick={onTelegram}
          icon={
            busy === 'tg' ? (
              <Loader2 className="h-[22px] w-[22px] animate-spin" />
            ) : (
              <Send className="h-[22px] w-[22px]" />
            )
          }
          iconClass="bg-tg-link/12 text-tg-link"
          title={t('post.shareTg')}
          hint={t('post.shareTgHint')}
        />

        {/* Stories: красивая картинка поста + виджет подписки (в два тапа) */}
        <ShareRow
          onClick={onStory}
          icon={
            busy === 'story' ? (
              <Loader2 className="h-[22px] w-[22px] animate-spin" />
            ) : (
              <>
                <Camera className="h-[20px] w-[20px]" strokeWidth={2} />
                <span
                  aria-hidden
                  className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-tg-star"
                />
              </>
            )
          }
          iconClass="relative bg-tg-star/15 text-tg-star"
          title={t('post.shareStory')}
          hint={t('post.shareStoryHint')}
        />

        {/* Копировать ссылку */}
        <ShareRow
          onClick={() => void onCopy()}
          icon={<Link2 className="h-[22px] w-[22px]" />}
          iconClass="bg-tg-surface text-tg-text2"
          title={t('post.shareCopy')}
          hint={t('post.shareCopyHint')}
        />
      </div>
    </BottomSheet>
  )
}

/** Строка-действие шита: иконка в цветном квадрате + подпись + подсказка */
function ShareRow({
  icon,
  iconClass,
  title,
  hint,
  onClick,
}: {
  icon: React.ReactNode
  iconClass: string
  title: string
  hint: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3.5 rounded-2xl p-3 text-left transition active:bg-tg-surface"
    >
      <span
        className={cn(
          'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl',
          iconClass,
        )}
        aria-hidden
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15.5px] font-semibold text-tg-text">{title}</span>
        <span className="mt-0.5 block truncate text-[13px] text-tg-hint">{hint}</span>
      </span>
    </button>
  )
}
