'use client'

/**
 * v5.89 — error boundary ТОЛЬКО для /admin.
 *
 * История бага: если при гидрации AdminPage падал рендер, React размонтировал
 * дерево, а boot-шторка (z-index 2147483000, гасится из effect'ов) оставалась
 * висеть НАВЕЧНО — пользователь видел вечный сплэш вместо ошибки. Этот
 * boundary ловит исключения рендера вкладки/страницы, ГАСИТ шторку и показывает
 * понятный экран с перезагрузкой.
 */

import { useEffect } from 'react'

import { Button } from '@/components/ui/button'
import { hideBootShell } from '@/lib/boot-shell'

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Экран ошибки уже отрисован — шторка загрузки больше не нужна
    hideBootShell()
    // В консоль — для диагностики по скриншоту/логам
    console.error('[admin] render error:', error)
  }, [error])

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-50 px-4 text-center">
      <img src="/logo.svg" alt="" className="h-12 w-12 opacity-80" aria-hidden />
      <div>
        <h1 className="text-base font-semibold text-slate-900">Панель не загрузилась</h1>
        <p className="mt-1 max-w-md text-sm text-slate-500">
          Произошла ошибка при отрисовке админ-панели. Обычно помогает перезагрузка страницы.
        </p>
        {error?.digest && (
          <p className="mt-2 font-mono text-[11px] text-slate-400">digest: {error.digest}</p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button onClick={reset}>Попробовать снова</Button>
        <Button
          variant="outline"
          onClick={() => {
            try {
              sessionStorage.removeItem('tgfeed_admin_key')
            } catch {
              /* приватный режим */
            }
            window.location.href = '/'
          }}
        >
          На главную
        </Button>
      </div>
    </div>
  )
}
