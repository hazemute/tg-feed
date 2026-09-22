'use client'

import { useEffect, useRef, useState } from 'react'
import { BottomSheet } from '@/components/tg/BottomSheet'
import { Loader2 } from 'lucide-react'

/**
 * Виджет эквайринга ЮKassa — платёжная форма ПРЯМО В ПРИЛОЖЕНИИ.
 *
 * Требование СБ ЮKassa: «оплата должна происходить непосредственно на вашем
 * сайте, без переадресаций на сторонние ресурсы». Виджет рисует форму в
 * изолированном iframe на нашей странице — пользователь вводит карту, не
 * покидая Tg Swipe.
 *
 * Сервер (POST /api/tiers | POST /api/payments) отдаёт confirmation_token
 * (confirmation: 'embedded'); здесь подгружается официальный скрипт
 * yookassa.ru/checkout-widget/v2/checkout-widget.js и монтируется виджет.
 * После успешной оплаты вызывается onSuccess (данные о деньгах приходят
 * вебхуком — UI лишь обновляет статус).
 */

/* Минимальная типизация глобального объекта виджета */
type CheckoutWidgetCtor = {
  new (opts: {
    confirmation_token: string
    return_url?: string
    error_callback?: (error: Error) => void
  }): { render: (el: HTMLElement | string) => void; destroy: () => void }
}

declare global {
  interface Window {
    YooMoneyCheckoutWidget?: CheckoutWidgetCtor
  }
}

const WIDGET_SRC = 'https://yookassa.ru/checkout-widget/v2/checkout-widget.js'

let scriptPromise: Promise<void> | null = null

function loadCheckoutScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no_window'))
  if (window.YooMoneyCheckoutWidget) return Promise.resolve()
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = WIDGET_SRC
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => {
      scriptPromise = null
      reject(new Error('widget_script_failed'))
    }
    document.head.appendChild(s)
  })
  return scriptPromise
}

export function YooKassaWidget({
  open,
  token,
  title,
  onClose,
  onSuccess,
}: {
  open: boolean
  /** confirmation_token из POST /api/tiers | /api/payments */
  token: string | null
  title: string
  onClose: () => void
  onSuccess?: () => void
}) {
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={title}
      subtitle="Оплата банковской картой на сайте"
      // v5.82: платёжная форма всегда САМАЯ верхняя (z-[97]) — виджет открывается
      // из шторок/страниц выше уровнем (кошелёк z-[80], пополнение z-[96]);
      // дефолт z-[60] прятал форму под ними — карта казалась нерабочей
      zClass="z-[97]"
    >
      {/* key=token: новый token → чистый монокол-цикл без setState-в-эффект */}
      {open && token ? (
        <WidgetBody token={token} onClose={onClose} onSuccess={onSuccess} />
      ) : (
        <p className="px-1 text-[12px] leading-snug text-tg-hint">
          Платёжная форма предоставляется ЮKassa и открывается прямо здесь, без перехода на другие
          сайты. Данные карты защищены по стандарту PCI DSS.
        </p>
      )}
    </BottomSheet>
  )
}

/** Тело виджета: монтируется только при наличии token (см. key-ремоунт выше) */
function WidgetBody({
  token,
  onClose,
  onSuccess,
}: {
  token: string
  onClose: () => void
  onSuccess?: () => void
}) {
  const holder = useRef<HTMLDivElement | null>(null)
  const widget = useRef<{ destroy: () => void } | null>(null)
  const [phase, setPhase] = useState<'loading' | 'form' | 'error'>('loading')

  useEffect(() => {
    let alive = true

    loadCheckoutScript()
      .then(() => {
        if (!alive || !holder.current || !window.YooMoneyCheckoutWidget) {
          if (alive) setPhase('error')
          return
        }
        widget.current?.destroy()
        const w = new window.YooMoneyCheckoutWidget({
          confirmation_token: token,
          return_url: `${window.location.origin}/`,
          error_callback: () => {
            if (alive) setPhase('error')
          },
        })
        widget.current = w
        w.render(holder.current)
        // Внутри iframe виджет сам покажет экран успеха; точный статус
        // приходит вебхуком. Даём пользователю кнопку «Готово».
        setPhase('form')
      })
      .catch(() => alive && setPhase('error'))

    return () => {
      alive = false
      try {
        widget.current?.destroy()
      } catch {
        /* повторный destroy безопасен */
      }
      widget.current = null
    }
  }, [token])

  return (
    <div className="space-y-3">
      {phase === 'loading' && (
        <div className="flex items-center justify-center gap-2 rounded-2xl bg-tg-surface/70 p-8 text-[14px] text-tg-hint">
          <Loader2 className="h-5 w-5 animate-spin" />
          Загружаем защищённую форму ЮKassa…
        </div>
      )}
      {phase === 'error' && (
        <div className="rounded-2xl bg-tg-surface/70 p-5 text-center text-[14px] leading-relaxed text-tg-hint">
          Не удалось загрузить платёжную форму.
          <br />
          Проверьте соединение и попробуйте ещё раз.
        </div>
      )}
      {/* Контейнер виджета: ЮKassa рендерит iframe на всю ширину шторки */}
      <div
        ref={holder}
        className={phase === 'form' ? 'min-h-[420px] overflow-hidden rounded-2xl' : 'hidden'}
      />
      <p className="px-1 text-[12px] leading-snug text-tg-hint">
        Платёжная форма предоставляется ЮKassa и открывается прямо здесь, без перехода на другие
        сайты. Данные карты защищены по стандарту PCI DSS.
      </p>
      <button
        type="button"
        onClick={() => {
          if (phase === 'form') onSuccess?.()
          onClose()
        }}
        className="h-11 w-full rounded-2xl bg-tg-surface text-[15px] font-semibold text-tg-text active:opacity-70"
      >
        {phase === 'form' ? 'Готово' : 'Закрыть'}
      </button>
    </div>
  )
}
