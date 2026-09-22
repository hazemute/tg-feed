'use client'

import { useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronLeft, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { useBackButton } from '@/lib/tg'
import { isInTelegram } from '@/lib/platform'
import { Portal } from '@/components/ui/Portal'

/**
 * Лаконичный bottom sheet в стиле Telegram (светлый, без неона).
 *
 * АДАПТИВНОСТЬ: на телефоне (и в Mini App) — привычная шторка снизу;
 * на больших экранах (lg+) — центрированный модальный диалог со скруглением
 * и Esc. Блокировка скролла фона — на всех платформах, Esc — вне Telegram.
 *
 * VARIANT «full» (v5.69): полноэкранная СТРАНИЦА вместо полувысотной шторки —
 * для длинного контента (Настройки, публичный профиль), чей низ на мобиле
 * недолистывался. Устройство:
 *  - fixed-панель на весь экран (на lg+ — центрированная «страница» с фоном вокруг);
 *  - ЛИПКАЯ шапка (вне зоны прокрутки): кнопка назад + заголовок либо кастомный
 *    контент через `header` (аватар/имя в профиле);
 *  - СВОЙ вертикальный скролл: flex-1 min-h-0 overflow-y-auto overscroll-contain
 *    + -webkit-overflow-scrolling: touch — работает на тач-устройствах и при
 *    открытой клавиатуре (контент не обрезается на низких экранах);
 *  - нижний safe-area отступ у контента, верхний — у шапки;
 *  - вне Telegram кнопка «назад» браузера/жест закрывает страницу (pushState),
 *    в миниаппе — нативная BackButton (useBackButton), история не засоряется.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  subtitle,
  children,
  /** Ширина панели на lg+ (по умолчанию 560px) */
  wide,
  /** z-класс контейнера (по умолчанию z-[60]; поверх оверлея поста — z-[80]) */
  zClass = 'z-[60]',
  /** sheet — нижняя шторка (по умолчанию); full — полноэкранная страница со своей прокруткой */
  variant = 'sheet',
  /** full: своя шапка между кнопкой «назад» и правым краем (аватар/имя и т.п.) */
  header,
  /**
   * full: ПАНЕЛЬ ИНСТРУМЕНТОВ между шапкой и скроллом (чипсы-табы и т.п.).
   * v5.89: рендерится ВНЕ зоны прокрутки — раньше табы держали position:sticky
   * внутри скролл-контейнера, и на Android WebView (backdrop-blur + sticky в
   * композитном скролле) контент «призрачно» проступал над/под липкой панелью,
   * разрывая подиум. Панель вне скролла — перекрытий не бывает в принципе.
   */
  toolbar,
  /** full: классы области прокрутки (паддинги контента) */
  contentClassName,
}: {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string
  children: ReactNode
  wide?: boolean
  zClass?: string
  variant?: 'sheet' | 'full'
  header?: ReactNode
  toolbar?: ReactNode
  contentClassName?: string
}) {
  const isFull = variant === 'full'

  // Нативная кнопка «назад» Telegram закрывает шит
  useBackButton(open, onClose)

  // Блокируем скролл фона, пока шит открыт (иначе ПК-колёсико листает ленту под модалкой)
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  // Esc на сайте закрывает верхнюю панель (в Telegram закрытие нативной кнопкой)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Свежий onClose без пересоздания подписок (onClose часто инлайн-стрелка)
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  // full + браузер (вне Telegram): «назад»/жест закрывает страницу, а не уходит с сайта.
  // В миниаппе историю не трогаем — там работает нативная BackButton (useBackButton).
  useEffect(() => {
    if (!open || !isFull) return
    // ВАЖНО: проверяем РЕАЛЬНЫЙ Telegram (isInTelegram), а не наличие SDK —
    // telegram-web-app.js грузится и на сайте, где WebApp существует (platform
    // 'unknown'), но BackButton не работает. Внутри миниаппа историю не трогаем —
    // там нативная BackButton (useBackButton); на сайте — pushState-интеграция.
    if (isInTelegram()) return
    try {
      if (window.history.state?.tgSheetFull) {
        // Наверху уже лежит наша запись (перезагрузка страницы с открытым шитом
        // или повторный запуск эффекта) — переиспользуем её, а не плодим дубли:
        // иначе один «назад» закрыл бы страницу, а второй увёл бы с сайта.
        window.history.replaceState({ tgSheetFull: true }, '')
      } else {
        window.history.pushState({ tgSheetFull: true }, '')
      }
    } catch {
      return // Safari в приватном режиме и т.п. — живём без истории
    }
    const onPop = () => onCloseRef.current()
    window.addEventListener('popstate', onPop)
    return () => {
      // Снимаем слушатель ДО history.back(), чтобы попап от нашего же отката
      // не закрыл повторно уже закрываемую страницу
      window.removeEventListener('popstate', onPop)
      try {
        if (window.history.state?.tgSheetFull) window.history.back()
      } catch {
        // noop
      }
    }
  }, [open, isFull])

  // v5.74: ПОРТАЛ в body — шиты открываются из табов (внутри motion.main,
  // чей will-change создаёт stacking context и прятал их под навбаром z-40)
  return (
    <Portal>
    <AnimatePresence>
      {open && (
        <motion.div
          className={cn(
            'fixed inset-0 flex',
            isFull ? 'justify-center' : 'flex-col justify-end lg:justify-center lg:px-6',
            zClass,
          )}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          {/* full: фон виден только на lg+ (на мобиле страницу закрывает панель целиком) */}
          <div
            className={cn('absolute inset-0 bg-black/40 backdrop-blur-sm', isFull && 'hidden lg:block')}
            onClick={onClose}
            aria-hidden
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 320 }}
            onClick={(e) => e.stopPropagation()}
            className={
              isFull
                ? cn(
                    // Полноэкранная страница: колонка «липкая шапка + свой скролл».
                    // overflow-hidden ТОЛЬКО на панели — скролл-контейнер внутри имеет
                    // свой overflow-y-auto, тач-прокрутка не перекрывается.
                    'relative mx-auto flex h-[100dvh] w-full max-w-[560px] flex-col overflow-hidden bg-tg-bg text-tg-text shadow-[0_0_60px_rgba(0,0,0,0.35)] lg:h-[calc(100dvh-3rem)] lg:rounded-3xl',
                    wide ? 'lg:max-w-[760px]' : 'lg:max-w-[640px]',
                  )
                : cn(
                    'relative mx-auto max-h-[92dvh] w-full overflow-y-auto rounded-t-3xl bg-tg-bg px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-8px_40px_rgba(0,0,0,0.18)] lg:max-h-[86vh] lg:rounded-3xl lg:pb-6 lg:pt-5 lg:shadow-[0_24px_80px_rgba(0,0,0,0.28)]',
                    wide ? 'max-w-[520px] lg:max-w-[760px]' : 'max-w-[520px] lg:max-w-[560px]',
                  )
            }
          >
            {isFull ? (
              <>
                {/* Липкая шапка: вне скролл-области → всегда видна. Safe-area сверху. */}
                <div className="flex shrink-0 items-center gap-2 border-b border-tg-sep bg-tg-bg px-3 pb-2.5 pt-[max(0.625rem,env(safe-area-inset-top))]">
                  <button
                    type="button"
                    onClick={onClose}
                    aria-label="Назад"
                    className="press flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-tg-surface text-tg-hint active:scale-90"
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </button>
                  {header ?? (
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[17px] font-bold leading-tight text-tg-text">{title}</div>
                      {subtitle && (
                        <div className="mt-0.5 truncate text-[12.5px] leading-tight text-tg-hint">{subtitle}</div>
                      )}
                    </div>
                  )}
                  {/* Правый слот-распорка: заголовок центрируется между кнопками */}
                  {header ? null : <div className="h-9 w-9 shrink-0" aria-hidden />}
                </div>
                {/* v5.89: панель инструментов ВНЕ скролла — табы всегда видны и
                    никогда не перекрываются контентом (баг верхней менюшки) */}
                {toolbar}
                {/* Своя вертикальная прокрутка на весь контент: тач, клавиатура, низкие экраны */}
                <div
                  className={cn(
                    'min-h-0 flex-1 overflow-y-auto overscroll-contain',
                    contentClassName ?? 'px-5 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-4',
                  )}
                  style={{ WebkitOverflowScrolling: 'touch' }}
                >
                  {children}
                </div>
              </>
            ) : (
              <>
                <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-tg-sep lg:hidden" aria-hidden />
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[19px] font-bold text-tg-text">{title}</div>
                    {subtitle && <div className="mt-0.5 text-[13.5px] text-tg-hint">{subtitle}</div>}
                  </div>
                  <button
                    type="button"
                    onClick={onClose}
                    aria-label="Закрыть"
                    className="press flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-tg-surface text-tg-hint active:scale-90"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                {children}
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
    </Portal>
  )
}
