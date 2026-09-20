'use client'

import { useEffect } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'

/**
 * Error boundary уровня сегмента (v5.57): любой рантайм-краш в RSC/клиенте
 * больше не показывает голый экран Next — стильный экран с повтором.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  // digest — в консоль для диагностики (прод: имена ошибок не показываем)
  useEffect(() => {
    console.error('[app-error]', error.digest ?? error.message)
  }, [error])

  return (
    <main
      className="flex min-h-dvh flex-col items-center justify-center bg-tg-bg px-8 text-center"
      role="alert"
    >
      <div
        className="flex size-24 items-center justify-center rounded-full bg-amber-500/10"
        aria-hidden
      >
        <AlertTriangle className="size-12 text-amber-500" strokeWidth={1.6} />
      </div>
      <h1 className="mt-6 text-[22px] font-bold tracking-tight text-tg-text">
        Что-то пошло не так
      </h1>
      <p className="mt-2 max-w-[320px] text-[14.5px] leading-relaxed text-tg-hint">
        Произошла непредвиденная ошибка. Мы уже знаем о проблеме — попробуйте
        обновить экран.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-8 flex min-h-[44px] items-center gap-2 rounded-full bg-tg-link px-6 text-[15px] font-semibold text-white shadow-sm transition-transform active:scale-95"
      >
        <RotateCcw className="size-4" aria-hidden />
        Попробовать снова
      </button>
      {error.digest ? (
        <p className="mt-6 text-[11.5px] tabular-nums text-tg-hint opacity-60">
          Код ошибки: {error.digest}
        </p>
      ) : null}
    </main>
  )
}
